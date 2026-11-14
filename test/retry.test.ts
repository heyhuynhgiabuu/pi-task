/**
 * Unit tests for the per-task retry policy (`src/lifecycle/retry.ts`) and its
 * polling-loop wiring (per-task timeout override, retry scheduling, skip
 * while a relaunch is pending).
 *
 * Run: npx tsx test/retry.test.ts
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";

import {
  RETRY_MAX_DELAY_MS,
  planTaskRetry,
  recordRetryAttempt,
  restoredRetryState,
  retryBackoffMs,
  transientFailureReason,
  retryRelaunchFailureMessage,
} from "../src/lifecycle/retry.js";
import { readRegistry, writeRegistry } from "../src/conversation.js";
import { startBackgroundPolling } from "../src/lifecycle/polling.js";
import { resolveTaskTimeoutMs } from "../src/helpers.js";
import type { BackgroundTask, RegistryEntry } from "../src/types.js";

// ─── retryBackoffMs ─────────────────────────────────────────────────────────

test("retry backoff doubles per attempt and caps at 60s", () => {
  assert.equal(retryBackoffMs(0), 1_000);
  assert.equal(retryBackoffMs(1), 2_000);
  assert.equal(retryBackoffMs(2), 4_000);
  assert.equal(retryBackoffMs(3), 8_000);
  assert.equal(retryBackoffMs(6), 64_000 > RETRY_MAX_DELAY_MS ? RETRY_MAX_DELAY_MS : 64_000);
  assert.equal(retryBackoffMs(7), RETRY_MAX_DELAY_MS);
  assert.equal(retryBackoffMs(50), RETRY_MAX_DELAY_MS);
  // A corrupt counter cannot overflow or go negative.
  assert.equal(retryBackoffMs(Number.NaN), 1_000);
  assert.equal(retryBackoffMs(-3), 1_000);
  assert.equal(retryBackoffMs(1.9), 2_000);
});

// ─── transientFailureReason ─────────────────────────────────────────────────

test("transient failures are classified by wording and status", () => {
  assert.equal(transientFailureReason("fetch failed: ECONNRESET"), "transient_network");
  assert.equal(transientFailureReason("503 Service Unavailable"), "transient_status");
  assert.equal(transientFailureReason("HTTP 429 Too Many Requests"), "transient_status");
  assert.equal(transientFailureReason("socket hang up"), "transient_network");
  assert.equal(transientFailureReason("upstream connect error"), "transient_network");
  assert.equal(transientFailureReason(""), undefined);
  assert.equal(transientFailureReferenceSafe(), undefined);
  // Not transient wording.
  assert.equal(transientFailureReason("tool edit_file not found"), undefined);
});

function transientFailureReferenceSafe(): string | undefined {
  return transientFailureReason("Provider returned 400 bad request");
}

// ─── planTaskRetry ──────────────────────────────────────────────────────────

function plan(overrides: Partial<Parameters<typeof planTaskRetry>[0]> = {}) {
  return planTaskRetry({
    phase: "failed",
    content: "503 Service Unavailable",
    maxRetries: 2,
    retryCount: 0,
    canRelaunch: true,
    ...overrides,
  });
}

test("a transient failure with allowance yields a retry plan", () => {
  const result = plan();
  assert.ok(result);
  assert.equal(result.attempt, 0);
  assert.equal(result.delayMs, 1_000);
  assert.equal(result.reason, "transient_status");
});

test("no retry when maxRetries is absent, zero, or exhausted", () => {
  assert.equal(plan({ maxRetries: undefined }), undefined);
  assert.equal(plan({ maxRetries: 0 }), undefined);
  assert.equal(plan({ retryCount: 2 }), undefined);
  assert.equal(plan({ retryCount: 5 }), undefined);
});

test("no retry on success, cancellation, or non-retryable failure", () => {
  assert.equal(plan({ phase: "done" as never }), undefined);
  assert.equal(plan({ phase: "cancelled" as never }), undefined);
  assert.equal(
    plan({ content: "the child aborted the run" }),
    undefined,
  );
  assert.equal(plan({ content: "edit_file tool failed" }), undefined);
});

test("comparison siblings and non-relaunchable trackers never retry", () => {
  assert.equal(plan({ comparisonGroupId: "cmp-1" }), undefined);
  assert.equal(plan({ canRelaunch: false }), undefined);
});

test("model failover wording classifies with its reason", () => {
  const result = plan({ content: "model_error: provider unavailable" });
  assert.ok(result);
  assert.match(result.reason, /^model_failover:/);
});

test("a wall-clock timeout retries even without provider wording", () => {
  const result = plan({
    phase: "timeout",
    content: "Task timed out after 300s without producing a result.",
  });
  assert.ok(result);
  assert.equal(result.reason, "wall_clock_timeout");
});

test("suppressed and already-pending settlements never retry", () => {
  assert.equal(plan({ suppressed: true }), undefined);
  assert.equal(plan({ alreadyPending: true }), undefined);
});

test("attempt counts increment the backoff delay", () => {
  const result = plan({ retryCount: 1 });
  assert.ok(result);
  assert.equal(result.attempt, 1);
  assert.equal(result.delayMs, 2_000);
});

// ─── recordRetryAttempt ─────────────────────────────────────────────────────

const RETRY_PI_DIR = mkdtempSync(join(tmpdir(), "pi-task-retry-dir-"));
process.on("exit", () => rmSync(RETRY_PI_DIR, { recursive: true, force: true }));

function seedEntry(id: string): RegistryEntry {
  const entry: RegistryEntry = {
    id,
    agentType: "general",
    description: "retry test",
    sessionName: `sess-${id}`,
    startedAt: Date.now(),
    piDir: RETRY_PI_DIR,
    dir: RETRY_PI_DIR,
  };
  writeRegistry(RETRY_PI_DIR, [entry]);
  return entry;
}

test("recordRetryAttempt merges fields into the existing entry", () => {
  const entry = seedEntry("t-retry-record");
  const recorded = recordRetryAttempt(RETRY_PI_DIR, entry.id, {
    retryCount: 1,
    nextRetryAt: 123_456,
    lastRetryReason: "transient_status",
  });
  assert.equal(recorded, true);
  const stored = readRegistry(RETRY_PI_DIR).find((e) => e.id === entry.id);
  assert.ok(stored);
  assert.equal(stored.retryCount, 1);
  assert.equal(stored.nextRetryAt, 123_456);
  assert.equal(stored.lastRetryReason, "transient_status");
  // Unrelated fields survive the merge.
  assert.equal(stored.agentType, "general");
});

test("recordRetryAttempt reports a missing entry without creating one", () => {
  assert.equal(
    recordRetryAttempt(RETRY_PI_DIR, "t-does-not-exist", {
      retryCount: 1,
      nextRetryAt: 1,
      lastRetryReason: "x",
    }),
    false,
  );
  assert.equal(readRegistry(RETRY_PI_DIR).some((e) => e.id === "t-does-not-exist"), false);
});

// ─── restoredRetryState / resolveTaskTimeoutMs ──────────────────────────────

test("restored retry state carries only present positive fields", () => {
  assert.deepEqual(restoredRetryState({}), {});
  const full = restoredRetryState({
    timeoutMinutes: 5,
    timeoutMs: 300_000,
    maxRetries: 2,
    retryCount: 1,
  });
  assert.deepEqual(full, {
    timeoutMinutes: 5,
    timeoutMs: 300_000,
    maxRetries: 2,
    retryCount: 1,
  });
  // Zeros and negatives are dropped, not carried.
  assert.deepEqual(
    restoredRetryState({ timeoutMinutes: 0, maxRetries: -1, retryCount: 0 }),
    {},
  );
});

test("resolveTaskTimeoutMs falls back to the global ceiling on bad input", () => {
  assert.deepEqual(resolveTaskTimeoutMs(undefined, 30 * 60_000), {
    timeoutMs: 30 * 60_000,
  });
  assert.deepEqual(resolveTaskTimeoutMs(0, 30 * 60_000), { timeoutMs: 30 * 60_000 });
  assert.deepEqual(resolveTaskTimeoutMs(-5, 30 * 60_000), { timeoutMs: 30 * 60_000 });
  assert.deepEqual(resolveTaskTimeoutMs(Number.NaN, 30 * 60_000), {
    timeoutMs: 30 * 60_000,
  });
  assert.deepEqual(resolveTaskTimeoutMs(5, 30 * 60_000), {
    timeoutMs: 5 * 60_000,
    timeoutMinutes: 5,
  });
});

// ─── polling-loop wiring ────────────────────────────────────────────────────

const POLL_PI_DIR = mkdtempSync(join(tmpdir(), "pi-task-retry-poll-dir-"));
process.on("exit", () => rmSync(POLL_PI_DIR, { recursive: true, force: true }));

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    backgroundTasks: new Map<string, BackgroundTask>(),
    checkTaskCompletion: async () => ({ status: "running" }) as never,
    clearTaskWidgetIfIdle: () => {},
    completeTask: () => {},
    hardTimeoutMs: 10_000,
    MAX_POLL_ERRORS: 3,
    piDir: POLL_PI_DIR,
    pi: {},
    notifyUser: () => {},
    ...overrides,
  };
}

function tracker(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    dir: POLL_PI_DIR,
    agentType: "general",
    sessionName: "sess",
    originalPane: null,
    description: "retry wiring",
    startedAt: Date.now(),
    toolUses: 0,
    turns: 0,
    recentCalls: [],
    backend: "tmux",
    ...overrides,
  };
}

function pollWarning(messages: string[]): (text: string) => void {
  return (text: string) => messages.push(text);
}

test("a failed snapshot with retry allowance schedules a relaunch instead of settling", async () => {
  const task = tracker({
    maxRetries: 1,
    // Mirror the production closure: a relaunch resets the pending flag and
    // starts a fresh run.
    relaunch: async () => {
      task.retryPending = false;
      task.startedAt = Date.now();
      relaunched = true;
    },
  });
  let relaunched = false;
  const complete: string[] = [];
  const deps = makeDeps({
    backgroundTasks: new Map([["t-retry", task]]),
    // The first attempt failed transiently; after the relaunch the fresh run
    // is still working, so the probe reports running.
    checkTaskCompletion: async () =>
      ({ status: relaunched ? "running" : "failed", content: "503 Service Unavailable" }) as never,
    notifyUser: pollWarning([]),
  });
  (deps as { completeTask: () => void }).completeTask = () => {
    complete.push("settled");
  };
  const stop = startBackgroundPolling(deps as never, 10);
  await sleep(60);
  assert.equal(complete.length, 0, "must not settle while a retry is scheduled");
  assert.equal(task.retryPending, true);
  assert.equal(task.retryCount, 1);
  // The relaunch fires after the 1s backoff and clears the pending flag.
  await sleep(1_400);
  assert.equal(task.retryPending, false);
  assert.equal(complete.length, 0);
  assert.equal(task.startedAt > 0, true);
  stop();
});

test("a failed snapshot without allowance settles immediately", async () => {
  const task = tracker({});
  const complete: string[] = [];
  const deps = makeDeps({
    backgroundTasks: new Map([["t-noretry", task]]),
    checkTaskCompletion: async () => ({ status: "failed", content: "503 Service Unavailable" }) as never,
    completeTask: () => {
      complete.push("settled");
    },
    notifyUser: pollWarning([]),
  });
  const stop = startBackgroundPolling(deps as never, 10);
  await sleep(60);
  assert.equal(complete.length, 1);
  assert.equal(task.retryPending, undefined);
  stop();
});

test("a per-task timeout overrides the global ceiling", async () => {
  const task = tracker({ timeoutMs: 50, maxRetries: 0 });
  const complete: string[] = [];
  const deps = makeDeps({
    backgroundTasks: new Map([["t-timeout", task]]),
    checkTaskCompletion: async () => ({ status: "running" }) as never,
    completeTask: (() => {
      complete.push("settled");
    }) as never,
    notifyUser: pollWarning([]),
  });
  const stop = startBackgroundPolling(deps as never, 10);
  await sleep(120);
  assert.equal(complete.length, 1, "per-task 50ms ceiling must settle well before the 10s global");
  stop();
});

test("an exhausted retry allowance settles on the next failure", async () => {
  const task = tracker({ maxRetries: 1, retryCount: 1, relaunch: async () => {} });
  const complete: string[] = [];
  const deps = makeDeps({
    backgroundTasks: new Map([["t-exhausted", task]]),
    checkTaskCompletion: async () => ({ status: "failed", content: "503 Service Unavailable" }) as never,
    completeTask: () => {
      complete.push("settled");
    },
    notifyUser: pollWarning([]),
  });
  const stop = startBackgroundPolling(deps as never, 10);
  await sleep(60);
  assert.equal(complete.length, 1, "attempt 1 of maxRetries 1 is exhausted");
  stop();
});

test("a relaunch throw settles the task as failed", async () => {
  const task = tracker({
    maxRetries: 1,
    relaunch: async () => {
      throw new Error("tmux server died");
    },
  });
  const settled: string[] = [];
  const deps = makeDeps({
    backgroundTasks: new Map([["t-relaunch-fail", task]]),
    checkTaskCompletion: async () => ({ status: "failed", content: "503 Service Unavailable" }) as never,
    completeTask: (() => {
      settled.push("settled");
    }) as never,
    notifyUser: pollWarning([]),
  });
  const stop = startBackgroundPolling(deps as never, 10);
  await sleep(1_400);
  assert.equal(settled.length, 1);
  stop();
});

test("retryRelaunchFailureMessage names the attempt and error", () => {
  const message = retryRelaunchFailureMessage(0, new Error("boom"));
  assert.match(message, /retry 1/);
  assert.match(message, /boom/);
});

// ─── settlement failure during a relaunch throw (review Major 1) ───────────

test("a relaunch-throw settlement that hits a corrupt registry does not wedge the tracker", async () => {
  const { DurableStateError } = await import("../src/conversation.js");
  const task = tracker({
    maxRetries: 1,
    relaunch: async () => {
      throw new Error("tmux server died");
    },
  });
  const warnings: string[] = [];
  let completeCalls = 0;
  const deps = makeDeps({
    backgroundTasks: new Map([["t-wedge", task]]),
    checkTaskCompletion: async () => ({ status: "failed", content: "503 Service Unavailable" }) as never,
    // First settlement (the relaunch-throw one) hits the corrupt registry;
    // the second (the exhausted-allowance settle on a later tick) succeeds.
    completeTask: () => {
      completeCalls += 1;
      if (completeCalls === 1) throw new DurableStateError("registry.json", "read");
    },
    notifyUser: pollWarning(warnings),
  });
  const stop = startBackgroundPolling(deps as never, 10);
  await sleep(1_600);
  assert.equal(completeCalls, 2, "the failed settlement retried on a later tick");
  assert.equal(task.retryPending, false, "the tracker must not wedge with retryPending stuck");
  assert.ok(warnings.some((w) => w.includes("settlement blocked")), "the durable-state warning surfaced");
  stop();
});
