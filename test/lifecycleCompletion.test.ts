import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  readRegistry,
  readTaskSessionHistory,
  writeRegistry,
} from "../src/conversation.js";
import { completeTask } from "../src/lifecycle/completion.js";
import type { BackgroundTask } from "../src/types.js";

test("completion preserves the child-reported outcome separately from execution", () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-completion-status-"));
  const task: BackgroundTask = {
    dir: join(piDir, "artifacts", "tasks", "task-2"),
    agentType: "general",
    sessionName: "task-task-2",
    originalPane: null,
    description: "reported status",
    startedAt: Date.now() - 1000,
    toolUses: 0,
    turns: 0,
  };
  let details: Record<string, unknown> | undefined;

  completeTask(
    {
      sendMessage: (message: { details: Record<string, unknown> }) => {
        details = message.details;
      },
    } as never,
    "task-2",
    task,
    "<status>failure</status>\n<summary>Tests failed</summary>",
    "done",
    piDir,
  );

  const history = readTaskSessionHistory(piDir);
  assert.equal(history[0]?.status, "done");
  assert.equal(history[0]?.reportedStatus, "failure");
  assert.equal(history[0]?.resultValid, true);
  assert.equal(details?.status, "failure");
  assert.equal(details?.execution_phase, "done");
  assert.equal(details?.reported_status, "failure");
  assert.equal(details?.result_valid, true);
});

test("cancellation is persisted before its resource cleanup", () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-cancel-completion-"));
  const task: BackgroundTask = {
    dir: join(piDir, "artifacts", "tasks", "task-cancel"),
    agentType: "explore",
    sessionName: "task-task-cancel",
    paneId: "w1:p3",
    originalPane: null,
    description: "cancel ordering",
    startedAt: Date.now() - 1000,
    toolUses: 0,
    turns: 0,
  };
  writeRegistry(piDir, [{
    id: "task-cancel",
    agentType: task.agentType,
    description: task.description,
    sessionName: task.sessionName,
    startedAt: task.startedAt,
    paneId: task.paneId,
    piDir,
    dir: task.dir,
  }]);

  let cleanupObservedCancellation = false;
  completeTask(
    { sendMessage: () => {} } as never,
    "task-cancel",
    task,
    "Task was cancelled by request.",
    "cancelled",
    piDir,
    () => {
      cleanupObservedCancellation = readRegistry(piDir).some((entry) =>
        entry.id === "task-cancel" && entry.cleanupPending === true
      ) && readTaskSessionHistory(piDir).some((entry) => entry.id === "task-cancel" && entry.status === "cancelled");
    },
  );

  assert.equal(cleanupObservedCancellation, true);
  assert.equal(readTaskSessionHistory(piDir)[0]?.status, "cancelled");
});

test("completion is persisted and leaves cleanup pending when pane cleanup fails", () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-completion-"));
  const task: BackgroundTask = {
    dir: join(piDir, "artifacts", "tasks", "task-1"),
    agentType: "general",
    sessionName: "task-task-1",
    paneId: "w1:p2",
    originalPane: null,
    description: "completion ordering",
    startedAt: Date.now() - 1000,
    toolUses: 0,
    turns: 0,
  };
  writeRegistry(piDir, [{
    id: "task-1",
    agentType: "general",
    description: task.description,
    sessionName: task.sessionName,
    startedAt: task.startedAt,
    paneId: task.paneId,
    piDir,
    dir: task.dir,
  }]);

  let cleanupObservedDurableState = false;
  let notificationSent = false;
  const pi = {
    sendMessage: () => {
      notificationSent = true;
    },
  };

  completeTask(
    pi as never,
    "task-1",
    task,
    "<task_result><summary>done</summary></task_result>",
    "done",
    piDir,
    () => {
      cleanupObservedDurableState = readRegistry(piDir).some((entry) =>
        entry.id === "task-1" && entry.cleanupPending === true
      ) && readTaskSessionHistory(piDir).some((entry) => entry.id === "task-1" && entry.status === "done");
      throw new Error("simulated cleanup failure");
    },
  );

  assert.equal(cleanupObservedDurableState, true);
  assert.equal(notificationSent, true);
  assert.equal(readRegistry(piDir)[0]?.cleanupPending, true);
});

test("completion notification defaults to a follow-up turn", () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-completion-delivery-"));
  const task: BackgroundTask = {
    dir: join(piDir, "artifacts", "tasks", "task-default"),
    agentType: "general",
    sessionName: "task-task-default",
    originalPane: null,
    description: "default delivery",
    startedAt: Date.now() - 1000,
    toolUses: 0,
    turns: 0,
  };
  let options: unknown;
  const previous = process.env.PI_TASK_COMPLETION_DELIVERY;
  delete process.env.PI_TASK_COMPLETION_DELIVERY;
  try {
    completeTask(
      {
        sendMessage: (_message: unknown, opts: unknown) => {
          options = opts;
        },
      } as never,
      "task-default",
      task,
      "<summary>done</summary>",
      "done",
      piDir,
    );
  } finally {
    if (previous === undefined) delete process.env.PI_TASK_COMPLETION_DELIVERY;
    else process.env.PI_TASK_COMPLETION_DELIVERY = previous;
  }
  assert.deepEqual(options, { triggerTurn: true, deliverAs: "followUp" });
});

test("completion notification defers to the next user turn when configured", () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-completion-nextturn-"));
  const task: BackgroundTask = {
    dir: join(piDir, "artifacts", "tasks", "task-nextturn"),
    agentType: "explore",
    sessionName: "task-task-nextturn",
    originalPane: null,
    description: "deferred delivery",
    startedAt: Date.now() - 1000,
    toolUses: 0,
    turns: 0,
  };
  let options: unknown;
  const previous = process.env.PI_TASK_COMPLETION_DELIVERY;
  process.env.PI_TASK_COMPLETION_DELIVERY = "nextTurn";
  try {
    completeTask(
      {
        sendMessage: (_message: unknown, opts: unknown) => {
          options = opts;
        },
      } as never,
      "task-nextturn",
      task,
      "<summary>done</summary>",
      "done",
      piDir,
    );
  } finally {
    if (previous === undefined) delete process.env.PI_TASK_COMPLETION_DELIVERY;
    else process.env.PI_TASK_COMPLETION_DELIVERY = previous;
  }
  assert.deepEqual(options, { triggerTurn: true, deliverAs: "nextTurn" });
});
