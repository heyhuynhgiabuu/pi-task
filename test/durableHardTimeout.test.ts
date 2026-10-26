import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

import { readTaskSessionHistory, upsertTaskSessionHistory } from "../src/conversation.js";
import { executeDurableTask, resumeDurableAfterRestart } from "../src/lifecycle/durable-execution.js";
import { DeliveryGuard } from "../src/panel/delivery.js";
import {
  abortDurableTask,
  DurableTaskCancelledError,
  openDurableHarness,
  runDurableTask,
  type DurableTaskRunInput,
} from "../src/subagent/durable.js";

// About 50 ms; PI_TASK_HARD_TIMEOUT_MINUTES accepts fractional minutes.
const SHORT_LIMIT = "0.00083";
// 0.005 minutes = 300 ms, long enough to tell a fresh ceiling from an immediate abort.
const RECOVERY_LIMIT = "0.005";
const RECOVERY_LIMIT_MS = 300;

async function withHardTimeout<T>(minutes: string | undefined, run: () => Promise<T>): Promise<T> {
  const saved = process.env.PI_TASK_HARD_TIMEOUT_MINUTES;
  if (minutes === undefined) delete process.env.PI_TASK_HARD_TIMEOUT_MINUTES;
  else process.env.PI_TASK_HARD_TIMEOUT_MINUTES = minutes;
  try {
    return await run();
  } finally {
    if (saved === undefined) delete process.env.PI_TASK_HARD_TIMEOUT_MINUTES;
    else process.env.PI_TASK_HARD_TIMEOUT_MINUTES = saved;
  }
}

const usage = { models: {}, tools: {}, totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costTotal: 0 } };

// A child that never answers: it settles only when the runner's signal aborts,
// the way runDurableTask does for a cancel.
const hangsUntilAborted = (input: DurableTaskRunInput) =>
  new Promise<never>((_, reject) => {
    input.signal?.addEventListener("abort", () => reject(new DurableTaskCancelledError()), { once: true });
  });

function executeOptions(root: string, overrides: Record<string, unknown>) {
  const sent: { content?: string; details?: Record<string, unknown> }[] = [];
  const options = {
    id: "t-hard-timeout",
    agent: { name: "general", description: "General task", body: "", source: "project", path: "test-agent.md" },
    description: "hard timeout",
    sessionName: "task-t-hard-timeout",
    prompt: "Work.",
    cwd: root,
    toolCallId: "call-hard-timeout",
    ctx: { model: { provider: "faux", id: "vendor/model" }, modelRegistry: {} },
    pi: { sendMessage: (message: (typeof sent)[number]) => { sent.push(message); } },
    piDir: join(root, ".pi"),
    artifactsDir: join(root, ".pi", "artifacts"),
    isBackground: false,
    backgroundTasks: new Map(),
    foregroundTasks: new Map(),
    deliveryGuard: new DeliveryGuard(),
    taskWidget: { openTaskView() {}, closeTaskView() {}, noteTaskFinished() {}, setLiveTranscript() {} },
    clearTaskWidgetIfIdle: () => {},
    ensureTaskWidget: () => {},
    enqueueDelivery: (delivery: () => void) => delivery(),
    ...overrides,
  };
  return { sent, options: options as never as Parameters<typeof executeDurableTask>[0] };
}

async function until(condition: () => boolean, ms = 3_000) {
  for (let waited = 0; waited < ms && !condition(); waited += 10) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(condition(), "condition was not met in time");
}

