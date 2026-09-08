import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  readRegistry,
  readTaskSessionHistory,
  writeRegistry,
} from "../src/conversation.js";
import {
  completeTask,
  createCompletionDeliveryQueue,
} from "../src/lifecycle/completion.js";
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

  completeTask({
    pi: {
      sendMessage: (message: { details: Record<string, unknown> }) => {
        details = message.details;
      },
    } as never,
    id: "task-2",
    task: task,
    content: "<status>failure</status>\n<summary>Tests failed</summary>",
    phase: "done",
    piDir: piDir,
  });

  const history = readTaskSessionHistory(piDir);
  assert.equal(history[0]?.status, "done");
  assert.equal(history[0]?.reportedStatus, "failure");
  assert.equal(history[0]?.resultValid, true);
  assert.equal(details?.status, "failure");
  assert.equal(details?.execution_phase, "done");
  assert.equal(details?.reported_status, "failure");
  assert.equal(details?.result_valid, true);
});

test("settlement forwards the durable claudeSessionId into history", () => {
  // issue #22: completion/history records must carry the durable Claude
  // session UUID so a restart can rebuild the transcript path from
  // cwd + claudeSessionId instead of the throwaway task session name.
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-completion-claude-"));
  const task: BackgroundTask = {
    dir: join(piDir, "artifacts", "tasks", "task-claude-id"),
    agentType: "general",
    sessionName: "task-task-claude-id",
    runtime: "claude",
    claudeSessionId: "f1111111-2222-4333-8444-555555555555",
    originalPane: null,
    description: "claude id forwarding",
    startedAt: Date.now() - 1000,
    toolUses: 0,
    turns: 0,
  };
  writeRegistry(piDir, [{
    id: "task-claude-id",
    agentType: task.agentType,
    description: task.description,
    sessionName: task.sessionName,
    runtime: "claude",
    claudeSessionId: task.claudeSessionId,
    startedAt: task.startedAt,
    piDir,
    dir: task.dir,
  }]);

  completeTask({
    pi: { sendMessage: () => {} } as never,
    id: "task-claude-id",
    task,
    content: "<task_result><summary>done</summary></task_result>",
    phase: "done",
    piDir,
  });

  const history = readTaskSessionHistory(piDir)[0];
  assert.equal(history?.status, "done");
  assert.equal(
    history?.claudeSessionId,
    "f1111111-2222-4333-8444-555555555555",
    "terminal history record carries the durable UUID",
  );
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
  completeTask({
    pi: { sendMessage: () => {} } as never,
    id: "task-cancel",
    task: task,
    content: "Task was cancelled by request.",
    phase: "cancelled",
    piDir: piDir,
    resourceCloser: () => {
      cleanupObservedCancellation = readRegistry(piDir).some((entry) =>
        entry.id === "task-cancel" && entry.cleanupPending === true
      ) && readTaskSessionHistory(piDir).some((entry) => entry.id === "task-cancel" && entry.status === "cancelled");
    },
  });

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

  completeTask({
    pi: pi as never,
    id: "task-1",
    task: task,
    content: "<task_result><summary>done</summary></task_result>",
    phase: "done",
    piDir: piDir,
    resourceCloser: () => {
      cleanupObservedDurableState = readRegistry(piDir).some((entry) =>
        entry.id === "task-1" && entry.cleanupPending === true
      ) && readTaskSessionHistory(piDir).some((entry) => entry.id === "task-1" && entry.status === "done");
      throw new Error("simulated cleanup failure");
    },
  });

  assert.equal(cleanupObservedDurableState, true);
  assert.equal(notificationSent, true);
  assert.equal(readRegistry(piDir)[0]?.cleanupPending, true);
});

test("completion notification defaults to follow-up delivery", () => {
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
    completeTask({
      pi: {
        sendMessage: (_message: unknown, opts: unknown) => {
          options = opts;
        },
      } as never,
      id: "task-default",
      task: task,
      content: "<summary>done</summary>",
      phase: "done",
      piDir: piDir,
    });
  } finally {
    if (previous === undefined) delete process.env.PI_TASK_COMPLETION_DELIVERY;
    else process.env.PI_TASK_COMPLETION_DELIVERY = previous;
  }
  assert.deepEqual(options, { triggerTurn: true, deliverAs: "followUp" });
});

