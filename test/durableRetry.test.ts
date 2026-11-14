/**
 * Task-level retry for the durable backend (`docs/design-durable-retry.md`).
 *
 * A retry is a NEW submission on the SAME child: fresh `requestId` (idempotency
 * key, no resume meaning), fresh abort controller, re-armed per-attempt ceiling.
 * Only a background durable run retries, and only when the settle is a failure
 * or the wall-clock ceiling — never a cancel.
 *
 * Run: npx tsx --test test/durableRetry.test.ts
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readTaskSessionHistory } from "../src/conversation.js";
import { executeDurableTask } from "../src/lifecycle/durable-execution.js";
import { planTaskRetry } from "../src/lifecycle/retry.js";
import { formatMs } from "../src/helpers.js";
import { DeliveryGuard } from "../src/panel/delivery.js";
import {
  DurableTaskCancelledError,
  runDurableTask,
} from "../src/subagent/durable.js";
import type { BackgroundTask } from "../src/types.js";

type RunInput = Parameters<typeof runDurableTask>[0];

const usage = {
  models: {},
  tools: {},
  totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costTotal: 0 },
};

const DONE_ANSWER = "<status>success</status>\n<summary>Done.</summary>";

/** A child that never answers: it settles only when the runner's signal aborts. */
const hangsUntilAborted = (input: RunInput) =>
  new Promise<never>((_, reject) => {
    input.signal?.addEventListener(
      "abort",
      () => reject(new DurableTaskCancelledError()),
      { once: true },
    );
  });

interface Sent {
  content?: string;
  details?: Record<string, unknown>;
}

interface Harness {
  sent: Sent[];
  warnings: string[];
  options: Parameters<typeof executeDurableTask>[0];
  backgroundTasks: Map<string, BackgroundTask>;
  /** The `requestId` each attempt submitted with, in order. */
  requestIds: string[];
}

/**
 * A background durable launch with an overridable runner. The runner mirrors
 * what `runDurableTask` does before it settles: it reports its attempt id to
 * `onRequestId` (the history's recovery identity) and then its admission.
 */
function harness(
  root: string,
  overrides: Record<string, unknown> = {},
  run: (input: RunInput, attempt: number) => Promise<{ conversationId: string; answer: string; usage: typeof usage }> = async () => ({
    conversationId: "child",
    answer: DONE_ANSWER,
    usage,
  }),
): Harness {
  const sent: Sent[] = [];
  const warnings: string[] = [];
  const requestIds: string[] = [];
  let calls = 0;
  const backgroundTasks = new Map<string, BackgroundTask>();
  const options = {
    id: "t-durable-retry",
    agent: {
      name: "general",
      description: "General task",
      body: "",
      source: "project",
      path: "test-agent.md",
    },
    description: "durable retry",
    sessionName: "task-t-durable-retry",
    prompt: "Work.",
    cwd: root,
    toolCallId: "call-durable-retry",
    ctx: { model: { provider: "faux", id: "vendor/model" }, modelRegistry: {} },
    pi: { sendMessage: (message: Sent) => { sent.push(message); } },
    piDir: join(root, ".pi"),
    artifactsDir: join(root, ".pi", "artifacts"),
    isBackground: true,
    notifyUser: (text: string) => { warnings.push(text); },
    backgroundTasks,
    foregroundTasks: new Map(),
    deliveryGuard: new DeliveryGuard(),
    taskWidget: {
      openTaskView() {},
      closeTaskView() {},
      noteTaskFinished() {},
      setLiveTranscript() {},
    },
    clearTaskWidgetIfIdle: () => {},
    ensureTaskWidget: () => {},
    enqueueDelivery: (delivery: () => void) => delivery(),
    runTask: (input: RunInput) => {
      const attempt = calls++;
      requestIds.push(input.requestId ?? "");
      input.onRequestId?.(input.requestId ?? "");
      input.onSubmitted?.("child");
      return run(input, attempt);
    },
    ...overrides,
  };
  return {
    sent,
    warnings,
    backgroundTasks,
    requestIds,
    options: options as never as Parameters<typeof executeDurableTask>[0],
  };
}

async function until(condition: () => boolean, ms = 6_000) {
  for (let waited = 0; waited < ms && !condition(); waited += 10) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(condition(), "condition was not met in time");
}

function historyOf(root: string, id = "t-durable-retry") {
  return readTaskSessionHistory(join(root, ".pi")).find((entry) => entry.id === id);
}

