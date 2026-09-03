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
      TASK_TIMEOUT_MS: 10_000,
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
