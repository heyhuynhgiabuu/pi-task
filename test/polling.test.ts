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
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BACKGROUND_POLL_CONCURRENCY } from "../src/constants.js";
import { envHardTimeoutMs } from "../src/helpers.js";
import { DurableStateError } from "../src/conversation.js";
import { startBackgroundPolling } from "../src/lifecycle/polling.js";
import { startToolStatsPolling } from "../src/lifecycle/toolStats.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

// Wrap-up persistence writes the durable registry; keep it off the real /tmp.
const POLL_PI_DIR = mkdtempSync(join(tmpdir(), "pi-task-poll-pidir-"));
process.on("exit", () => rmSync(POLL_PI_DIR, { recursive: true, force: true }));

function makeDeps(
  overrides: Partial<{
    completeTask: any;
    backgroundTasks: Map<any, any>;
    checkTaskCompletion: any;
    clearTaskWidgetIfIdle: any;
    hardTimeoutMs: number;
    MAX_POLL_ERRORS: number;
    piDir: string;
    pi: any;
    steerTask: any;
  }> = {},
) {
  return {
    backgroundTasks: new Map(),
    checkTaskCompletion: async () => ({ status: "running" }),
    clearTaskWidgetIfIdle: () => {},
    completeTask: () => {},
    hardTimeoutMs: 10_000,
    MAX_POLL_ERRORS: 3,
    piDir: POLL_PI_DIR,
    pi: { __pi: "captured" },
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

{
  const t = "a disabled wall-clock ceiling never times out a stale task";
  const backgroundTasks = new Map<any, any>();
  backgroundTasks.set("t1", {
    id: "t1",
    dir: "/tmp",
    sessionName: "s1",
    paneId: undefined,
    originalPane: null,
    startedAt: Date.now() - 2 * 60 * 60 * 1000, // two hours old
  });
  let settled: any;
  const stop = startBackgroundPolling(
    makeDeps({
      backgroundTasks,
      hardTimeoutMs: envHardTimeoutMs({ PI_TASK_HARD_TIMEOUT_MINUTES: "0" }),
      completeTask: (options: any) => {
        settled = options;
      },
    }),
    5,
  );
  await sleep(40);
  stop();
  assert.equal(settled, undefined, t);
}

{
  const t = "the turn soft limit still settles when the wall clock is disabled";
  const root = mkdtempSync(join(tmpdir(), "pi-task-polling-disabled-"));
  try {
    const taskId = "task-soft-limit";
    mkdirSync(join(root, "sessions", taskId), { recursive: true });
    const backgroundTasks = new Map<any, any>();
    backgroundTasks.set(taskId, {
      id: taskId,
      dir: root,
      sessionName: taskId,
      paneId: undefined,
      originalPane: null,
      startedAt: Date.now() - 2 * 60 * 60 * 1000,
      maxTurns: 3,
      turns: 3,
    });
    let settled: { content: string; phase: string } | undefined;
    const stop = startBackgroundPolling(
      makeDeps({
        backgroundTasks,
        hardTimeoutMs: envHardTimeoutMs({ PI_TASK_HARD_TIMEOUT_MINUTES: "0" }),
        completeTask: ({ content, phase }: any) => {
          settled = { content, phase };
        },
      }),
      5,
    );
    await sleep(40);
    stop();
    assert.equal(settled?.phase, "timeout", `${t}: limit phase`);
    assert.match(settled?.content ?? "", /reached the 3-turn limit/, t);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const t = "startBackgroundPolling returns a function (stop handle)";
  const stop = startBackgroundPolling(makeDeps(), 1_000_000);
  assert.equal(typeof stop, "function", t);
  stop();
}

{
  const t = "successful probes reset transient polling errors";
  const backgroundTasks = new Map<any, any>([["t-reset", {
    dir: "/tmp",
    sessionName: "s-reset",
    paneId: undefined,
    originalPane: null,
    startedAt: Date.now(),
  }]]);
  let calls = 0;
  let settled = false;
  const stop = startBackgroundPolling(
    makeDeps({
      backgroundTasks,
      MAX_POLL_ERRORS: 2,
      checkTaskCompletion: async () => {
        calls += 1;
        if (calls === 1 || calls === 3) throw new Error(`transient-${calls}`);
        return { status: "running", content: "" };
      },
      completeTask: () => {
        settled = true;
      },
    }),
    5,
  );
  await sleep(70);
  stop();
  assert.ok(calls >= 3, `${t}: exercised failure, success, failure sequence`);
  assert.equal(settled, false, `${t}: task remains alive after reset`);
  assert.equal(backgroundTasks.has("t-reset"), true, `${t}: task remains registered`);
}

{
  const t = "an unreachable Herdr control keeps the task and reports the outage";
  // An outage is not a dead child: the pane and the session file are untouched. Settling here
  // would close a healthy pane and record a failure for a task that may still be running.
  const backgroundTasks = new Map<any, any>([["t-herdr-gone", {
    dir: "/tmp/pi-task-herdr-outage",
    sessionName: "s-herdr-gone",
    paneId: "%77",
    originalPane: null,
    startedAt: Date.now(),
  }]]);
  let settled = false;
  const diagnostics: string[] = [];
  const previousError = console.error;
  console.error = (...args: unknown[]) => diagnostics.push(args.map(String).join(" "));
  const stop = startBackgroundPolling(
    makeDeps({
      backgroundTasks,
      hardTimeoutMs: Number.POSITIVE_INFINITY,
      MAX_POLL_ERRORS: 2,
      checkTaskCompletion: async () => {
        const error = new Error("herdr control socket is gone");
        error.name = "HerdrUnavailableError";
        throw error;
      },
      completeTask: () => {
        settled = true;
      },
    }),
    5,
  );
  try {
    await sleep(60);
    assert.equal(settled, false, `${t}: a healthy task is never settled`);
    assert.equal(backgroundTasks.has("t-herdr-gone"), true, `${t}: task stays tracked`);
    assert.equal(diagnostics.length, 1, `${t}: the outage is reported, bounded to once`);
    assert.match(diagnostics[0] ?? "", /Herdr control is unavailable/, `${t}: names the cause`);
    assert.match(diagnostics[0] ?? "", /kept and polling continues/, `${t}: says it was kept`);
  } finally {
    stop();
    console.error = previousError;
  }
}

{
  const t = "a child that finished before the Herdr control vanished is still delivered";
  // The regression this pins: the first fix settled such a task as `failed` without ever reading
  // the session, so a completed child was reported as a failure and its pane closed.
  const root = mkdtempSync(join(tmpdir(), "pi-task-herdr-finished-"));
  try {
    const taskId = "t-herdr-finished";
    const sessionDir = join(root, "sessions", taskId);
    mkdirSync(sessionDir, { recursive: true });
    const startedAt = Date.now() - 5_000;
    writeFileSync(
      join(sessionDir, `${taskId}.jsonl`),
      JSON.stringify({ type: "session_info", name: taskId }) + "\n" +
      JSON.stringify({
        type: "message",
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "finished before the control went away" }],
          stopReason: "endTurn",
        },
      }) + "\n",
    );
    const backgroundTasks = new Map<any, any>([[taskId, {
      dir: root,
      sessionName: taskId,
      paneId: "%79",
      originalPane: null,
      startedAt,
    }]]);
    let settled: { content: string; phase: string } | undefined;
    const stop = startBackgroundPolling(
      makeDeps({
        backgroundTasks,
        hardTimeoutMs: Number.POSITIVE_INFINITY,
        MAX_POLL_ERRORS: 1,
        checkTaskCompletion: async () => {
          const error = new Error("herdr control socket is gone");
          error.name = "HerdrUnavailableError";
          throw error;
        },
        completeTask: ({ content, phase }: any) => {
          settled = { content, phase };
        },
      }),
      5,
    );
    try {
      await sleep(40);
      assert.equal(settled?.phase, "done", `${t}: the child's own result is delivered`);
      assert.match(settled?.content ?? "", /finished before the control went away/, `${t}: real result`);
      assert.equal(backgroundTasks.has(taskId), false, `${t}: retired after delivery`);
    } finally {
      stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const t = "an outage that ends and returns is reported again";
  // Pins the counter reset: without it the second outage is swallowed, so a control that flaps
  // would report once and then stay silent forever.
  const backgroundTasks = new Map<any, any>([["t-herdr-flap", {
    dir: "/tmp/pi-task-herdr-flap",
    sessionName: "s-herdr-flap",
    paneId: "%80",
    originalPane: null,
    startedAt: Date.now(),
  }]]);
  let calls = 0;
  const diagnostics: string[] = [];
  const previousError = console.error;
  console.error = (...args: unknown[]) => diagnostics.push(args.map(String).join(" "));
  const stop = startBackgroundPolling(
    makeDeps({
      backgroundTasks,
      hardTimeoutMs: Number.POSITIVE_INFINITY,
      MAX_POLL_ERRORS: 2,
      checkTaskCompletion: async () => {
        calls += 1;
        // Two failures, one good probe, then failures again.
        if (calls === 3) return { status: "running", content: "" };
        const error = new Error(`herdr control socket is gone (${calls})`);
        error.name = "HerdrUnavailableError";
        throw error;
      },
      completeTask: () => {
        throw new Error(`${t}: a healthy task must never settle`);
      },
    }),
    5,
  );
  try {
    await sleep(120);
    assert.ok(calls >= 5, `${t}: exercised outage, recovery, outage`);
    assert.equal(
      diagnostics.length,
      2,
      `${t}: one report per outage (got ${diagnostics.length})`,
    );
  } finally {
    stop();
    console.error = previousError;
  }
}

{
  const t = "a failed session row during an outage does not settle a live child";
  // A provider error can be an intermediate row while Pi retries. During an outage the control
  // cannot tell whether the child is alive, so settling `failed` here would close a live pane.
  const root = mkdtempSync(join(tmpdir(), "pi-task-herdr-failed-row-"));
  try {
    const taskId = "t-herdr-failed-row";
    const sessionDir = join(root, "sessions", taskId);
    mkdirSync(sessionDir, { recursive: true });
    const startedAt = Date.now() - 5_000;
    writeFileSync(
      join(sessionDir, `${taskId}.jsonl`),
      JSON.stringify({ type: "session_info", name: taskId }) + "\n" +
      JSON.stringify({
        type: "message",
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "429 rate limited, retrying" }],
          stopReason: "error",
          errorMessage: "429 rate limited",
        },
      }) + "\n",
    );
    const backgroundTasks = new Map<any, any>([[taskId, {
      dir: root,
      sessionName: taskId,
      paneId: "%81",
      originalPane: null,
      startedAt,
    }]]);
    let settled = false;
    const stop = startBackgroundPolling(
      makeDeps({
        backgroundTasks,
        hardTimeoutMs: Number.POSITIVE_INFINITY,
        MAX_POLL_ERRORS: 1000,
        checkTaskCompletion: async () => {
          const error = new Error("herdr control socket is gone");
          error.name = "HerdrUnavailableError";
          throw error;
        },
        completeTask: () => {
          settled = true;
        },
      }),
      5,
    );
    try {
      await sleep(60);
      assert.equal(settled, false, `${t}: a retrying child is not declared failed`);
      assert.equal(backgroundTasks.has(taskId), true, `${t}: task stays tracked for the next poll`);
    } finally {
      stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const t = "an outage is not reported before the threshold";
  // Reporting on the first failing tick would cry outage on a single dropped read.
  const backgroundTasks = new Map<any, any>([["t-herdr-quiet", {
    dir: "/tmp/pi-task-herdr-quiet",
    sessionName: "s-herdr-quiet",
    paneId: "%82",
    originalPane: null,
    startedAt: Date.now(),
  }]]);
  const diagnostics: string[] = [];
  const previousError = console.error;
  console.error = (...args: unknown[]) => diagnostics.push(args.map(String).join(" "));
  const stop = startBackgroundPolling(
    makeDeps({
      backgroundTasks,
      hardTimeoutMs: Number.POSITIVE_INFINITY,
      MAX_POLL_ERRORS: 1000,
      checkTaskCompletion: async () => {
        const error = new Error("herdr control socket is gone");
        error.name = "HerdrUnavailableError";
        throw error;
      },
      completeTask: () => {
        throw new Error(`${t}: nothing settles during an outage`);
      },
    }),
    5,
  );
  try {
    await sleep(40);
    assert.equal(diagnostics.length, 0, `${t}: below the threshold stays quiet`);
    assert.equal(backgroundTasks.has("t-herdr-quiet"), true, `${t}: task stays tracked`);
  } finally {
    stop();
    console.error = previousError;
  }
}

{
  const t = "a replaced task is not settled from an outage recovery";
  // The tick may resume after the task was replaced (resume, cancel-and-restart). Settling then
  // would deliver a result for a task object that no longer owns the id.
  const root = mkdtempSync(join(tmpdir(), "pi-task-herdr-replaced-"));
  try {
    const taskId = "t-herdr-replaced";
    const sessionDir = join(root, "sessions", taskId);
    mkdirSync(sessionDir, { recursive: true });
    const startedAt = Date.now() - 5_000;
    writeFileSync(
      join(sessionDir, `${taskId}.jsonl`),
      JSON.stringify({ type: "session_info", name: taskId }) + "\n" +
      JSON.stringify({
        type: "message",
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "the old run's result" }],
          stopReason: "endTurn",
        },
      }) + "\n",
    );
    const original = {
      dir: root,
      sessionName: taskId,
      paneId: "%83",
      originalPane: null,
      startedAt,
    };
    const backgroundTasks = new Map<any, any>([[taskId, original]]);
    let settledIds: string[] = [];
    const stop = startBackgroundPolling(
      makeDeps({
        backgroundTasks,
        hardTimeoutMs: Number.POSITIVE_INFINITY,
        MAX_POLL_ERRORS: 1,
        checkTaskCompletion: async () => {
          // A resume replaced the entry while this tick was in flight.
          backgroundTasks.set(taskId, { ...original, paneId: "%84" });
          const error = new Error("herdr control socket is gone");
          error.name = "HerdrUnavailableError";
          throw error;
        },
        completeTask: ({ id }: any) => {
          settledIds.push(id);
        },
      }),
      5,
    );
    try {
      await sleep(40);
      assert.deepEqual(settledIds, [], `${t}: the replaced task is left to its own poll`);
      assert.equal(backgroundTasks.has(taskId), true, `${t}: the new task keeps its slot`);
    } finally {
      stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
      completeTask: (options: any) => {
        completeCallCount += 1;
        lastPi = options.pi;
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
  const t = "timeout settlement preserves a deferred provider failure";
  const root = mkdtempSync(join(tmpdir(), "pi-task-polling-timeout-"));
  try {
    const taskId = "task-timeout";
    const sessionDir = join(root, "sessions", taskId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "task-timeout.jsonl"),
      JSON.stringify({ type: "session_info", name: "task-timeout" }) + "\n" +
        JSON.stringify({
          type: "message",
          timestamp: new Date().toISOString(),
          message: {
            role: "assistant",
            stopReason: "error",
            errorMessage: "provider failure retained",
            content: [],
          },
        }) + "\n",
    );
    const backgroundTasks = new Map<any, any>();
    backgroundTasks.set(taskId, {
      id: taskId,
      dir: root,
      sessionName: taskId,
      startedAt: Date.now() - 1000,
    });
    let settled: { content: string; phase: string } | undefined;
    const stop = startBackgroundPolling(
      makeDeps({
        backgroundTasks,
        hardTimeoutMs: 0,
        completeTask: ({ content, phase }: any) => {
          settled = { content, phase };
        },
      }),
      5,
    );
    await sleep(30);
    stop();
    assert.equal(settled?.phase, "failed", t);
    assert.match(settled?.content ?? "", /provider failure retained/, t);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
  const t = "a slow task does not block a sibling completion check";
  const backgroundTasks = new Map<any, any>([
    ["slow", {
      dir: "/tmp/pi-task-artifacts",
      sessionName: "slow",
      paneId: "%1",
      originalPane: null,
      startedAt: Date.now(),
    }],
    ["fast", {
      dir: "/tmp/pi-task-artifacts",
      sessionName: "fast",
      paneId: "%2",
      originalPane: null,
      startedAt: Date.now(),
    }],
  ]);
  let releaseSlow!: () => void;
  const slowCheck = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  let slowStarted = false;
  let fastCompletedBeforeSlowReleased = false;
  const stop = startBackgroundPolling(
    makeDeps({
      backgroundTasks,
      checkTaskCompletion: async ({ taskId }: { taskId?: string }) => {
        if (taskId === "slow") {
          slowStarted = true;
          await slowCheck;
          return { status: "running", content: "" };
        }
        fastCompletedBeforeSlowReleased = true;
        return { status: "completed", content: "fast done" };
      },
      completeTask: () => {},
    }),
    5,
  );
  try {
    await sleep(40);
    assert.equal(slowStarted, true, `${t}: slow check started`);
    assert.equal(
      fastCompletedBeforeSlowReleased,
      true,
      `${t}: fast sibling was checked before slow check released`,
    );
  } finally {
    stop();
    releaseSlow();
    await sleep(20);
  }
}

{
  const t = "polling bounds concurrent completion checks";
  const backgroundTasks = new Map<any, any>(
    Array.from({ length: 6 }, (_, index) => [
      `task-${index}`,
      {
        dir: "/tmp/pi-task-artifacts",
        sessionName: `task-${index}`,
        paneId: `%${index}`,
        originalPane: null,
        startedAt: Date.now(),
      },
    ]),
  );
  let activeChecks = 0;
  let maxActiveChecks = 0;
  let startedChecks = 0;
  const releases: Array<() => void> = [];
  const stop = startBackgroundPolling(
    makeDeps({
      backgroundTasks,
      checkTaskCompletion: async () => {
        startedChecks += 1;
        activeChecks += 1;
        maxActiveChecks = Math.max(maxActiveChecks, activeChecks);
        await new Promise<void>((resolve) => releases.push(resolve));
        activeChecks -= 1;
        return { status: "running", content: "" };
      },
    }),
    5,
  );
  try {
    await sleep(40);
    assert.equal(
      startedChecks,
      BACKGROUND_POLL_CONCURRENCY,
      `${t}: only the configured number of checks start in the first wave`,
    );
    assert.equal(
      maxActiveChecks,
      BACKGROUND_POLL_CONCURRENCY,
      `${t}: active checks are bounded at the configured limit`,
    );
  } finally {
    stop();
    for (const release of releases) release();
    await sleep(20);
  }
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


{
  const t = "completeTask throwing inside tick never becomes an unhandled rejection and keeps polling";
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const backgroundTasks = new Map<any, any>();
    backgroundTasks.set("t1", {
      dir: "/tmp",
      sessionName: "s1",
      paneId: undefined,
      originalPane: null,
      startedAt: Date.now(),
    });
    let failFirst = true;
    let completedAfterFailure = true;
    let errorMode = true;
    const stop = startBackgroundPolling(
      makeDeps({
        backgroundTasks,
        checkTaskCompletion: async () => {
          if (errorMode) throw new Error("poll boom");
          return { status: "completed", content: "done" };
        },
        completeTask: () => {
          if (failFirst) {
            // Only reachable from the poll-error catch handler: the success
            // path's completeTask is already inside the per-task try.
            failFirst = false;
            errorMode = false;
            throw new Error("durable write boom");
          }
          completedAfterFailure = true;
        },
      }),
      10,
    );
    await sleep(80);
    stop();
    assert.equal(failFirst, false, t + ": catch-handler completeTask threw once");
    assert.equal(completedAfterFailure, true, t + ": a later tick still delivered");
    assert.equal(unhandled.length, 0, `${t}: no unhandled rejections (${unhandled.map(String).join("; ")})`);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
}

{
  const t = "DurableStateError during max-poll settlement logs once";
  const backgroundTasks = new Map<any, any>();
  const taskId = "t-durable-state-max-poll";
  backgroundTasks.set(taskId, {
    dir: "/tmp/pi-task-durable-state-max-poll",
    sessionName: "task-durable-state-max-poll",
    paneId: "%11",
    originalPane: null,
    startedAt: Date.now(),
  });
  const diagnostics: string[] = [];
  const previousError = console.error;
  console.error = (...args: unknown[]) => diagnostics.push(args.map(String).join(" "));
  const stop = startBackgroundPolling(
    makeDeps({
      backgroundTasks,
      MAX_POLL_ERRORS: 1,
      checkTaskCompletion: async () => {
        throw new Error("transient poll failure");
      },
      completeTask: () => {
        throw new DurableStateError(
          "/tmp/pi-task-durable-state-max-poll/task-registry.json",
          "parse",
        );
      },
    }),
    5,
  );
  try {
    await sleep(35);
    assert.equal(backgroundTasks.has(taskId), true, t + ": task is retained");
    assert.equal(diagnostics.length, 1, t + ": diagnostic is bounded");
  } finally {
    stop();
    console.error = previousError;
  }
}

{
  const t = "DurableStateError during settlement retains the task and logs once";
  const backgroundTasks = new Map<any, any>();
  const taskId = "t-durable-state";
  backgroundTasks.set(taskId, {
    dir: "/tmp/pi-task-durable-state",
    sessionName: "task-durable-state",
    paneId: "%10",
    originalPane: null,
    startedAt: Date.now(),
  });
  let blocked = true;
  let completeCalls = 0;
  const diagnostics: string[] = [];
  const previousError = console.error;
  console.error = (...args: unknown[]) => diagnostics.push(args.map(String).join(" "));
  const stop = startBackgroundPolling(
    makeDeps({
      backgroundTasks,
      checkTaskCompletion: async () => ({ status: "completed", content: "done" }),
      completeTask: () => {
        completeCalls += 1;
        if (blocked) {
          throw new DurableStateError("/tmp/pi-task-durable-state/task-registry.json", "parse");
        }
      },
    }),
    5,
  );
  try {
    await sleep(35);
    assert.ok(completeCalls > 0, t + ": settlement was attempted");
    assert.equal(backgroundTasks.has(taskId), true, t + ": task is retained");
    assert.equal(diagnostics.length, 1, t + ": diagnostic is bounded");
    blocked = false;
    await sleep(35);
    assert.equal(backgroundTasks.has(taskId), false, t + ": task settles after repair");
  } finally {
    stop();
    console.error = previousError;
  }
}

{
  const t = "a throwing onTaskFinished retires the settled task instead of leaving a zombie";
  const backgroundTasks = new Map<string, any>();
  backgroundTasks.set("t-zombie", {
    dir: "/tmp/pi-task-zombie",
    sessionName: "task-t-zombie",
    agentType: "general",
    description: "zombie check",
    startedAt: Date.now() - 1000,
    paneId: "%9",
    backend: "tmux",
    recentCalls: [],
  });
  let completeCalls = 0;
  let finishedCalls = 0;
  const stop = startBackgroundPolling(
    makeDeps({
      backgroundTasks,
      checkTaskCompletion: async () => ({
        status: "completed",
        content: "<task_result><summary>done</summary></task_result>",
      }),
      completeTask: () => {
        completeCalls += 1;
      },
      onTaskFinished: () => {
        finishedCalls += 1;
        throw new Error("panel boom");
      },
    }),
    10,
  );
  try {
    await sleep(80);
  } finally {
    stop();
  }
  assert.ok(finishedCalls >= 1, t + ": the notification threw");
  assert.equal(completeCalls, 1, t + ": settlement ran exactly once");
  assert.equal(
    backgroundTasks.has("t-zombie"),
    false,
    t + ": settled task was retired despite the throwing callback",
  );
}

// ─── Turn-based soft limit (issue #19) ─────────────────────────────────────

function writePartialSession(dir: string, sessionName: string, text: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${sessionName}.jsonl`),
    JSON.stringify({ type: "session_info", name: sessionName }) + "\n" +
    JSON.stringify({
      type: "message",
      timestamp: new Date().toISOString(),
      message: { role: "assistant", content: [{ type: "text", text }] },
    }) + "\n",
  );
}

function makeTurnTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dir: "/tmp/pi-task-turn-limit",
    sessionName: "task-lim",
    agentType: "general",
    description: "turn limit",
    startedAt: Date.now() - 1000,
    paneId: "%7",
    backend: "tmux",
    toolUses: 0,
    turns: 12,
    recentCalls: [],
    ...overrides,
  };
}

{
  const t = "reaching the turn limit steers a wrap-up exactly once and does not settle";
  const root = mkdtempSync(join(tmpdir(), "pi-task-poll-turns-"));
  try {
    const task = makeTurnTask({
      dir: join(root, "artifacts"),
      maxTurns: 12,
    });
    writePartialSession(join(root, "artifacts", "sessions", "t1"), "task-lim", "partial findings so far");
    const backgroundTasks = new Map<string, any>([["t1", task]]);
    const steeredPrompts: string[] = [];
    let completions = 0;
    const stop = startBackgroundPolling(
      makeDeps({
        backgroundTasks,
        steerTask: (_task: any, prompt: string) => {
          steeredPrompts.push(prompt);
          return true;
        },
        checkTaskCompletion: async () => ({ status: "running", content: "" }),
        completeTask: () => {
          completions += 1;
        },
      }),
      10,
    );
    try {
      await sleep(60);
    } finally {
      stop();
    }
    assert.ok(steeredPrompts.length === 1, `${t}: wrap-up steered exactly once (got ${steeredPrompts.length})`);
    assert.ok(steeredPrompts[0]!.includes("12"), `${t}: wrap-up mentions the limit`);
    assert.equal(completions, 0, `${t}: task is not settled at the limit`);
    assert.deepEqual(
      (backgroundTasks.get("t1") as any).wrapUp,
      { turnsAtStart: 12 },
      `${t}: wrap-up anchor recorded`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const t = "exhausted wrap-up grace settles with the child's partial result";
  const root = mkdtempSync(join(tmpdir(), "pi-task-poll-grace-"));
  try {
    const task = makeTurnTask({
      dir: join(root, "artifacts"),
      maxTurns: 12,
      turns: 30,
      wrapUp: { turnsAtStart: 12 },
    });
    writePartialSession(join(root, "artifacts", "sessions", "t1"), "task-lim", "the partial findings text");
    const backgroundTasks = new Map<string, any>([["t1", task]]);
    let settledContent = "";
    let settledPhase = "";
    const stop = startBackgroundPolling(
      makeDeps({
        backgroundTasks,
        checkTaskCompletion: async () => ({ status: "running", content: "" }),
        completeTask: ({ content, phase }: any) => {
          settledContent = content;
          settledPhase = phase;
        },
      }),
      10,
    );
    try {
      await sleep(60);
    } finally {
      stop();
    }
    assert.equal(settledPhase, "timeout", `${t}: settles as timeout`);
    assert.ok(
      settledContent.includes("the partial findings text"),
      `${t}: partial result is delivered, not discarded: ${settledContent}`,
    );
    assert.ok(settledContent.includes("12-turn"), `${t}: limit note present`);
    assert.equal(backgroundTasks.has("t1"), false, `${t}: settled task retired`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const t = "failed wrap-up steering settles immediately with the partial result";
  const root = mkdtempSync(join(tmpdir(), "pi-task-poll-steerfail-"));
  try {
    const task = makeTurnTask({
      dir: join(root, "artifacts"),
      maxTurns: 12,
    });
    writePartialSession(join(root, "artifacts", "sessions", "t1"), "task-lim", "steer-fail partial text");
    const backgroundTasks = new Map<string, any>([["t1", task]]);
    let settleCount = 0;
    let settledContent = "";
    let settledPhase = "";
    const stop = startBackgroundPolling(
      makeDeps({
        backgroundTasks,
        steerTask: () => false,
        checkTaskCompletion: async () => ({ status: "running", content: "" }),
        completeTask: ({ content, phase }: any) => {
          settleCount += 1;
          settledContent = content;
          settledPhase = phase;
        },
      }),
      10,
    );
    try {
      await sleep(60);
    } finally {
      stop();
    }
    assert.equal(settleCount, 1, `${t}: settles immediately when steering fails`);
    assert.equal(settledPhase, "timeout", `${t}: timeout phase`);
    assert.ok(
      settledContent.includes("steer-fail partial text"),
      `${t}: partial result delivered: ${settledContent}`,
    );
    assert.equal(backgroundTasks.has("t1"), false, `${t}: task retired`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const t = "no turn limit means no steering and no settlement";
  const backgroundTasks = new Map<string, any>([
    ["t1", makeTurnTask({ turns: 500 })],
  ]);
  const steered: string[] = [];
  let completions = 0;
  const stop = startBackgroundPolling(
    makeDeps({
      backgroundTasks,
      steerTask: (_task: any, prompt: string) => {
        steered.push(prompt);
        return true;
      },
      checkTaskCompletion: async () => ({ status: "running", content: "" }),
      completeTask: () => {
        completions += 1;
      },
    }),
    10,
  );
  try {
    await sleep(60);
  } finally {
    stop();
  }
  assert.equal(steered.length, 0, `${t}: no wrap-up without a limit`);
  assert.equal(completions, 0, `${t}: task keeps running`);
}

{
  const t = "a child that completes during wrap-up settles through the normal done path";
  const backgroundTasks = new Map<string, any>([
    [
      "t1",
      makeTurnTask({
        maxTurns: 12,
        turns: 13,
        wrapUp: { turnsAtStart: 12 },
      }),
    ],
  ]);
  let settledPhase = "";
  let settledContent = "";
  const stop = startBackgroundPolling(
    makeDeps({
      backgroundTasks,
      checkTaskCompletion: async () => ({
        status: "completed",
        content: "<task_result><summary>wrapped up cleanly</summary></task_result>",
      }),
      completeTask: ({ content, phase }: any) => {
        settledPhase = phase;
        settledContent = content;
      },
    }),
    10,
  );
  try {
    await sleep(60);
  } finally {
    stop();
  }
  assert.equal(settledPhase, "done", `${t}: normal completion wins during wrap-up`);
  assert.ok(settledContent.includes("wrapped up cleanly"), `${t}: real result delivered`);
}

// ─── Claude turn counting feeds the max_turns wrap-up (issue #22) ──────────

function writeClaudeTranscript(lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-task-poll-claude-"));
  const file = join(dir, "transcript.jsonl");
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return file;
}

function claudeAssistant(stopReason: string | null): Record<string, unknown> {
  return {
    type: "assistant",
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      stop_reason: stopReason,
      content: [{ type: "text", text: "working" }],
    },
  };
}

{
  const t = "claude task turns come from the transcript and steer wrap-up at maxTurns";
  // Two completed assistant turns on record; checkTaskCompletion still says
  // running (Claude children announce completion only via the transcript),
  // so the ONLY way the limit can trip is the transcript-derived turn count.
  const transcript = writeClaudeTranscript([
    claudeAssistant("tool_use"),
    claudeAssistant("end_turn"),
  ]);
  try {
    const task = makeTurnTask({
      runtime: "claude",
      claudeSessionFile: transcript,
      maxTurns: 2,
      turns: 0,
    });
    const backgroundTasks = new Map<string, any>([["t1", task]]);
    const steeredPrompts: string[] = [];
    let completions = 0;
    const statsStop: ReturnType<typeof setInterval> = startToolStatsPolling(
      new Map(),
      backgroundTasks as Map<string, any>,
      5,
    );
    const pollStop = startBackgroundPolling(
      makeDeps({
        backgroundTasks,
        steerTask: (_task: any, prompt: string) => {
          steeredPrompts.push(prompt);
          return true;
        },
        checkTaskCompletion: async () => ({ status: "running", content: "" }),
        completeTask: () => {
          completions += 1;
        },
      }),
      10,
    );
    try {
      await sleep(60);
    } finally {
      clearInterval(statsStop);
      pollStop();
    }
    assert.equal(
      (backgroundTasks.get("t1") as any).turns,
      2,
      `${t}: startToolStatsPolling set turns via claudeTurnCount`,
    );
    assert.ok(steeredPrompts.length === 1, `${t}: wrap-up steered exactly once (got ${steeredPrompts.length})`);
    assert.ok(steeredPrompts[0]!.includes("2"), `${t}: wrap-up mentions the limit`);
    assert.equal(completions, 0, `${t}: task is not settled at the limit`);
  } finally {
    rmSync(dirname(transcript), { recursive: true, force: true });
  }
}

{
  const t = "claude in-flight turns (null stop_reason) do not count toward the limit";
  const transcript = writeClaudeTranscript([
    claudeAssistant("tool_use"),
    claudeAssistant(null),
  ]);
  try {
    const backgroundTasks = new Map<string, any>([
      ["t1", makeTurnTask({ runtime: "claude", claudeSessionFile: transcript, maxTurns: 2, turns: 0 })],
    ]);
    const steeredPrompts: string[] = [];
    const statsStop: ReturnType<typeof setInterval> = startToolStatsPolling(new Map(), backgroundTasks as Map<string, any>, 5);
    const pollStop = startBackgroundPolling(
      makeDeps({
        backgroundTasks,
        steerTask: (_task: any, prompt: string) => {
          steeredPrompts.push(prompt);
          return true;
        },
        checkTaskCompletion: async () => ({ status: "running", content: "" }),
        completeTask: () => {},
      }),
      10,
    );
    try {
      await sleep(60);
    } finally {
      clearInterval(statsStop);
      pollStop();
    }
    assert.equal((backgroundTasks.get("t1") as any).turns, 1, `${t}: only explicit stop_reasons counted`);
    assert.equal(steeredPrompts.length, 0, `${t}: limit not reached, no wrap-up`);
  } finally {
    rmSync(dirname(transcript), { recursive: true, force: true });
  }
}

{
  const t = "tool stats preserve live durable event activity";
  const task = makeTurnTask({
    backend: "durable",
    toolUses: 2,
    turns: 3,
    recentCalls: [
      { id: "call-durable", name: "read", detail: "README.md", status: "in_progress" },
    ],
  });
  const backgroundTasks = new Map<string, any>([["t-durable", task]]);
  const statsStop = startToolStatsPolling(new Map(), backgroundTasks, 5);
  try {
    await sleep(30);
  } finally {
    clearInterval(statsStop);
  }
  assert.equal(task.toolUses, 2, `${t}: durable tool count is not replaced by JSONL polling`);
  assert.equal(task.turns, 3, `${t}: durable turn count stays event-owned`);
  assert.equal(task.recentCalls[0]?.status, "in_progress", `${t}: active tool state remains visible`);
}

// ─── Per-request turn budget (issue #30) ───────────────────────────────────

function assistantTurnLine(text: string): string {
  return JSON.stringify({
    type: "message",
    timestamp: new Date().toISOString(),
    message: { role: "assistant", content: [{ type: "text", text }] },
  }) + "\n";
}

function writeTurns(dir: string, sessionName: string, count: number): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${sessionName}.jsonl`),
    JSON.stringify({ type: "session_info", name: sessionName }) + "\n" +
    Array.from({ length: count }, (_, i) => assistantTurnLine(`turn ${i}`)).join(""),
  );
}

