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

import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";

import { readTaskSessionHistory, upsertTaskSessionHistory } from "../src/conversation.js";
import {
  executeDurableTask,
  resumeDurableAfterRestart,
  retryContinuesContext,
} from "../src/lifecycle/durable-execution.js";
import { planTaskRetry } from "../src/lifecycle/retry.js";
import { formatMs } from "../src/helpers.js";
import { DeliveryGuard } from "../src/panel/delivery.js";
import {
  durableRequestId,
  DurableTaskCancelledError,
  DurableTaskTimeoutError,
  openDurableHarness,
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
  /** Per attempt, whether the runner was asked to submit `{ type: "continue" }`. */
  continueOnly: (boolean | undefined)[];
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
  const continueOnly: (boolean | undefined)[] = [];
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
      registerAutoMirror() {},
      noteTaskFinished() {},
      setLiveTranscript() {},
    },
    clearTaskWidgetIfIdle: () => {},
    ensureTaskWidget: () => {},
    enqueueDelivery: (delivery: () => void) => delivery(),
    runTask: (input: RunInput) => {
      const attempt = calls++;
      requestIds.push(input.requestId ?? "");
      continueOnly.push(input.continueOnly);
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
    continueOnly,
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

// ─── 6. A retry of a run that died owing an answer continues the context ────

test("a ceiling retry continues the child's context instead of resending the prompt", async () => {
  await withRoot(async (root) => {
    const run = harness(
      root,
      { maxRetries: 1, timeoutMinutes: 0.00083 },
      async (input, attempt) => {
        if (attempt === 0) return hangsUntilAborted(input);
        return { conversationId: "child", answer: DONE_ANSWER, usage };
      },
    );
    await executeDurableTask(run.options);
    await until(() => run.sent.length === 1);

    assert.equal(run.continueOnly.length, 2, "both attempts were submitted");
    assert.equal(
      run.continueOnly[0],
      undefined,
      "attempt 0 is the normal prompt submission",
    );
    assert.equal(
      run.continueOnly[1],
      true,
      "the timeout retry continues the context the dead generation owed an answer on",
    );
    assert.notEqual(run.requestIds[1], run.requestIds[0], "under a fresh idempotency key");
    assert.equal(run.sent[0]?.details?.phase, "done");
  });
});

test("a transient provider failure retry also continues the context", async () => {
  await withRoot(async (root) => {
    const run = harness(root, { maxRetries: 1 }, async (_input, attempt) => {
      if (attempt === 0) throw new Error("503 Service Unavailable");
      return { conversationId: "child", answer: DONE_ANSWER, usage };
    });
    await executeDurableTask(run.options);
    await until(() => run.sent.length === 1);
    assert.equal(run.continueOnly[1], true);
  });
});

test("a failure that owes no answer selects the prompt draft, not a continue", () => {
  // The selection rule (`planTaskRetry` never retries these two, so they are
  // asserted here rather than through a settle): a run that ended with nothing
  // owed must resubmit the prompt — a continue would settle `nothing_to_answer`.
  assert.equal(retryContinuesContext(new Error("nothing_to_answer")), false);
  assert.equal(retryContinuesContext(new Error("turn_limit: out of turns")), false);
  // A dead generation always owes its answer, whichever side of the bridge
  // reported it.
  assert.equal(
    retryContinuesContext(new Error("durable subagent failed: model_error: overloaded")),
    true,
  );
  assert.equal(retryContinuesContext(new Error("interrupted: the host stopped")), true);
  assert.equal(
    retryContinuesContext(new DurableTaskTimeoutError("Durable subagent exceeded the hard timeout")),
    true,
  );
});

test("a continue that finds nothing to answer falls back to ONE input resubmission", async () => {
  // The bridge's bounded fallback, against the real durable harness: a
  // `continueOnly` run whose context owes nothing settles
  // `unanswered/nothing_to_answer`, and the prompt is then submitted exactly
  // once under its own idempotency key (a submission's type is fixed by its
  // request id, so the fallback cannot reuse the continue's).
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-continue-fallback-"));
  const piDir = join(root, ".pi");
  const databasePath = join(root, "durable.sqlite");
  const taskId = "t-continue-fallback";
  const requestId = "pi-task:t-continue-fallback:call:call-continue-fallback";
  const retryRequestId = `${requestId}-retry`;
  let handle: Awaited<ReturnType<typeof openDurableHarness>> | undefined;
  try {
    const models = createModels();
    const faux = fauxProvider();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage("The original answer."),
      fauxAssistantMessage("Answered after the prompt came back."),
    ]);
    // A child that already answered: its context owes the model nothing.
    const first = await runDurableTask({
      piDir,
      databasePath,
      taskId,
      task: "Original prompt.",
      requestId,
      models: () => models,
    });
    assert.equal(first.answer, "The original answer.");

    // Record every draft the bridge hands the harness from here on.
    const drafts: { type: string; content?: unknown; requestId?: string }[] = [];
    handle = await openDurableHarness(piDir, { databasePath, models: () => models });
    const originalConversation = handle.harness.conversation.bind(handle.harness);
    handle.harness.conversation = async (id, context) => {
      const conversation = await originalConversation(id, context);
      if (!conversation) return conversation;
      const originalSubmit = conversation.submit.bind(conversation);
      conversation.submit = ((...args: Parameters<typeof conversation.submit>) => {
        const [draft] = args as [{ type: string; content?: unknown; requestId?: string }];
        drafts.push({ type: draft.type, content: draft.content, requestId: draft.requestId });
        return originalSubmit(...(args as Parameters<typeof originalSubmit>));
      }) as typeof conversation.submit;
      return conversation;
    };

    const second = await runDurableTask({
      piDir,
      databasePath,
      taskId,
      task: "Original prompt.",
      requestId: retryRequestId,
      continueOnly: true,
      models: () => models,
    });
    assert.equal(
      second.answer,
      "Answered after the prompt came back.",
      "the prompt fallback produced the answer",
    );
    assert.deepEqual(
      drafts.map((draft) => [draft.type, draft.requestId]),
      [["continue", retryRequestId], ["input", `${retryRequestId}:input`]],
      "one continue, then exactly one prompt fallback under its own id",
    );
    assert.equal(drafts[1]?.content, "Original prompt.");
  } finally {
    if (handle) await handle.harness.close(handle.context);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a continue retry keeps the child's context: the prompt is not delivered twice", async () => {
  // The real bridge, no runTask override. Attempt 0 submits the prompt and is
  // aborted mid-generation (what the wall-clock ceiling does); attempt 1 is the
  // retry the lifecycle now sends as a continue. The model context must hold the
  // original prompt ONCE — that is the point of continuing instead of resending.
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-continue-context-"));
  const piDir = join(root, ".pi");
  const databasePath = join(root, "durable.sqlite");
  const taskId = "t-continue-context";
  const requestId = "pi-task:t-continue-context:call:call-continue-context";
  const task = "UNIQUE_ORIGINAL_PROMPT_TEXT";
  let handle: Awaited<ReturnType<typeof openDurableHarness>> | undefined;
  let conversationId: string | undefined;
  // Hold the first provider response so attempt 0 is genuinely mid-generation
  // when it is aborted, the way the wall-clock ceiling kills a live attempt.
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
  try {
    const models = createModels();
    const faux = fauxProvider();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage("Attempt 1 answered."),
      fauxAssistantMessage("Attempt 2 answered."),
    ]);
    let call = 0;
    const streamSimple = models.streamSimple.bind(models);
    models.streamSimple = (model, context, options) => {
      const stream = streamSimple(model, context, options);
      if (call++ === 0) {
        const result = stream.result.bind(stream);
        stream.result = async () => {
          // Release on the abort too: the held request has no other way out.
          await new Promise<void>((resolve, reject) => {
            firstHeld.then(resolve, reject);
            options.signal?.addEventListener(
              "abort",
              () => reject(new DurableTaskCancelledError()),
              { once: true },
            );
          });
          return result();
        };
      }
      return stream;
    };
    const drafts: { type: string; requestId?: string }[] = [];
    handle = await openDurableHarness(piDir, { databasePath, models: () => models });
    const originalConversation = handle.harness.conversation.bind(handle.harness);
    handle.harness.conversation = async (id, context) => {
      const conversation = await originalConversation(id, context);
      if (!conversation) return conversation;
      const originalSubmit = conversation.submit.bind(conversation);
      conversation.submit = ((...args: Parameters<typeof conversation.submit>) => {
        const [draft] = args as [{ type: string; requestId?: string }];
        drafts.push({ type: draft.type, requestId: draft.requestId });
        return originalSubmit(...(args as Parameters<typeof originalSubmit>));
      }) as typeof conversation.submit;
      return conversation;
    };

    const controller = new AbortController();
    const first = runDurableTask({
      piDir,
      databasePath,
      taskId,
      task,
      requestId,
      models: () => models,
      signal: controller.signal,
      onSubmitted: (id) => { conversationId = id; },
    });
    await until(() => drafts.length === 1);
    controller.abort();
    await assert.rejects(first, DurableTaskCancelledError);
    releaseFirst();

    const second = await runDurableTask({
      piDir,
      databasePath,
      taskId,
      task,
      requestId: `${requestId}-retry-1`,
      continueOnly: true,
      models: () => models,
    });
    assert.equal(second.answer, "Attempt 2 answered.");
    assert.deepEqual(
      drafts.map((draft) => [draft.type, draft.requestId]),
      [["input", requestId], ["continue", `${requestId}-retry-1`]],
      "the retry is a continue under a fresh idempotency key",
    );

    const conversation = await handle.harness.conversation(conversationId as never, handle.context);
    assert.ok(conversation);
    const context = JSON.stringify((await conversation.context(handle.context)).messages);
    const occurrences = context.split(task).length - 1;
    assert.equal(occurrences, 1, "the child was not handed the original prompt a second time");
    assert.match(context, /Attempt 2 answered\./, "the continue's own answer is in the context");
  } finally {
    releaseFirst();
    if (handle) await handle.harness.close(handle.context);
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── 7. Recovery of the crash window carries the retry metadata ─────────────

test("a recovery failure of a row with a retry pending names the interrupted retry and carries its metadata", async () => {
  // The crash window: `recordRetry` wrote `retryCount`/`nextRetryAt`/
  // `lastRetryReason` and Pi exited before the retry attempt settled. Recovery
  // reports the earlier failure — the chain is not resumed across a restart —
  // but the notice must say a retry was interrupted and carry the row's
  // metadata instead of a bare `nothing_to_answer`-style line (TODO item D).
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-retry-recovery-"));
  const piDir = join(root, ".pi");
  const databasePath = join(root, "durable.sqlite");
  const taskId = "t-retry-recovery";
  const requestId = durableRequestId(taskId, "call-retry-recovery");
  let handle: Awaited<ReturnType<typeof openDurableHarness>> | undefined;
  try {
    const models = createModels();
    const faux = fauxProvider();
    models.setProvider(faux.provider);
    // Only the original attempt ever runs: the crash came before the retry
    // submission, so the store holds no retry attempt to settle.
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 Too Many Requests" }),
    ]);
    await assert.rejects(runDurableTask({
      piDir,
      databasePath,
      taskId,
      task: "Work.",
      requestId,
      models: () => models,
    }));

    // What `recordRetry` + `noteAttemptRequestId` leave behind in the window.
    upsertTaskSessionHistory(piDir, {
      id: taskId,
      status: "running",
      background: true,
      agentType: "general",
      description: "retry recovery",
      sessionName: `task-${taskId}`,
      startedAt: Date.now() - 5_000,
      piDir,
      dir: join(piDir, "artifacts"),
      cwd: root,
      ownerSessionId: "sess-1",
      backend: "durable",
      durableRequestId: requestId,
      maxRetries: 3,
      retryCount: 2,
      lastRetryReason: "wall_clock_timeout",
      nextRetryAt: Date.now() - 1_000,
    });

    const sent: { content?: string; details?: Record<string, unknown> }[] = [];
    await resumeDurableAfterRestart({
      pi: { sendMessage: (message: (typeof sent)[number]) => { sent.push(message); } } as never,
      piDir,
      sessionId: "sess-1",
      databasePath,
      modelRegistry: {
        getAll: () => models.getAllModels() as never,
        find: (provider, modelId) => models.getModel(provider, modelId),
        streamSimple: (model, context, options) => models.streamSimple(model, context, options),
      },
    });
    await until(() => sent.length === 1);

    assert.equal(sent[0]?.details?.phase, "failed");
    assert.equal(sent[0]?.details?.retry_count, 2, "the row's retry count rides on the notice");
    assert.equal(sent[0]?.details?.last_retry_reason, "wall_clock_timeout");
    assert.match(
      String(sent[0]?.content),
      /A retry \(retry 2 of 3\) was scheduled or in flight when Pi exited; it did not survive the restart\./,
      "the notice names the interrupted retry instead of a bare failure line",
    );
    // The earlier attempt's own failure is still reported truthfully underneath.
    assert.match(String(sent[0]?.content), /durable subagent failed: model_error/);
    assert.equal(
      historyOf(root, taskId)?.status,
      "failed",
      "the retry chain is not resumed across a restart",
    );
  } finally {
    if (handle) await handle.harness.close(handle.context);
    rmSync(root, { recursive: true, force: true });
  }
});
