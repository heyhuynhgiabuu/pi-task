import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
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

test("completion notification defaults to adaptive steer delivery", () => {
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
  assert.deepEqual(options, { triggerTurn: true, deliverAs: "steer" });
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

test("completeTask records the terminal phase on the live task object", () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-completion-phase-"));
  const task: BackgroundTask = {
    dir: join(piDir, "artifacts", "tasks", "task-3"),
    agentType: "general",
    sessionName: "task-task-3",
    originalPane: null,
    description: "phase plumbing",
    startedAt: Date.now() - 1000,
    toolUses: 0,
    turns: 0,
  };
  completeTask(
    { sendMessage: () => {} } as never,
    "task-3",
    task,
    "<status>failure</status>",
    "failed",
    piDir,
  );
  assert.equal(task.status, "failed", "panel rows must see the terminal phase");
});

test("completeTask is idempotent per task id: a second call never re-delivers", () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-completion-idempotent-"));
  const task: BackgroundTask = {
    dir: join(piDir, "artifacts", "tasks", "task-4"),
    agentType: "general",
    sessionName: "task-task-4",
    originalPane: null,
    description: "idempotency",
    startedAt: Date.now() - 1000,
    toolUses: 0,
    turns: 0,
  };
  let deliveries = 0;
  let resourceCloses = 0;
  const pi: any = { sendMessage: () => { deliveries++; } };
  const closer = () => { resourceCloses++; };
  completeTask(pi, "task-4", task, "first", "done", piDir, closer);
  completeTask(pi, "task-4", task, "second", "cancelled", piDir, closer);
  assert.equal(deliveries, 1, "a second completeTask for the same id must not re-deliver");
  assert.equal(resourceCloses, 1, "a second completeTask must not re-close the resource");
});

test("completeTask still allows distinct task ids to complete independently", () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-completion-distinct-"));
  const mk = (id: string): BackgroundTask => ({
    dir: join(piDir, "artifacts", "tasks", id),
    agentType: "general",
    sessionName: `task-${id}`,
    originalPane: null,
    description: "distinct",
    startedAt: Date.now() - 1000,
    toolUses: 0,
    turns: 0,
  });
  let deliveries = 0;
  const pi: any = { sendMessage: () => { deliveries++; } };
  completeTask(pi, "a", mk("a"), "r1", "done", piDir);
  completeTask(pi, "b", mk("b"), "r2", "done", piDir);
  assert.equal(deliveries, 2, "distinct task ids must each deliver once");
});

test("a completeTask that throws mid-writes does not poison the idempotency guard", () => {
  const base = mkdtempSync(join(tmpdir(), "pi-task-completion-poison-"));
  // piDir pointing at an existing FILE makes the durable writes throw.
  const badPiDir = join(base, "not-a-dir");
  writeFileSync(badPiDir, "");
  const mk = (): BackgroundTask => ({
    dir: join(base, "artifacts", "tasks", "t-p"),
    agentType: "general",
    sessionName: "task-t-p",
    originalPane: null,
    description: "poison",
    startedAt: Date.now() - 1000,
    toolUses: 0,
    turns: 0,
  });
  let deliveries = 0;
  const pi: any = { sendMessage: () => { deliveries++; } };

  assert.throws(() => completeTask(pi, "t-p", mk(), "x", "done", badPiDir));

  // A retry with a valid piDir must still complete and deliver exactly once:
  // the earlier throw must not have poisoned the id.
  const goodPiDir = mkdtempSync(join(tmpdir(), "pi-task-completion-good-"));
  completeTask(pi, "t-p", mk(), "x", "done", goodPiDir);
  assert.equal(deliveries, 1, "retry after a mid-write throw must still deliver");
});

test("completion surfaces an unrecognized child status word to the parent", () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-completion-raw-status-"));
  const task: BackgroundTask = {
    dir: join(piDir, "artifacts", "tasks", "task-stalled"),
    agentType: "general",
    sessionName: "task-task-stalled",
    originalPane: null,
    description: "raw status word",
    startedAt: Date.now() - 1000,
    toolUses: 0,
    turns: 0,
  };
  let captured: { content: string; details: Record<string, unknown> } | undefined;

  completeTask(
    {
      sendMessage: (message: { content: string; details: Record<string, unknown> }) => {
        captured = message;
      },
    } as never,
    "task-stalled",
    task,
    "<status>stalled</status>\n<summary>waiting on external quota</summary>",
    "done",
    piDir,
  );

  assert.ok(captured, "notification delivered");
  assert.match(captured!.content, /"stalled"/, "raw status word reaches parent content");
  assert.match(captured!.content, /waiting on external quota/, "summary retained");
  assert.equal(captured!.details.status, "unknown", "normalized status in details");
  assert.equal(captured!.details.raw_status, "stalled", "raw status in details");
  const structured = captured!.details.structured_result as Record<string, unknown>;
  assert.equal(typeof structured, "object", "structured_result is an object");
  assert.equal(structured.valid, false, "structured_result.valid");
  assert.equal(structured.raw_status, "stalled", "structured_result.raw_status");
  const history = readTaskSessionHistory(piDir);
  assert.equal(history[0]?.rawStatus, "stalled", "history keeps the raw status word");
});

test("onComparisonSettled hook is invoked even when deliveryGuard refuses in-conversation delivery", () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-comp-guard-"));
  const task: BackgroundTask = {
    dir: join(piDir, "artifacts", "tasks", "task-cmp-guard"),
    agentType: "reviewer",
    sessionName: "task-task-cmp-guard",
    originalPane: null,
    description: "compare guard check",
    startedAt: Date.now() - 1000,
    toolUses: 0,
    turns: 0,
    comparisonGroupId: "group-123",
    comparisonModel: "model-a",
    comparisonDescription: "compare guard",
    comparisonIndex: 0,
  };
  let comparisonSettledCalled = false;
  let messageDelivered = false;

  completeTask(
    {
      sendMessage: () => {
        messageDelivered = true;
      },
    } as never,
    "task-cmp-guard",
    task,
    "<status>done</status>\n<summary>All good</summary>",
    "done",
    piDir,
    undefined,
    () => false, // deliveryGuard refuses delivery
    (id, t, parsed, phase) => {
      comparisonSettledCalled = true;
      return true; // handled
    },
  );

  assert.equal(comparisonSettledCalled, true, "onComparisonSettled called despite deliveryGuard false");
  assert.equal(messageDelivered, false, "in-conversation delivery suppressed");
  const history = readTaskSessionHistory(piDir)[0];
  assert.equal(history?.comparisonGroupId, "group-123");
  assert.equal(history?.comparisonModel, "model-a");
  assert.equal(history?.comparisonDescription, "compare guard");
  assert.equal(history?.comparisonIndex, 0);
});
