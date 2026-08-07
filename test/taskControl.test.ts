import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Value } from "typebox/value";
import { readRegistry, upsertTaskSessionHistory, writeRegistry } from "../src/conversation.js";
import { completeTask as persistCompletedTask } from "../src/lifecycle/completion.js";
import { handleTaskControl } from "../src/task-control-api.js";
import { taskParametersSchema } from "../src/tool/schema.js";
import {
  decideCancellation,
  findTaskRecord,
  fromHistoryEntry,
  parseTaskControlRequest,
  parseTaskStartRequest,
  fromRegistryEntry,
  type TaskControlRecord,
} from "../src/task-control.js";

test("task control requests accept status and cancel without start fields", () => {
  const schema = taskParametersSchema();

  assert.equal(schema.type, "object");
  assert.ok("properties" in schema);
  assert.equal("anyOf" in schema, false);
  assert.equal(Value.Check(schema, { operation: "status", task_id: "task-1" }), true);
  assert.equal(Value.Check(schema, { operation: "cancel", task_id: "task-1" }), true);
  assert.equal(Value.Check(schema, { operation: "status" }), true);
  assert.equal(parseTaskControlRequest({ operation: "status" }), undefined);
});

test("task start requests remain valid when operation is omitted", () => {
  const schema = taskParametersSchema();

  assert.equal(
    Value.Check(schema, {
      agent_type: "explore",
      description: "Inspect the repository",
      prompt: "Map the repository and return evidence.",
    }),
    true,
  );
});

test("task start parsing supplies runtime validation for the flat provider schema", () => {
  assert.equal(parseTaskStartRequest({
    agent_type: "explore",
    description: "Inspect the repository",
    prompt: "Map the repository.",
  })?.agent_type, "explore");
  assert.equal(parseTaskStartRequest({ operation: "status" }), undefined);
  assert.equal(parseTaskStartRequest({
    agent_type: "explore",
    description: "Inspect the repository",
    prompt: 42,
  }), undefined);
});

test("reviewer starts require structured parent context and proposed semantics", () => {
  const base = {
    agent_type: "reviewer",
    description: "Audit the manifest",
    prompt: "Read the files and account for the proposed changes.",
  };
  assert.equal(parseTaskStartRequest(base), undefined);
  assert.deepEqual(parseTaskStartRequest({
    ...base,
    prompt: "Goal: audit the manifest.\nParent context:\nThe parent found naming drift across the manifest and session records.\nProposed changes:\n- stable stepId: preserve one durable id across retries\n- tool_batch_started: record the batch boundary before execution\nScope: inspect the manifest and session records.",
  })?.proposed_changes, [
    "stable stepId: preserve one durable id across retries",
    "tool_batch_started: record the batch boundary before execution",
  ]);
  assert.deepEqual(parseTaskStartRequest({
    ...base,
    parent_context: "The parent found naming drift across the manifest and session records.",
    proposed_changes: [
      "stable stepId: one durable identifier per logical step, preserved across retries",
      "tool_batch_started: record the batch boundary before tool execution",
    ],
  })?.proposed_changes, [
    "stable stepId: one durable identifier per logical step, preserved across retries",
    "tool_batch_started: record the batch boundary before tool execution",
  ]);
});

test("task control parsing trims references and rejects malformed requests", () => {
  assert.deepEqual(parseTaskControlRequest({ operation: "status", task_id: " task-1 " }), {
    operation: "status",
    taskId: "task-1",
  });
  assert.equal(parseTaskControlRequest({ operation: "cancel", task_id: "   " }), undefined);
  assert.equal(parseTaskControlRequest({ operation: "start", task_id: "task-1" }), undefined);
});

test("task records resolve by id, session name, or conversation id", () => {
  const record = fromHistoryEntry({
    id: "task-1",
    agentType: "explore",
    description: "Inspect repository",
    sessionName: "repo-explorer",
    conversationId: "architecture",
    backend: "tmux",
    piDir: "/tmp/pi",
    dir: "/tmp/pi/artifacts",
    startedAt: 100,
    status: "done",
    background: true,
  });

  assert.equal(findTaskRecord("task-1", [record])?.id, "task-1");
  assert.equal(findTaskRecord("repo-explorer", [record])?.id, "task-1");
  assert.equal(findTaskRecord("architecture", [record])?.id, "task-1");
  assert.equal(findTaskRecord("missing", [record]), undefined);
});

test("active registry entries take precedence over stale history", () => {
  const running: TaskControlRecord = {
    id: "task-1",
    agentType: "explore",
    description: "Inspect repository",
    sessionName: "repo-explorer",
    backend: "tmux",
    dir: "/tmp/pi/artifacts",
    startedAt: 200,
    status: "running",
    source: "registry",
  };
  const done: TaskControlRecord = { ...running, status: "done", source: "history" };

  assert.equal(findTaskRecord("task-1", [running, done])?.status, "running");
});

test("cancellation is backend-aware and refuses terminal or SDK records", () => {
  const base: TaskControlRecord = {
    id: "task-1",
    agentType: "explore",
    description: "Inspect repository",
    sessionName: "repo-explorer",
    backend: "tmux",
    dir: "/tmp/pi/artifacts",
    startedAt: 100,
    status: "running",
    source: "registry",
  };

  assert.deepEqual(decideCancellation(base), { kind: "allowed", backend: "tmux" });
  assert.deepEqual(decideCancellation({ ...base, backend: "sdk" }), {
    kind: "unsupported",
    reason: "sdk_backend",
  });
  assert.deepEqual(decideCancellation({ ...base, status: "done" }), {
    kind: "terminal",
    status: "done",
  });
});