function appendTurns(dir: string, sessionName: string, count: number): void {
  appendFileSync(
    join(dir, `${sessionName}.jsonl`),
    Array.from({ length: count }, (_, i) => assistantTurnLine(`new ${i}`)).join(""),
  );
}

function registryEntryFor(root: string, id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    agentType: "general",
    description: "turn budget",
    sessionName: "task-lim",
    startedAt: Date.now() - 1000,
    piDir: root,
    dir: join(root, "artifacts"),
    ...extra,
  };
}

const scenarioFailures: string[] = [];
async function scenario(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    scenarioFailures.push(error instanceof Error ? error.message : String(error));
  }
}

await scenario(async () => {
  const t = "the soft limit counts turns since the request baseline, not lifetime turns";
  const root = mkdtempSync(join(tmpdir(), "pi-task-poll-baseline-"));
  try {
    const sessionDir = join(root, "artifacts", "sessions", "t1");
    writeTurns(sessionDir, "task-lim", 3); // historic turns from earlier requests
    const task = makeTurnTask({
      dir: join(root, "artifacts"),
      maxTurns: 3,
      turns: 0,
      turnBaseline: 3,
    });
    const backgroundTasks = new Map<string, any>([["t1", task]]);
    const steered: string[] = [];
    let completions = 0;
    const statsStop = startToolStatsPolling(new Map(), backgroundTasks, 5);
    const stop = startBackgroundPolling(
      makeDeps({
        backgroundTasks,
        piDir: root,
        steerTask: (_task: any, prompt: string) => {
          steered.push(prompt);
          return true;
        },
        checkTaskCompletion: async () => ({ status: "running", content: "" }),
        completeTask: () => {
          completions += 1;
        },
      }),
      10,
    );
    try {
      await sleep(80);
      assert.equal(task.turns, 3, `${t}: lifetime turns stay lifetime`);
      assert.equal(steered.length, 0, `${t}: historic turns do not trigger the wrap-up`);
      appendTurns(sessionDir, "task-lim", 2);
      await sleep(80);
      assert.equal(task.turns, 5, `${t}: tracker counts lifetime turns`);
      assert.equal(steered.length, 0, `${t}: 2 new turns are below the 3-turn limit`);
      appendTurns(sessionDir, "task-lim", 1);
      await sleep(80);
    } finally {
      clearInterval(statsStop);
      stop();
    }
    assert.equal(steered.length, 1, `${t}: wrap-up fires after 3 new turns`);
    assert.deepEqual(task.wrapUp, { turnsAtStart: 6 }, `${t}: anchor stays in lifetime units`);
    assert.equal(completions, 0, `${t}: grace keeps the task running`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await scenario(async () => {
  const t = "wrap-up grace stays in absolute lifetime turns with a request baseline";
  const root = mkdtempSync(join(tmpdir(), "pi-task-poll-grace-abs-"));
  try {
    writeTurns(join(root, "artifacts", "sessions", "t1"), "task-lim", 1);
    const task = makeTurnTask({
      dir: join(root, "artifacts"),
      maxTurns: 3,
      turns: 14,
      turnBaseline: 10,
      wrapUp: { turnsAtStart: 13 },
    });
    const backgroundTasks = new Map<string, any>([["t1", task]]);
    let settled = 0;
    const stop = startBackgroundPolling(
      makeDeps({
        backgroundTasks,
        piDir: root,
        checkTaskCompletion: async () => ({ status: "running", content: "" }),
        completeTask: () => {
          settled += 1;
        },
      }),
      10,
    );
    try {
      await sleep(60);
      assert.equal(settled, 0, `${t}: 1 turn after the anchor is within grace`);
      task.turns = 23; // anchor 13 + WRAP_UP_GRACE_TURNS
      await sleep(60);
    } finally {
      stop();
    }
    assert.equal(settled, 1, `${t}: settles once absolute grace is exhausted`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await scenario(async () => {
  const t = "wrap-up state is persisted before the steer is sent";
  const root = mkdtempSync(join(tmpdir(), "pi-task-poll-persist-"));
  try {
    const registryFile = join(root, "task-registry.json");
    writeFileSync(registryFile, JSON.stringify([registryEntryFor(root, "t1", { maxTurns: 3 })]));
    writeTurns(join(root, "artifacts", "sessions", "t1"), "task-lim", 5);
    const task = makeTurnTask({
      dir: join(root, "artifacts"),
      maxTurns: 3,
      turns: 5,
      turnBaseline: 2,
    });
    const backgroundTasks = new Map<string, any>([["t1", task]]);
    let registryAtSteer: any;
    let steers = 0;
    const stop = startBackgroundPolling(
      makeDeps({
        backgroundTasks,
        piDir: root,
        steerTask: () => {
          steers += 1;
          registryAtSteer = JSON.parse(readFileSync(registryFile, "utf8"))[0];
          return true;
        },
        checkTaskCompletion: async () => ({ status: "running", content: "" }),
      }),
      10,
    );
    try {
      await sleep(80);
    } finally {
      stop();
    }
    assert.equal(steers, 1, `${t}: steered once`);
    assert.deepEqual(registryAtSteer?.wrapUp, { turnsAtStart: 5 }, `${t}: registry already holds wrapUp at steer time`);
    const final = JSON.parse(readFileSync(registryFile, "utf8"))[0];
    assert.equal(final.maxTurns, 3, `${t}: other registry fields untouched`);
    assert.equal(final.dir, join(root, "artifacts"), `${t}: registry entry otherwise intact`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await scenario(async () => {
  const t = "a failing wrap-up persistence write still steers (once) instead of looping";
  const root = mkdtempSync(join(tmpdir(), "pi-task-poll-persistfail-"));
  try {
    writeFileSync(join(root, "task-registry.json"), "{not-json");
    writeTurns(join(root, "artifacts", "sessions", "t1"), "task-lim", 5);
    const task = makeTurnTask({
      dir: join(root, "artifacts"),
      maxTurns: 3,
      turns: 5,
    });
    const backgroundTasks = new Map<string, any>([["t1", task]]);
    let steers = 0;
    let completions = 0;
    const stop = startBackgroundPolling(
      makeDeps({
        backgroundTasks,
        piDir: root,
        steerTask: () => {
          steers += 1;
          return true;
        },
        checkTaskCompletion: async () => ({ status: "running", content: "" }),
        completeTask: () => {
          completions += 1;
        },
      }),
      10,
    );
    const originalError = console.error;
    console.error = () => {};
    try {
      await sleep(120);
    } finally {
      console.error = originalError;
      stop();
    }
    assert.equal(steers, 1, `${t}: steered exactly once despite the write failure`);
    assert.equal(completions, 0, `${t}: no poll-error settlement`);
    assert.deepEqual(task.wrapUp, { turnsAtStart: 5 }, `${t}: in-memory wrap-up recorded`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await scenario(async () => {
  const t = "a stale polled task never steers, persists, or overwrites a renewed budget";
  const root = mkdtempSync(join(tmpdir(), "pi-task-poll-stale-"));
  try {
    const registryFile = join(root, "task-registry.json");
    const initialRegistry = JSON.stringify([registryEntryFor(root, "t1", { turnBaseline: 10 })]);
    writeFileSync(registryFile, initialRegistry);
    writeTurns(join(root, "artifacts", "sessions", "t1"), "task-lim", 10);
    const stale = makeTurnTask({ dir: join(root, "artifacts"), maxTurns: 3, turns: 10 });
    const renewed = makeTurnTask({
      dir: join(root, "artifacts"),
      maxTurns: 3,
      turns: 10,
      turnBaseline: 10,
    });
    const backgroundTasks = new Map<string, any>();
    // Fill every worker with a gated sibling so the target is dequeued only
    // after the map entry has been replaced.
    const blockers = Array.from({ length: BACKGROUND_POLL_CONCURRENCY }, (_, i) => `blocker-${i}`);
    for (const id of blockers) backgroundTasks.set(id, makeTurnTask({ dir: join(root, "artifacts") }));
    backgroundTasks.set("t1", stale);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const steered: string[] = [];
    const stop = startBackgroundPolling(
      makeDeps({
        backgroundTasks,
        piDir: root,
        steerTask: (_task: any, prompt: string) => {
          steered.push(prompt);
          return true;
        },
        checkTaskCompletion: async ({ taskId }: any) => {
          if (blockers.includes(taskId)) await gate;
          return { status: "running", content: "" };
        },
      }),
      10,
    );
    try {
      await sleep(40);
      backgroundTasks.set("t1", renewed);
      release();
      await sleep(80);
    } finally {
      release();
      stop();
    }
    assert.equal(steered.length, 0, `${t}: no steer from the stale or renewed task`);
    assert.equal(stale.wrapUp, undefined, `${t}: stale object takes no wrap-up state`);
    assert.equal(renewed.wrapUp, undefined, `${t}: renewed budget untouched`);
    assert.equal(readFileSync(registryFile, "utf8"), initialRegistry, `${t}: registry untouched`);
    assert.equal(backgroundTasks.get("t1"), renewed, `${t}: renewed task stays tracked`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

if (scenarioFailures.length > 0) {
  for (const failure of scenarioFailures) console.error(`FAIL: ${failure}`);
  throw new Error(`${scenarioFailures.length} per-request turn budget scenario(s) failed`);
}

console.log("ALL POLLING TESTS PASSED");