test("a foreground durable run that outlives the hard timeout ends as a timeout, not a failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-timeout-fg-"));
  try {
    const { options } = executeOptions(root, { runTask: hangsUntilAborted });
    const result = await withHardTimeout(SHORT_LIMIT, () => executeDurableTask(options));
    assert.equal(result.details.phase, "timeout");
    assert.equal("isError" in result, false, "a timeout is not an error result, like the SDK backend");
    assert.match(String(result.content[0]?.text), /hard timeout of \d+(\.\d+)?m?s /);
    assert.equal(readTaskSessionHistory(join(root, ".pi")).find((e) => e.id === "t-hard-timeout")?.status, "timeout");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a user cancel of a foreground durable run is still a cancellation while the ceiling is armed", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-timeout-cancel-"));
  try {
    const parent = new AbortController();
    const { options } = executeOptions(root, { runTask: hangsUntilAborted, signal: parent.signal });
    const running = withHardTimeout("30", () => executeDurableTask(options));
    setTimeout(() => parent.abort(), 30);
    const result = await running;
    assert.equal(result.details.phase, "cancelled");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a cancel already in flight when the ceiling fires stays a cancellation", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-timeout-race-"));
  try {
    const parent = new AbortController();
    // The child takes longer to settle its cancel than the ceiling allows.
    const slowToCancel = (input: DurableTaskRunInput) =>
      new Promise<never>((_, reject) => {
        input.signal?.addEventListener("abort", () => {
          setTimeout(() => reject(new DurableTaskCancelledError()), 150);
        }, { once: true });
      });
    const { options } = executeOptions(root, { runTask: slowToCancel, signal: parent.signal });
    const running = withHardTimeout(SHORT_LIMIT, () => executeDurableTask(options));
    setTimeout(() => parent.abort(), 10);
    const result = await running;
    assert.equal(result.details.phase, "cancelled");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a durable run that finishes inside the ceiling completes", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-timeout-ok-"));
  try {
    const { options } = executeOptions(root, {
      runTask: async () => ({ conversationId: "child", answer: "<status>success</status>\n<summary>Done.</summary>", usage }),
    });
    const result = await withHardTimeout("30", () => executeDurableTask(options));
    assert.equal(result.details.phase, "done");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PI_TASK_HARD_TIMEOUT_MINUTES=0 disables the durable ceiling", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-timeout-off-"));
  try {
    const { options } = executeOptions(root, {
      runTask: async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return { conversationId: "child", answer: "<status>success</status>\n<summary>Done.</summary>", usage };
      },
    });
    const result = await withHardTimeout("0", () => executeDurableTask(options));
    assert.equal(result.details.phase, "done");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a background durable run that finishes delivers a done notice with a state line", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-notice-done-"));
  try {
    const { sent, options } = executeOptions(root, {
      isBackground: true,
      runTask: async () => ({ conversationId: "child", answer: "<status>success</status>\n<summary>Done.</summary>", usage }),
    });
    await executeDurableTask(options);
    await until(() => sent.length === 1);
    assert.ok(String(sent[0]?.content).startsWith('<task id="t-hard-timeout" state="done"/>\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a background durable run that outlives the hard timeout is delivered and recorded as a timeout", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-timeout-bg-"));
  try {
    const { sent, options } = executeOptions(root, { isBackground: true, runTask: hangsUntilAborted });
    await withHardTimeout(SHORT_LIMIT, async () => {
      await executeDurableTask(options);
      await until(() => sent.length === 1);
    });
    assert.equal(sent[0]?.details?.phase, "timeout");
    assert.match(String(sent[0]?.content), /timeout/i);
    assert.ok(String(sent[0]?.content).startsWith('<task id="t-hard-timeout" state="timeout"/>\n'));
    await until(() => readTaskSessionHistory(join(root, ".pi")).find((e) => e.id === "t-hard-timeout")?.status === "timeout");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

type AbortTask = typeof abortDurableTask;

// A durable child recovered after a restart whose model is stuck in a long tool
// call, resumed under a ~300 ms ceiling. `abortTask` replaces the abort the
// ceiling issues, so its failure modes can be exercised.
async function recoverUnderCeiling(abortTask?: (real: AbortTask) => AbortTask) {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-timeout-recovered-"));
  const piDir = join(root, ".pi");
  const databasePath = join(piDir, "durable", "tasks.sqlite");
  const taskId = "t-recovered-timeout";
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 30" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("The aborted tool must not continue."),
  ]);
  const sent: { content?: string; details?: Record<string, unknown> }[] = [];
  let settledStatus: string | undefined;
  let handle: Awaited<ReturnType<typeof openDurableHarness>> | undefined;
  let completion: Promise<unknown> = Promise.resolve();
  try {
    upsertTaskSessionHistory(piDir, {
      id: taskId,
      status: "running",
      background: true,
      backend: "durable",
      agentType: "general",
      description: "Time out recovered durable work",
      sessionName: `task-${taskId}`,
      startedAt: Date.now() - 3_600_000,
      piDir,
      dir: join(piDir, "artifacts"),
      cwd: root,
      ownerSessionId: "sess-timeout",
    });
    handle = await openDurableHarness(piDir, { databasePath, models: () => models });
    let markSubmitted!: () => void;
    const submitted = new Promise<void>((resolve) => { markSubmitted = resolve; });
    completion = runDurableTask({
      piDir,
      databasePath,
      taskId,
      task: "Run a long tool.",
      models: () => models,
      onSubmitted: () => markSubmitted(),
    }).then(() => undefined, (error: unknown) => error);
    await submitted;
    await new Promise((resolve) => setTimeout(resolve, 100));

    const resumedAt = Date.now();
    await withHardTimeout(RECOVERY_LIMIT, () => resumeDurableAfterRestart({
      pi: { sendMessage: (message: (typeof sent)[number]) => { sent.push(message); } } as never,
      piDir,
      sessionId: "sess-timeout",
      databasePath,
      models: () => models,
      ...(abortTask ? { abortTask: abortTask(abortDurableTask) } : {}),
      onTaskSettled: (_id, _history, status) => { settledStatus = status; },
    }));
    await until(() => settledStatus !== undefined, 8_000);
    return {
      sent,
      settledStatus,
      elapsedMs: Date.now() - resumedAt,
      historyStatus: readTaskSessionHistory(piDir).find((entry) => entry.id === taskId)?.status,
    };
  } finally {
    await abortDurableTask(piDir, taskId, { databasePath }).catch(() => null);
    await completion;
    if (handle) await handle.harness.close(handle.context);
    rmSync(root, { recursive: true, force: true });
  }
}

test("a recovered durable run gets a fresh ceiling and is aborted, recorded and delivered as a timeout", async () => {
  const run = await recoverUnderCeiling();
  assert.ok(
    run.elapsedMs >= RECOVERY_LIMIT_MS * 0.8,
    "the ceiling counts from the recovery, not from when the run started",
  );
  assert.equal(run.historyStatus, "timeout", "the hour already spent before the restart does not count");
  assert.equal(run.sent.length, 1);
  assert.equal(run.sent[0]?.details?.phase, "timeout");
  assert.ok(String(run.sent[0]?.content).startsWith('<task id="t-recovered-timeout" state="timeout"/>\n'));
  assert.equal(run.settledStatus, "timeout", "the panel hook sees the timeout, not a cancel");
});

test("an abort that took effect and then threw is still reported as the timeout it was", async () => {
  const run = await recoverUnderCeiling((real) => async (...args) => {
    await real(...args);
    throw new Error("abort failed after it took effect");
  });
  assert.equal(run.sent.length, 1);
  assert.equal(run.sent[0]?.details?.phase, "timeout");
  assert.equal(run.historyStatus, "timeout");
  assert.equal(run.settledStatus, "timeout", "the panel agrees with the notice");
});

test("an abort that failed leaves the run going, so the ceiling is armed again", async () => {
  let calls = 0;
  const run = await recoverUnderCeiling((real) => async (...args) => {
    calls += 1;
    if (calls === 1) throw new Error("abort could not reach the child");
    return real(...args);
  });
  assert.equal(calls, 2, "the second ceiling aborted the run");
  assert.ok(run.elapsedMs >= RECOVERY_LIMIT_MS * 1.6, "two full ceilings passed");
  assert.equal(run.sent.length, 1);
  assert.equal(run.sent[0]?.details?.phase, "timeout");
  assert.equal(run.settledStatus, "timeout");
});