test("completion delivery queue batches notifications within its debounce window", async () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-completion-queue-"));
  let deliveries = 0;
  const queue = createCompletionDeliveryQueue(5);
  const task: BackgroundTask = {
    dir: join(piDir, "artifacts", "tasks", "queue-task"),
    agentType: "general",
    sessionName: "queue-task",
    startedAt: Date.now(),
    toolUses: 0,
    turns: 0,
    originalPane: null,
    description: "queued completion",
    recentCalls: [],
  };
  completeTask({
    pi: { sendMessage: () => { deliveries += 1; } } as never,
    id: "queue-task",
    task: task,
    content: "queued result",
    phase: "done",
    piDir: piDir,
    resourceCloser: () => {},
    deliveryQueue: queue,
  });
  assert.equal(deliveries, 0);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(deliveries, 1);
  queue.dispose();
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
    completeTask({
      pi: {
        sendMessage: (_message: unknown, opts: unknown) => {
          options = opts;
        },
      } as never,
      id: "task-nextturn",
      task: task,
      content: "<summary>done</summary>",
      phase: "done",
      piDir: piDir,
    });
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
  completeTask({
    pi: { sendMessage: () => {} } as never,
    id: "task-3",
    task: task,
    content: "<status>failure</status>",
    phase: "failed",
    piDir: piDir,
  });
  assert.equal(task.status, "failed", "panel rows must see the terminal phase");
});

test("completeTask is idempotent for one execution: a second call never re-delivers", () => {
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
  completeTask({
    pi: pi,
    id: "task-4",
    task: task,
    content: "first",
    phase: "done",
    piDir: piDir,
    resourceCloser: closer,
  });
  completeTask({
    pi: pi,
    id: "task-4",
    task: task,
    content: "second",
    phase: "cancelled",
    piDir: piDir,
    resourceCloser: closer,
  });
  assert.equal(deliveries, 1, "a second completeTask for one execution must not re-deliver");
  assert.equal(resourceCloses, 1, "a second completeTask for one execution must not re-close the resource");
});

test("completeTask allows a resumed task id to complete as a new run", () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-completion-resume-id-"));
  const mkTask = (startedAt: number): BackgroundTask => ({
    dir: join(piDir, "artifacts", "tasks", "reused-id"),
    agentType: "general",
    sessionName: "task-reused-id",
    originalPane: null,
    description: `run-${startedAt}`,
    startedAt,
    toolUses: 0,
    turns: 0,
  });
  let deliveries = 0;
  const pi: any = { sendMessage: () => { deliveries++; } };
  completeTask({
    pi: pi,
    id: "reused-id",
    task: mkTask(1),
    content: "first",
    phase: "done",
    piDir: piDir,
  });
  completeTask({
    pi: pi,
    id: "reused-id",
    task: mkTask(2),
    content: "second",
    phase: "done",
    piDir: piDir,
  });
  assert.equal(deliveries, 2, "a resumed run with the same id must complete independently");
  assert.equal(readTaskSessionHistory(piDir).at(-1)?.description, "run-2");
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
  completeTask({
    pi: pi,
    id: "a",
    task: mk("a"),
    content: "r1",
    phase: "done",
    piDir: piDir,
  });
  completeTask({
    pi: pi,
    id: "b",
    task: mk("b"),
    content: "r2",
    phase: "done",
    piDir: piDir,
  });
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

  assert.throws(() => completeTask({
    pi,
    id: "t-p",
    task: mk(),
    content: "x",
    phase: "done",
    piDir: badPiDir,
  }));

  // A retry with a valid piDir must still complete and deliver exactly once:
  // the earlier throw must not have poisoned the id.
  const goodPiDir = mkdtempSync(join(tmpdir(), "pi-task-completion-good-"));
  completeTask({
    pi: pi,
    id: "t-p",
    task: mk(),
    content: "x",
    phase: "done",
    piDir: goodPiDir,
  });
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

  completeTask({
    pi: {
      sendMessage: (message: { content: string; details: Record<string, unknown> }) => {
        captured = message;
      },
    } as never,
    id: "task-stalled",
    task: task,
    content: "<status>stalled</status>\n<summary>waiting on external quota</summary>",
    phase: "done",
    piDir: piDir,
  });

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

  completeTask({
    pi: {
      sendMessage: () => {
        messageDelivered = true;
      },
    } as never,
    id: "task-cmp-guard",
    task: task,
    content: "<status>done</status>\n<summary>All good</summary>",
    phase: "done",
    piDir: piDir,
    deliveryGuard: () => false,
    // deliveryGuard refuses delivery
    onComparisonSettled: (id, t, parsed, phase) => {
      comparisonSettledCalled = true;
      return true; // handled
    },
  });

  assert.equal(comparisonSettledCalled, true, "onComparisonSettled called despite deliveryGuard false");
  assert.equal(messageDelivered, false, "in-conversation delivery suppressed");
  const history = readTaskSessionHistory(piDir)[0];
  assert.equal(history?.comparisonGroupId, "group-123");
  assert.equal(history?.comparisonModel, "model-a");
  assert.equal(history?.comparisonDescription, "compare guard");
  assert.equal(history?.comparisonIndex, 0);
});