test("legacy registry records infer tmux from a pane id", () => {
  const record = fromRegistryEntry({
    id: "task-1",
    agentType: "explore",
    description: "Inspect repository",
    sessionName: "repo-explorer",
    paneId: "%1",
    piDir: "/tmp/pi",
    dir: "/tmp/pi/artifacts",
    startedAt: 100,
  });

  assert.equal(record.backend, "tmux");
});

test("status control reads durable history without touching backend resources", () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-control-status-"));
  upsertTaskSessionHistory(piDir, {
    id: "task-history",
    agentType: "scout",
    description: "History task",
    sessionName: "history-task",
    conversationId: "architecture",
    piDir,
    dir: join(piDir, "artifacts"),
    startedAt: 100,
    status: "done",
    background: true,
  });

  const result = handleTaskControl(
    { operation: "status", taskId: "architecture" },
    {
      pi: {} as never,
      piDir,
      backgroundTasks: new Map(),
      registryEntryStatus: () => {
        throw new Error("status must not probe a backend");
      },
      clearTaskWidgetIfIdle: () => {},
    },
  );

  assert.equal(result.isError, undefined);
  assert.equal(result.details.task_id, "task-history");
  assert.equal(result.details.status, "done");
});

test("cancel control refuses an active SDK task explicitly", () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-control-sdk-"));
  const backgroundTasks = new Map([
    ["task-sdk", {
      dir: join(piDir, "artifacts"),
      agentType: "explore",
      sessionName: "task-sdk",
      backend: "sdk" as const,
      originalPane: null,
      description: "SDK task",
      startedAt: 100,
      toolUses: 0,
      turns: 0,
      recentCalls: [],
    }],
  ]);

  const result = handleTaskControl(
    { operation: "cancel", taskId: "task-sdk" },
    {
      pi: {} as never,
      piDir,
      backgroundTasks,
      registryEntryStatus: () => "alive",
      clearTaskWidgetIfIdle: () => {},
    },
  );

  assert.equal(result.isError, true);
  assert.equal(result.details.error, "sdk_cancel_unsupported");
  assert.equal(backgroundTasks.has("task-sdk"), true);
});

test("cancel control delegates owned terminal cleanup and removes the active task", () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-control-cancel-"));
  writeRegistry(piDir, [{
    id: "task-tmux",
    agentType: "explore",
    description: "tmux task",
    sessionName: "task-tmux",
    paneId: "%1",
    piDir,
    dir: join(piDir, "artifacts"),
    startedAt: 100,
  }]);
  const backgroundTasks = new Map([
    ["task-tmux", {
      dir: join(piDir, "artifacts"),
      agentType: "explore",
      sessionName: "task-tmux",
      paneId: "%1",
      backend: "tmux" as const,
      originalPane: null,
      description: "tmux task",
      startedAt: 100,
      toolUses: 0,
      turns: 0,
      recentCalls: [],
    }],
  ]);
  let cleanupPhase: string | undefined;
  let widgetCleared = false;

  const result = handleTaskControl(
    { operation: "cancel", taskId: "task-tmux" },
    {
      pi: {} as never,
      piDir,
      backgroundTasks,
      registryEntryStatus: () => "alive",
      clearTaskWidgetIfIdle: () => {
        widgetCleared = true;
      },
      completeTask: (_pi, _id, _task, _content, phase) => {
        cleanupPhase = phase;
        return { cleanupSucceeded: true };
      },
    },
  );

  assert.equal(result.isError, undefined);
  assert.equal(result.details.status, "cancelled");
  assert.equal(cleanupPhase, "cancelled");
  assert.equal(widgetCleared, true);
  assert.equal(backgroundTasks.has("task-tmux"), false);
});

test("cancel control reports cleanup pending and preserves the durable receipt", () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-control-cleanup-"));
  writeRegistry(piDir, [{
    id: "task-tmux-cleanup",
    agentType: "explore",
    description: "tmux task",
    sessionName: "task-tmux-cleanup",
    paneId: "%2",
    piDir,
    dir: join(piDir, "artifacts"),
    startedAt: 100,
  }]);
  const backgroundTasks = new Map([
    ["task-tmux-cleanup", {
      dir: join(piDir, "artifacts"),
      agentType: "explore",
      sessionName: "task-tmux-cleanup",
      paneId: "%2",
      backend: "tmux" as const,
      originalPane: null,
      description: "tmux task",
      startedAt: 100,
      toolUses: 0,
      turns: 0,
      recentCalls: [],
    }],
  ]);

  const result = handleTaskControl(
    { operation: "cancel", taskId: "task-tmux-cleanup" },
    {
      pi: { sendMessage: () => {} } as never,
      piDir,
      backgroundTasks,
      registryEntryStatus: () => "alive",
      clearTaskWidgetIfIdle: () => {},
      completeTask: (pi, id, task, content, phase, dir) =>
        persistCompletedTask(pi, id, task, content, phase, dir, () => {
          throw new Error("tmux unavailable");
        }),
    },
  );

  assert.equal(result.isError, true);
  assert.equal(result.details.error, "cleanup_pending");
  assert.equal(result.details.status, "cancelled");
  assert.equal(readRegistry(piDir)[0]?.cleanupPending, true);
  assert.equal(backgroundTasks.has("task-tmux-cleanup"), false);

  const status = handleTaskControl(
    { operation: "status", taskId: "task-tmux-cleanup" },
    {
      pi: {} as never,
      piDir,
      backgroundTasks,
      registryEntryStatus: () => "unavailable",
      clearTaskWidgetIfIdle: () => {},
    },
  );
  assert.equal(status.details.status, "cancelled");
  assert.equal(status.details.cleanup_pending, true);
});
