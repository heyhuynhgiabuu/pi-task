import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Value } from "typebox/value";
import { readRegistry, upsertTaskSessionHistory, writeRegistry } from "../src/conversation.js";
import registerTaskExtension from "../src/index.js";
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
  taskStartRequestError,
  type TaskControlRecord,
} from "../src/task-control.js";

// Delegated pi-task children disable recursive registration; this file registers the host extension.
const inheritedTaskToolDisabled = process.env.PI_TASK_TOOL_DISABLED;
delete process.env.PI_TASK_TOOL_DISABLED;
process.on("exit", () => {
  if (inheritedTaskToolDisabled === undefined) delete process.env.PI_TASK_TOOL_DISABLED;
  else process.env.PI_TASK_TOOL_DISABLED = inheritedTaskToolDisabled;
});

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
  assert.equal(
    Value.Check(schema, {
      operation: "start",
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
  assert.equal(parseTaskStartRequest({
    operation: "start",
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

test("fast is an optional start setting and survives task control parsing", () => {
  const schema = taskParametersSchema();
  const base = {
    agent_type: "explore",
    description: "Inspect the repository",
    prompt: "Map the repository.",
  };

  assert.equal(Value.Check(schema, { ...base, fast: true }), true);
  assert.equal(Value.Check(schema, { ...base, fast: false }), true);
  assert.equal(parseTaskStartRequest({ ...base, fast: true })?.fast, true);
  assert.equal(parseTaskStartRequest({ ...base, fast: false })?.fast, false);
  assert.equal(parseTaskStartRequest({ ...base, fast: "true" }), undefined);
  assert.equal(parseTaskControlRequest({
    operation: "status",
    task_id: "task-1",
    fast: true,
  }), undefined);
});

test("compare is an optional start setting and survives task control parsing", () => {
  const schema = taskParametersSchema();
  const base = {
    agent_type: "explore",
    description: "Inspect the repository",
    prompt: "Map the repository.",
  };

  assert.equal(Value.Check(schema, { ...base, compare: true }), true);
  assert.equal(Value.Check(schema, { ...base, compare: false }), true);
  assert.equal(parseTaskStartRequest({ ...base, compare: true })?.compare, true);
  assert.equal(parseTaskStartRequest({ ...base, compare: false })?.compare, false);
  assert.equal(parseTaskStartRequest({ ...base, compare: "true" }), undefined);
  assert.equal(
    taskStartRequestError({ ...base, compare: "true" }),
    "compare must be a boolean",
  );
  assert.equal(parseTaskControlRequest({
    operation: "status",
    task_id: "task-1",
    compare: true,
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

test("start parsing accepts the resume alias and reports targeted rejection reasons", () => {
  const schema = taskParametersSchema();
  const base = {
    agent_type: "explore",
    description: "Inspect the repository",
    prompt: "Map the repository.",
  };

  // Schema accepts the resume alias for providers that require a mode discriminator.
  assert.equal(Value.Check(schema, { ...base, operation: "resume" }), true);
  // The alias parses exactly like an explicit start.
  const resumed = parseTaskStartRequest({ ...base, operation: "resume" });
  assert.equal(resumed?.agent_type, "explore");
  assert.equal(resumed?.description, "Inspect the repository");

  // Valid starts produce no error text.
  assert.equal(taskStartRequestError(base), undefined);
  assert.equal(taskStartRequestError({ ...base, operation: "start" }), undefined);
  assert.equal(taskStartRequestError({ ...base, operation: "resume" }), undefined);

  // Unknown operations get a targeted, actionable reason instead of a generic one.
  assert.match(
    taskStartRequestError({ ...base, operation: "deploy" })!,
    /^operation must be "start" or "resume" \(or omitted\); received "deploy"$/,
  );

  // Missing or mistyped required fields are each named.
  assert.equal(
    taskStartRequestError({ agent_type: "explore", prompt: "x" }),
    "description must be a string",
  );
  assert.equal(
    taskStartRequestError({ operation: "start", agent_type: 7, prompt: 42, description: null }),
    "agent_type must be a string; prompt must be a string; description must be a string",
  );

  // Optional fields with wrong types are named too.
  assert.equal(taskStartRequestError({ ...base, background: "true" }), "background must be a boolean");
  assert.equal(taskStartRequestError({ ...base, fast: 1 }), "fast must be a boolean");
  assert.equal(taskStartRequestError({ ...base, task_id: 123 }), "task_id must be a string");
  assert.equal(
    taskStartRequestError({ ...base, cwd: "/tmp", workspace_group: [] }),
    "workspace_group must be a string",
  );

  // Blank structured input is rejected even for non-reviewer agents (v0.5.1 passed "" through).
  assert.equal(
    taskStartRequestError({ ...base, parent_context: "   " }),
    "parent_context was provided but is empty after trimming",
  );

  // Reviewer gaps name the missing structured inputs.
  const reviewerBase = {
    agent_type: "reviewer",
    description: "Audit the manifest",
    prompt: "Read the files and account for the proposed changes.",
  };
  assert.match(
    taskStartRequestError(reviewerBase)!,
    /reviewer tasks require parent_context and proposed_changes/,
  );
  assert.equal(
    taskStartRequestError({ ...reviewerBase, parent_context: "   ", proposed_changes: [""] }),
    "parent_context was provided but is empty after trimming; proposed_changes contains blank items; each entry must be a non-empty string",
  );
});

test("task control parsing trims references and rejects malformed requests", () => {
  assert.deepEqual(parseTaskControlRequest({ operation: "status", task_id: " task-1 " }), {
    operation: "status",
    taskId: "task-1",
  });
  assert.equal(parseTaskControlRequest({ operation: "cancel", task_id: "   " }), undefined);
  assert.equal(parseTaskControlRequest({ operation: "start", task_id: "task-1" }), undefined);
});

test("task control parsing rejects control requests mixed with start fields", () => {
  assert.equal(parseTaskControlRequest({
    operation: "status",
    task_id: "none",
    agent_type: "reviewer",
    prompt: "Review the current working tree.",
    description: "Review source changes",
  }), undefined);
});

test("task tool explains malformed control payloads instead of reporting a generic start error", async () => {
  type CapturedTaskTool = {
    execute: (...args: unknown[]) => Promise<{ content: Array<{ text?: string }>; details?: { error?: string } }>;
  };
  let tool: CapturedTaskTool | undefined;
  let shutdown: (() => void) | undefined;
  const pi = {
    on(event: string, handler: () => void) {
      if (event === "session_shutdown") shutdown = handler;
    },
    registerMessageRenderer() {},
      registerFlag() {},
    registerTool(definition: CapturedTaskTool) {
      tool = definition;
    },
    registerCommand() {},
    getAllTools() { return []; },
  };

  // Register against an empty tmpdir so the extension's restore path cannot
  // touch the repo's real .pi registry or close live HerdR panes.
  const originalCwd = process.cwd();
  const isolatedCwd = mkdtempSync(join(tmpdir(), "pi-task-registration-"));
  process.chdir(isolatedCwd);
  try {
    registerTaskExtension(pi as never);
    assert.ok(tool);

    const malformed = await tool.execute("call-1", {
      operation: "status",
      task_id: "none",
      agent_type: "reviewer",
      prompt: "Review the current working tree.",
      description: "Review source changes",
    }, new AbortController().signal, undefined, { cwd: isolatedCwd });
    assert.equal(malformed.content[0]?.text, "Invalid task control request: status/cancel require only operation and task_id; omit operation for start/resume.");
    assert.equal(malformed.details?.error, "invalid_task_control_request");

    const missingId = await tool.execute("call-2", {
      operation: "status",
    }, new AbortController().signal, undefined, { cwd: isolatedCwd });
    assert.equal(missingId.content[0]?.text, "Invalid task control request: status/cancel require only operation and task_id; omit operation for start/resume.");
    assert.equal(missingId.details?.error, "invalid_task_control_request");

    const invalidStart = await tool.execute("call-3", {
      operation: "start",
    }, new AbortController().signal, undefined, { cwd: isolatedCwd });
    assert.equal(
      invalidStart.content[0]?.text,
      "Invalid task request: agent_type must be a string; prompt must be a string; description must be a string.",
    );
    assert.equal(invalidStart.details?.error, "invalid_task_request");
    assert.equal(
      invalidStart.details?.reason,
      "agent_type must be a string; prompt must be a string; description must be a string",
    );
  } finally {
    process.chdir(originalCwd);
    rmSync(isolatedCwd, { recursive: true, force: true });
    shutdown?.();
  }
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

test("cancel retires the active task even when the panel notification throws", () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-control-zombie-"));
  writeRegistry(piDir, [{
    id: "task-zombie",
    agentType: "explore",
    description: "zombie cancel",
    sessionName: "task-zombie",
    paneId: "%1",
    piDir,
    dir: join(piDir, "artifacts"),
    startedAt: 100,
  }]);
  const backgroundTasks = new Map([
    ["task-zombie", {
      dir: join(piDir, "artifacts"),
      agentType: "explore",
      sessionName: "task-zombie",
      paneId: "%1",
      backend: "tmux" as const,
      originalPane: null,
      description: "zombie cancel",
      startedAt: 100,
      toolUses: 0,
      turns: 0,
      recentCalls: [],
    }],
  ]);

  const result = handleTaskControl(
    { operation: "cancel", taskId: "task-zombie" },
    {
      pi: { sendMessage: () => {} } as never,
      piDir,
      backgroundTasks,
      registryEntryStatus: () => "alive",
      clearTaskWidgetIfIdle: () => {},
      completeTask: () => ({ cleanupSucceeded: true }),
      noteTaskFinished: () => {
        throw new Error("panel boom");
      },
    },
  );

  assert.equal(result.isError, undefined, "cancel itself succeeds");
  assert.equal(
    backgroundTasks.has("task-zombie"),
    false,
    "settled task retired despite the throwing notification",
  );
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
