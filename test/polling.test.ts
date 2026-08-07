/**
 * Unit tests for the background polling dispose contract.
 *
 * Run: npx tsx test/polling.test.ts
 *
 * Covers:
 * - `startBackgroundPolling` returns a stop function.
 * - After stop(), the interval is cleared AND the disposed flag is set,
 *   so any scheduled-but-not-yet-started tick bails before touching `pi`.
 * - This is the fix for the race where a tick scheduled before
 *   `session_shutdown` fires after the runtime is torn down and triggers
 *   "This extension ctx is stale after session replacement or reload".
 * - stop() is idempotent.
 */

import { strict as assert } from "node:assert";
import { setTimeout as sleep } from "node:timers/promises";
import { startBackgroundPolling } from "../src/lifecycle/polling.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeDeps(
  overrides: Partial<{
    completeTask: any;
    backgroundTasks: Map<any, any>;
    checkTaskCompletion: any;
    killAgentPane: any;
    clearTaskWidgetIfIdle: any;
    TASK_TIMEOUT_MS: number;
    MAX_POLL_ERRORS: number;
    piDir: string;
    pi: any;
  }> = {},
) {
  return {
    backgroundTasks: new Map(),
    checkTaskCompletion: async () => ({ status: "running" }),
    killAgentPane: () => {},
    clearTaskWidgetIfIdle: () => {},
    completeTask: () => {},
    TASK_TIMEOUT_MS: 10_000,
    MAX_POLL_ERRORS: 3,
    piDir: "/tmp",
    pi: { __pi: "captured" },
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

{
  const t = "startBackgroundPolling returns a function (stop handle)";
  const stop = startBackgroundPolling(makeDeps(), 1_000_000);
  assert.equal(typeof stop, "function", t);
  stop();
}

{
  const t = "stop() prevents future ticks from calling completeTask with stale pi";
  let completeCallCount = 0;
  let lastPi: any = undefined;
  // Populate backgroundTasks so the tick has something to do.
  const backgroundTasks = new Map<any, any>();
  backgroundTasks.set("t1", {
    dir: "/tmp",
    sessionName: "s1",
    paneId: undefined,
    originalPane: null,
    startedAt: Date.now(),
  });
  const stop = startBackgroundPolling(
    makeDeps({
      backgroundTasks,
      checkTaskCompletion: async () => ({ status: "completed", content: "done" }),
      completeTask: (_pi: any) => {
        completeCallCount += 1;
        lastPi = _pi;
      },
    }),
    10, // very short interval so we get a tick
  );
  // Wait for at least one tick.
  await sleep(50);
  assert.ok(completeCallCount >= 1, `${t}: at least one tick before stop`);

  // Re-add a task since the first tick completed and removed it.
  backgroundTasks.set("t2", {
    dir: "/tmp",
    sessionName: "s2",
    paneId: undefined,
    originalPane: null,
    startedAt: Date.now(),
  });
  const beforeStopCount = completeCallCount;
  stop();

  // Wait several intervals; no more completeTask calls should happen.
  await sleep(80);
  assert.equal(
    completeCallCount,
    beforeStopCount,
    `${t}: no ticks after stop`,
  );
  assert.equal(
    lastPi?.__pi,
    "captured",
    `${t}: captured pi was the one used before stop`,
  );
}

{
  const t = "stop() during an in-flight tick does not double-fire after stop completes";
  // Simulate a slow checkTaskCompletion so a tick is in-flight when we stop.
  let resolveSlowCheck: ((v: any) => void) | undefined;
  const slowCheck = new Promise<any>((resolve) => {
    resolveSlowCheck = resolve;
  });

  const backgroundTasks = new Map<any, any>();
  backgroundTasks.set("t1", {
    dir: "/tmp",
    sessionName: "s1",
    paneId: undefined,
    originalPane: null,
    startedAt: Date.now(),
  });

  let completeCallCount = 0;
  const stop = startBackgroundPolling(
    makeDeps({
      backgroundTasks,
      checkTaskCompletion: async () => slowCheck,
      completeTask: () => {
        completeCallCount += 1;
      },
    }),
    5,
  );

  // Let a tick start (it will await the slow check).
  await sleep(20);
  // Stop while the tick is in-flight.
  stop();
  // Now resolve the slow check — the in-flight tick continues, but the
  // next scheduled tick (if any) must be skipped because the interval
  // is cleared.
  resolveSlowCheck!({ status: "running" });
  // Give plenty of time for any errant tick to fire.
  await sleep(80);
  // completeTask may or may not have been called by the in-flight tick
  // (depends on whether it ever reached a completeTask call site before
  // stop), but the count must NOT grow beyond what the in-flight tick
  // already produced.
  const finalCount = completeCallCount;
  await sleep(80);
  assert.equal(
    completeCallCount,
    finalCount,
    `${t}: no new ticks after in-flight tick + stop`,
  );
}

{
  const t = "stop() is idempotent — calling twice does not throw or double-clear";
  const stop = startBackgroundPolling(makeDeps(), 1_000_000);
  stop();
  // Second call must not throw.
  stop();
  // Third call also fine.
  stop();
  assert.ok(true, t);
}

{
  const t = "stop() returns nothing meaningful; callers ignore the return value";
  const stop = startBackgroundPolling(makeDeps(), 1_000_000);
  const result = stop();
  // Function returns void / undefined — we don't care about the exact shape,
  // just that callers can ignore it.
  assert.ok(result === undefined, t);
}

{
  const t =
    "tick after stop() does not invoke completeTask even if scheduled before stop";
  // Use a controlled check that records whether it was called, so we can
  // assert the disposed flag actually short-circuits the tick (vs. just
  // the interval being cleared).
  let checkCount = 0;
  const backgroundTasks = new Map<any, any>();
  backgroundTasks.set("t1", {
    dir: "/tmp",
    sessionName: "s1",
    paneId: undefined,
    originalPane: null,
    startedAt: Date.now(),
  });
  const stop = startBackgroundPolling(
    makeDeps({
      backgroundTasks,
      checkTaskCompletion: async () => {
        checkCount += 1;
        return { status: "running" };
      },
    }),
    5, // very short — tick is likely already in-flight when we stop
  );
  // Let several ticks fire.
  await sleep(50);
  const beforeStop = checkCount;
  assert.ok(beforeStop > 0, `${t}: ticks fired before stop`);

  stop();

  // Wait much longer than the interval.
  await sleep(80);
  // The interval is cleared AND the disposed flag is set, so even if a
  // tick was already scheduled (waiting in the event loop) it should bail
  // before calling checkTaskCompletion. We allow at most one additional
  // call (the tick that was already in-flight when stop() ran).
  const afterStop = checkCount - beforeStop;
  assert.ok(
    afterStop <= 1,
    `${t}: at most one in-flight tick after stop, got ${afterStop}`,
  );
}


{
  const t = "overlapping polling ticks do not complete the same task twice";
  const backgroundTasks = new Map<any, any>();
  backgroundTasks.set("t1", {
    dir: "/tmp/pi-task-artifacts",
    sessionName: "s1",
    paneId: "%1",
    originalPane: null,
    startedAt: Date.now(),
  });

  let completeCount = 0;
  let release!: () => void;
  const firstCheck = new Promise<void>((resolve) => {
    release = resolve;
  });

  const stop = startBackgroundPolling(
    makeDeps({
      backgroundTasks,
      checkTaskCompletion: async () => {
        await firstCheck;
        return { status: "completed", content: "done" };
      },
      completeTask: () => {
        completeCount += 1;
      },
    }),
    5,
  );

  await sleep(30);
  release();
  await sleep(40);
  stop();

  assert.equal(completeCount, 1, `${t}: expected exactly one completion`);
}

{
  const t = "cancellation removes a task before an in-flight completion snapshot is applied";
  const backgroundTasks = new Map<any, any>();
  const task = {
    dir: "/tmp/pi-task-artifacts",
    sessionName: "s1",
    paneId: "%1",
    originalPane: null,
    startedAt: Date.now(),
  };
  backgroundTasks.set("t1", task);
  let release!: () => void;
  const check = new Promise<void>((resolve) => {
    release = resolve;
  });
  let completeCount = 0;

  const stop = startBackgroundPolling(
    makeDeps({
      backgroundTasks,
      checkTaskCompletion: async () => {
        await check;
        return { status: "completed", content: "stale" };
      },
      completeTask: () => {
        completeCount += 1;
      },
    }),
    5,
  );

  await sleep(30);
  backgroundTasks.delete("t1");
  release();
  await sleep(40);
  stop();

  assert.equal(completeCount, 0, `${t}: stale completion must be ignored`);
}

console.log("ALL POLLING TESTS PASSED");
