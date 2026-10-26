import { strict as assert } from "node:assert";
import test from "node:test";

import { formatBackgroundReceipt, taskStateLine } from "../src/helpers.js";
import { formatDurableBackgroundReceipt } from "../src/lifecycle/durable-execution.js";
import { lostCompletionNotice } from "../src/lifecycle/completion.js";
import { formatSdkBackgroundReceipt } from "../src/subagent/sdkBackground.js";

test("taskStateLine states the task id and state on one line", () => {
  assert.equal(taskStateLine("t-1", "running"), '<task id="t-1" state="running"/>');
  assert.equal(taskStateLine("t-1", "timeout"), '<task id="t-1" state="timeout"/>');
});

test("every background receipt opens with a running state line", () => {
  const line = taskStateLine("t-9", "running");
  assert.ok(formatSdkBackgroundReceipt("t-9").startsWith(`${line}\n`));
  assert.ok(formatDurableBackgroundReceipt("t-9").startsWith(`${line}\n`));
  assert.ok(
    formatBackgroundReceipt({ taskId: "t-9", agentType: "scout", sessionPath: "/s" }).startsWith(`${line}\n`),
  );
});

test("a replayed notice opens with the task's finished state", () => {
  const notice = lostCompletionNotice({
    id: "t-9",
    agentType: "scout",
    description: "d",
    sessionName: "task-t-9",
    startedAt: 1,
    piDir: "/pi",
    dir: "/pi/a",
    status: "failed",
    background: true,
  });
  assert.ok(notice.content.startsWith(`${taskStateLine("t-9", "failed")}\n`));
});