test("a failed registry-removal write never causes a resource re-close on retry", () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-completion-removal-"));
  const task: BackgroundTask = {
    dir: join(piDir, "artifacts", "tasks", "task-removal"),
    agentType: "general",
    sessionName: "task-task-removal",
    originalPane: null,
    description: "removal write fails",
    startedAt: Date.now() - 1000,
    toolUses: 0,
    turns: 0,
  };
  writeRegistry(piDir, [{
    id: "task-removal",
    agentType: "general",
    description: task.description,
    sessionName: task.sessionName,
    startedAt: task.startedAt,
    paneId: task.paneId,
    piDir,
    dir: task.dir,
  }]);

  let closeCount = 0;
  let sawReceipt = false;
  let sawRemoval = false;
  const failRemovalWrite = (dir: string, entries: [{ id: string; cleanupPending?: boolean }]) => {
    sawReceipt = sawReceipt || entries.some((e) => e.id === "task-removal" && e.cleanupPending === true);
    if (!entries.some((e) => e.id === "task-removal")) {
      sawRemoval = true;
      throw new Error("removal write boom");
    }
    void dir;
  };

  const pi = { sendMessage: () => {} };
  const first = completeTask({
    pi: pi as never,
    id: "task-removal",
    task,
    content: "<task_result><summary>done</summary></task_result>",
    phase: "done",
    piDir,
    resourceCloser: () => {
      closeCount += 1;
    },
    writeRegistryFn: failRemovalWrite as never,
  });
  assert.equal(first.cleanupSucceeded, true, "close succeeded despite removal write failure");
  assert.equal(sawReceipt, true, "cleanup receipt was written before the removal attempt");
  assert.equal(sawRemoval, true, "removal write was attempted");

  // A retry after the failed removal must be a no-op: the id was marked
  // settled before the removal write, so the resource is never re-closed.
  completeTask({
    pi: pi as never,
    id: "task-removal",
    task: task,
    content: "<task_result><summary>done</summary></task_result>",
    phase: "done",
    piDir: piDir,
    resourceCloser: () => {
      closeCount += 1;
    },
    writeRegistryFn: failRemovalWrite as never,
  });
  assert.equal(closeCount, 1, "resource closed exactly once");
});

test("a broken registry blocks terminal history writes so phases cannot flap", () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-completion-regflap-"));
  const task: BackgroundTask = {
    dir: join(piDir, "artifacts", "tasks", "task-flap"),
    agentType: "general",
    sessionName: "task-task-flap",
    originalPane: null,
    description: "registry flap",
    startedAt: Date.now() - 1000,
    toolUses: 0,
    turns: 0,
  };
  // Occupy the registry path with a directory: every registry write fails.
  mkdirSync(join(piDir, "task-registry.json"), { recursive: true });
  const pi = { sendMessage: () => {} };

  assert.throws(() =>
    completeTask({
      pi: pi as never,
      id: "task-flap",
      task: task,
      content: "<task_result><summary>done</summary></task_result>",
      phase: "done",
      piDir: piDir,
    }),
  );

  // No terminal record may exist when the registry is unreadable: otherwise a
  // poll-error fallback would rewrite done -> failed on every retry tick.
  assert.equal(
    readTaskSessionHistory(piDir).some((entry) => entry.id === "task-flap"),
    false,
    "no durable terminal phase while the registry is broken",
  );
});

test("settlement carries the registry entry's session ownership into history", () => {
  // A background comparison task gets a running record at spawn and its
  // first REPLAYABLE (settled) record at settlement — running records never
  // produce replay runs. The settle upsert must therefore copy the ownership
  // from the registry entry (issue #20) — otherwise settled comparison
  // history stays ownerless and the replay ownership filter is dead code.
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-completion-owner-"));
  writeRegistry(piDir, [
    {
      id: "task-cmp-m0",
      agentType: "reviewer",
      description: "Review [model-a]",
      sessionName: "task-task-cmp-m0",
      startedAt: Date.now() - 1000,
      paneId: "%cmp",
      piDir,
      dir: join(piDir, "artifacts", "tasks"),
      ownerSessionId: "sess-a",
      ownerLeafId: "leaf-a",
      ownerPid: 4242,
      comparisonGroupId: "cmp-group",
      comparisonModel: "model-a",
      comparisonDescription: "Review",
      comparisonIndex: 0,
    },
  ]);
  const task: BackgroundTask = {
    dir: join(piDir, "artifacts", "tasks"),
    agentType: "reviewer",
    sessionName: "task-task-cmp-m0",
    paneId: "%cmp",
    originalPane: null,
    description: "Review [model-a]",
    startedAt: Date.now() - 1000,
    toolUses: 0,
    turns: 0,
    comparisonGroupId: "cmp-group",
    comparisonModel: "model-a",
    comparisonDescription: "Review",
    comparisonIndex: 0,
  };

  completeTask({
    pi: { sendMessage: () => {} } as never,
    id: "task-cmp-m0",
    task: task,
    content: "<status>success</status>\n<summary>done</summary>",
    phase: "done",
    piDir: piDir,
  });

  const history = readTaskSessionHistory(piDir);
  assert.equal(history[0]?.ownerSessionId, "sess-a", "history records the owning session");
  assert.equal(history[0]?.ownerLeafId, "leaf-a", "history records the owning leaf");
  assert.equal(history[0]?.ownerPid, 4242, "history records the owning pid");
});