async function withRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-retry-"));
  try {
    return await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ─── 1. Pure classification ─────────────────────────────────────────────────

test("the durable ceiling message classifies as a wall-clock timeout retry", () => {
  // The exact wording `timeoutMessage()` builds for an armed per-task ceiling.
  const timeoutMessage =
    `Durable subagent exceeded the hard timeout of ${formatMs(50)} ` +
    "(PI_TASK_HARD_TIMEOUT_MINUTES or the task's own timeout_minutes).";
  const plan = planTaskRetry({
    phase: "timeout",
    content: timeoutMessage,
    maxRetries: 2,
    retryCount: 0,
    canRelaunch: true,
  });
  assert.ok(plan, "a wall-clock timeout with allowance is retried");
  assert.equal(plan.reason, "wall_clock_timeout");
  assert.equal(plan.delayMs, 1_000);
});

test("a harness fault on the durable backend is not retried", () => {
  // What actually settles `failed` with restartLimit: Infinity: a tool crash,
  // composed by the durable bridge. Not provider wording, so not retryable.
  const plan = planTaskRetry({
    phase: "failed",
    content: "durable subagent failed: Tool execution faulted (bash crashed)",
    maxRetries: 3,
    retryCount: 0,
    canRelaunch: true,
  });
  assert.equal(plan, undefined);
});

// ─── 2. Wiring: attempt 0 transient, attempt 1 succeeds ─────────────────────

test("a background durable task that fails transiently is re-submitted and delivers ONE done notice", async () => {
  await withRoot(async (root) => {
    const run = harness(root, { maxRetries: 2 }, async (_input, attempt) => {
      if (attempt === 0) throw new Error("503 Service Unavailable");
      return { conversationId: "child", answer: DONE_ANSWER, usage };
    });
    await executeDurableTask(run.options);
    await until(() => run.sent.length === 1);

    assert.equal(run.requestIds.length, 2, "attempt 0 failed, attempt 1 ran");
    assert.notEqual(
      run.requestIds[1],
      run.requestIds[0],
      "the retry submits under a fresh idempotency key",
    );
    // Exactly one completion notice: the retry is invisible to delivery.
    assert.equal(run.sent.length, 1);
    assert.equal(run.sent[0]?.details?.phase, "done");
    assert.equal(run.sent[0]?.details?.retry_count, 1);
    assert.equal(run.sent[0]?.details?.last_retry_reason, "transient_status");
    assert.ok(
      String(run.sent[0]?.content).startsWith('<task id="t-durable-retry" state="done"/>\n'),
    );

    // The delivery id stays keyed by the ORIGINAL start, so a retry's notice is
    // never delivered as a second task of the same id.
    const originalStartedAt = historyOf(root)?.startedAt;
    assert.ok(originalStartedAt !== undefined);
    assert.equal(
      run.sent[0]?.details?.completion_delivery_id,
      `t-durable-retry\u0000${originalStartedAt}`,
    );

    // Bookkeeping lands on the history entry (durable tasks have no registry row).
    const entry = historyOf(root);
    assert.equal(entry?.status, "done");
    assert.equal(entry?.retryCount, 1);
    assert.equal(entry?.lastRetryReason, "transient_status");
    assert.ok((entry?.nextRetryAt ?? 0) > 0, "the scheduled retry time was persisted");

    // The user is told a retry is happening, in the terminal backend's wording.
    assert.deepEqual(run.warnings, [
      "[pi-task] background task t-durable-retry failed (transient_status); retry 1/2 in 1s.",
    ]);
  });
});

// ─── 3. Timeout → retry under a new request id ──────────────────────────────

test("a background durable task that hits its ceiling retries the same child under a new request id", async () => {
  await withRoot(async (root) => {
    const run = harness(
      root,
      // ~50 ms per-attempt ceiling; every attempt gets the full limit.
      { maxRetries: 1, timeoutMinutes: 0.00083 },
      async (input, attempt) => {
        if (attempt === 0) return hangsUntilAborted(input);
        return { conversationId: "child", answer: DONE_ANSWER, usage };
      },
    );
    await executeDurableTask(run.options);
    await until(() => run.sent.length === 1);

    assert.equal(run.requestIds.length, 2, "the timed-out attempt was re-submitted");
    assert.notEqual(
      run.requestIds[1],
      run.requestIds[0],
      "a rerun under the failed submission's id would be deduped by the harness",
    );
    assert.equal(run.sent.length, 1, "one final notice, not one per attempt");
    assert.equal(run.sent[0]?.details?.phase, "done");
    assert.equal(run.sent[0]?.details?.retry_count, 1);
    assert.equal(run.sent[0]?.details?.last_retry_reason, "wall_clock_timeout");
    assert.deepEqual(run.warnings, [
      "[pi-task] background task t-durable-retry timeout (wall_clock_timeout); retry 1/1 in 1s.",
    ]);
    assert.equal(historyOf(root)?.status, "done");
  });
});

// ─── 4. No-retry invariants ────────────────────────────────────────────────

test("a cancelled durable task never retries, even with allowance left", async () => {
  await withRoot(async (root) => {
    const run = harness(root, { maxRetries: 3 }, async (input) => hangsUntilAborted(input));
    await executeDurableTask(run.options);
    await until(() => run.requestIds.length === 1);
    // What `/task cancel` and the panel stop button do: abort the tracker's
    // latch, which must reach the attempt that is actually running.
    run.backgroundTasks.get("t-durable-retry")?.durableAbortController?.abort();
    await until(() => run.sent.length === 1);

    assert.equal(run.requestIds.length, 1, "a user cancel is never re-run");
    assert.equal(run.sent[0]?.details?.phase, "cancelled");
    assert.equal(run.sent[0]?.details?.retry_count, undefined);
    assert.deepEqual(run.warnings, [], "no retry was scheduled");
    assert.equal(historyOf(root)?.status, "cancelled");
    assert.equal(historyOf(root)?.retryCount, undefined);
  });
});

test("an exhausted retry allowance settles the last attempt as the outcome", async () => {
  await withRoot(async (root) => {
    const run = harness(root, { maxRetries: 1 }, async () => {
      throw new Error("503 Service Unavailable");
    });
    await executeDurableTask(run.options);
    await until(() => run.sent.length === 1);

    assert.equal(run.requestIds.length, 2, "one retry, then the allowance is spent");
    assert.equal(run.sent.length, 1);
    assert.equal(run.sent[0]?.details?.phase, "failed");
    assert.equal(run.sent[0]?.details?.retry_count, 1);
    assert.equal(run.sent[0]?.details?.last_retry_reason, "transient_status");
    assert.equal(historyOf(root)?.status, "failed");
    assert.equal(historyOf(root)?.retryCount, 1);
  });
});

test("a cancel during the retry backoff ends the task instead of resurrecting it", async () => {
  await withRoot(async (root) => {
    const run = harness(root, { maxRetries: 3 }, async () => {
      throw new Error("503 Service Unavailable");
    });
    await executeDurableTask(run.options);
    // Attempt 0 has settled failed and the 1s backoff is running. This is the
    // window the design note calls the highest-risk detail: the abort must land
    // on the retry's own controller, before its submission.
    await until(() => run.warnings.length === 1);
    run.backgroundTasks.get("t-durable-retry")?.durableAbortController?.abort();
    await until(() => run.sent.length === 1);

    assert.equal(run.requestIds.length, 1, "the cancelled retry was never submitted");
    assert.equal(run.sent[0]?.details?.phase, "cancelled");
    assert.equal(historyOf(root)?.status, "cancelled");
  });
});

test("a foreground durable run never retries a transient failure", async () => {
  await withRoot(async (root) => {
    // A foreground caller is waiting on this exact tool result; re-running is
    // the caller's decision, not the lifecycle's.
    const run = harness(root, { isBackground: false, maxRetries: 3 }, async () => {
      throw new Error("503 Service Unavailable");
    });
    const result = await executeDurableTask(run.options);
    assert.equal(run.requestIds.length, 1);
    assert.equal(result.details.phase, "failed");
    assert.equal("retry_count" in result.details, false);
  });
});

// ─── 5. Recovery interaction ───────────────────────────────────────────────

test("a crash mid-retry would recover the retry attempt, in the durable request-id shape", async () => {
  await withRoot(async (root) => {
    // The recovery identity is only load-bearing while an attempt is in
    // flight, so attempt 1 holds until the history has been read.
    let releaseAttempt1!: () => void;
    const attempt1Running = new Promise<void>((resolve) => { releaseAttempt1 = resolve; });
    const run = harness(root, { maxRetries: 1 }, async (_input, attempt) => {
      if (attempt === 0) throw new Error("429 Too Many Requests");
      await attempt1Running;
      return { conversationId: "child", answer: DONE_ANSWER, usage };
    });
    await executeDurableTask(run.options);
    await until(() => run.requestIds.length === 2);

    // What a crash between "retry scheduled" and "child settled" would leave
    // behind: the RETRY attempt's id, not the settled original's.
    const inFlight = historyOf(root);
    assert.equal(inFlight?.status, "running");
    assert.equal(inFlight?.retryCount, 1);
    assert.equal(inFlight?.durableRequestId, run.requestIds[1]);
    // Same shape as the original (`pi-task:<task>:call:<call>`, which is what
    // `taskIdFromRequestId` decodes on a legacy recovery), retry suffix added.
    assert.equal(
      inFlight?.durableRequestId,
      "pi-task:t-durable-retry:call:call-durable-retry-retry-1",
    );

    releaseAttempt1();
    await until(() => run.sent.length === 1);
    assert.equal(run.sent[0]?.details?.phase, "done");
    assert.equal(historyOf(root)?.status, "done");
  });
});
