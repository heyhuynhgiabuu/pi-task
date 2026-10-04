import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { startBackgroundPolling } from "../src/lifecycle/polling";

test("tmux polling ignores SDK-managed background tasks", async () => {
  const backgroundTasks = new Map([
    [
      "sdk-1",
      {
        backend: "sdk",
        dir: "/tmp/pi-task-artifacts",
        sessionName: "sdk-session",
        originalPane: null,
        startedAt: Date.now(),
      },
    ],
  ]);
  let completionChecks = 0;
  const stop = startBackgroundPolling(
    {
      backgroundTasks,
      checkTaskCompletion: async () => {
        completionChecks += 1;
        return { status: "completed", content: "wrong backend" };
      },
      clearTaskWidgetIfIdle: () => {},
      completeTask: () => {},
      hardTimeoutMs: 10_000,
      MAX_POLL_ERRORS: 3,
      piDir: "/tmp",
      pi: {},
    },
    5,
  );

  await sleep(30);
  stop();
  assert.equal(completionChecks, 0);
});

test("filesystem polling ignores durable tasks managed by pi-durable", async () => {
  const task = {
    backend: "durable",
    dir: "/tmp/pi-task-durable-artifacts",
    sessionName: "durable-session",
    originalPane: null,
    startedAt: Date.now(),
  };
  const backgroundTasks = new Map([["durable-1", task]]);
  let completionChecks = 0;
  const stop = startBackgroundPolling(
    {
      backgroundTasks,
      checkTaskCompletion: async () => {
        completionChecks += 1;
        return { status: "completed", content: "filesystem must not settle this task" };
      },
      clearTaskWidgetIfIdle: () => {},
      completeTask: () => {},
      hardTimeoutMs: 10_000,
      MAX_POLL_ERRORS: 3,
      piDir: "/tmp",
      pi: {},
    },
    5,
  );

  try {
    await sleep(30);
  } finally {
    stop();
  }
  assert.equal(completionChecks, 0);
  assert.equal(backgroundTasks.get("durable-1"), task, "the durable monitor retains its row");
});
