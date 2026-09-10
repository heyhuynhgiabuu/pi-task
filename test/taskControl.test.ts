import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readRegistry, upsertTaskSessionHistory, writeRegistry } from "../src/conversation.js";
import registerTaskExtension from "../src/index.js";
import { completeTask as persistCompletedTask } from "../src/lifecycle/completion.js";
import { handleTaskControl } from "../src/task-control-api.js";
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
import { PI_THINKING_LEVELS } from "../src/thinking.js";

// Delegated pi-task children disable recursive registration; this file registers the host extension.
const inheritedTaskToolDisabled = process.env.PI_TASK_TOOL_DISABLED;
delete process.env.PI_TASK_TOOL_DISABLED;
process.on("exit", () => {
  if (inheritedTaskToolDisabled === undefined) delete process.env.PI_TASK_TOOL_DISABLED;
  else process.env.PI_TASK_TOOL_DISABLED = inheritedTaskToolDisabled;
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
  }), undefined);
  assert.equal(parseTaskStartRequest({ operation: "status" }), undefined);
  assert.equal(parseTaskStartRequest({
    agent_type: "explore",
    description: "Inspect the repository",
    prompt: 42,
  }), undefined);
});

test("thinking accepts Pi's canonical levels and normalizes them", () => {
  const base = {
    agent_type: "explore",
    description: "Inspect the repository",
    prompt: "Map the repository.",
  };

  for (const level of PI_THINKING_LEVELS) {
    assert.equal(
      parseTaskStartRequest({ ...base, thinking: ` ${level.toUpperCase()} ` })?.thinking,
      level,
      `${level} is accepted and normalized`,
    );
  }
  assert.equal(parseTaskStartRequest(base)?.thinking, undefined, "thinking remains optional");
});

test("thinking rejects unknown or non-string values", () => {
  const base = {
    agent_type: "explore",
    description: "Inspect the repository",
    prompt: "Map the repository.",
  };

  assert.equal(parseTaskStartRequest({ ...base, thinking: "turbo" }), undefined);
  assert.equal(
    taskStartRequestError({ ...base, thinking: "turbo" }),
    "thinking must be one of: off, minimal, low, medium, high, xhigh, max",
  );
  assert.equal(parseTaskStartRequest({ ...base, thinking: 1 }), undefined);
  assert.equal(taskStartRequestError({ ...base, thinking: 1 }), "thinking must be a string");
  assert.match(taskStartRequestError({ ...base, thinking: "   " }) ?? "", /^thinking must be one of:/);
});

test("fast is rejected as a removed task parameter", () => {
  const base = {
    agent_type: "explore",
    description: "Inspect the repository",
    prompt: "Map the repository.",
  };

  assert.equal(parseTaskStartRequest({ ...base, fast: true }), undefined);
  assert.match(
    taskStartRequestError({ ...base, fast: true })!,
    /^fast is no longer a task parameter/,
  );
  assert.equal(parseTaskControlRequest({
    operation: "status",
    task_id: "task-1",
    fast: true,
  }), undefined);
});

test("compare survives task control parsing as an optional boolean", () => {
  const base = {
    agent_type: "explore",
    description: "Inspect the repository",
    prompt: "Map the repository.",
  };

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

test("start parsing rejects the removed operation field", () => {
  const base = {
    agent_type: "explore",
    description: "Inspect the repository",
    prompt: "Map the repository.",
  };

  // Start and resume are told apart by task_id, and status and cancel live on
  // the /task command. The field is rejected rather than aliased, so a stale
  // control payload cannot be read as a start request and launched.
  for (const operation of ["start", "resume", "status", "cancel", "deploy"]) {
    assert.equal(
      parseTaskStartRequest({ ...base, operation }),
      undefined,
      `operation ${operation} is rejected`,
    );
    assert.match(
      taskStartRequestError({ ...base, operation })!,
      /^operation is no longer a task parameter/,
      `operation ${operation} gets an actionable reason`,
    );
  }

  // Valid starts produce no error text.
  assert.equal(taskStartRequestError(base), undefined);

  // Missing or mistyped required fields are each named.
  assert.equal(
    taskStartRequestError({ agent_type: "explore", prompt: "x" }),
    "description must be a string",
  );
  assert.equal(
    taskStartRequestError({ agent_type: 7, prompt: 42, description: null }),
    "agent_type must be a string; prompt must be a string; description must be a string",
  );

  // Optional fields with wrong types are named too.
  assert.equal(taskStartRequestError({ ...base, background: "true" }), "background must be a boolean");
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

test("task tool refuses a control-shaped payload instead of launching work", async () => {
  type CapturedTaskTool = {
    execute: (...args: unknown[]) => Promise<{ content: Array<{ text?: string }>; details?: { error?: string; reason?: string } }>;
  };
  let tool: CapturedTaskTool | undefined;
  let shutdown: (() => void) | undefined;
  const pi = {
    on(event: string, handler: () => void) {
      if (event === "session_shutdown") shutdown = handler;
    },
    registerMessageRenderer() {},
      registerFlag() {},
      getFlag() { return undefined; },
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

    // Control moved to the `/task` command. A payload still carrying
    // `operation: "status"` must not be read as a start request and launched.
    const malformed = await tool.execute("call-1", {
      operation: "status",
      task_id: "none",
      agent_type: "reviewer",
      prompt: "Review the current working tree.",
      description: "Review source changes",
    }, new AbortController().signal, undefined, { cwd: isolatedCwd });
    assert.match(malformed.content[0]?.text ?? "", /operation is no longer a task parameter/);
    assert.equal(malformed.details?.error, "invalid_task_request");

    const missingId = await tool.execute("call-2", {
      operation: "status",
    }, new AbortController().signal, undefined, { cwd: isolatedCwd });
    assert.match(missingId.content[0]?.text ?? "", /operation is no longer a task parameter/);
    assert.equal(missingId.details?.error, "invalid_task_request");

    const invalidStart = await tool.execute("call-3", {
      agent_type: "reviewer",
    }, new AbortController().signal, undefined, { cwd: isolatedCwd });
    assert.equal(
      invalidStart.content[0]?.text,
      "Invalid task request: prompt must be a string; description must be a string.",
    );
    assert.equal(invalidStart.details?.error, "invalid_task_request");
    assert.equal(
      invalidStart.details?.reason,
      "prompt must be a string; description must be a string",
    );

    mkdirSync(join(isolatedCwd, ".pi"), { recursive: true });
    writeFileSync(join(isolatedCwd, ".pi", "task-registry.json"), "{not-json", "utf-8");
    // A start request fails closed on unreadable durable state.
    const corruptState = await tool.execute("call-4", {
      agent_type: "reviewer",
      description: "Review source changes",
      prompt: "Review the current working tree.",
      parent_context: "The launch boundary must preserve durable state.",
      proposed_changes: ["No design changes"],
    }, new AbortController().signal, undefined, { cwd: isolatedCwd });
    assert.equal(corruptState.content[0]?.text, "Unreadable durable state: task-registry.json (parse). Repair the durable file before retrying the task operation.");
    assert.equal(corruptState.details?.error, "durable_state_unreadable");

    // Launches use the same tool boundary. A rejected admission promise must
    // become the structured durable-state result rather than a raw rejection.
    rmSync(join(isolatedCwd, ".pi", "task-registry.json"), { force: true });
    mkdirSync(join(isolatedCwd, ".pi", "agents"), { recursive: true });
    writeFileSync(
      join(isolatedCwd, ".pi", "agents", "reviewer.md"),
      "---\\ndescription: Test reviewer\\n---\\n\\nReview the requested files.",
      "utf-8",
    );
    mkdirSync(join(isolatedCwd, ".pi", "artifacts"), { recursive: true });
    const mapPath = join(isolatedCwd, ".pi", "artifacts", "task-sessions.json");
    const corruptMap = "{not-json";
    writeFileSync(mapPath, corruptMap, "utf-8");
    const corruptLaunch = await tool.execute("call-5", {
      agent_type: "reviewer",
      description: "Review source changes",
      prompt: "Review the current working tree.",
      parent_context: "The launch boundary must preserve durable state.",
      proposed_changes: ["No design changes"],
      conversation_id: "corrupt-conversation",
    }, new AbortController().signal, undefined, { cwd: isolatedCwd });
    assert.equal(corruptLaunch.details?.error, "durable_state_unreadable");
    assert.equal(corruptLaunch.details?.file, "task-sessions.json");
    assert.equal(corruptLaunch.isError, true);
    assert.match(corruptLaunch.content[0]?.text ?? "", /repair the durable file/i);
    assert.equal(readFileSync(mapPath, "utf-8"), corruptMap);
  } finally {
    process.chdir(originalCwd);
    rmSync(isolatedCwd, { recursive: true, force: true });
    shutdown?.();
  }
});

test("task control is reachable from the /task command", async () => {
  type Command = {
    description?: string;
    handler: (args: unknown, ctx: unknown) => Promise<void> | void;
  };
  const commands = new Map<string, Command>();
  const notices: Array<{ message: string; level: string }> = [];
  let shutdown: (() => void) | undefined;
  const pi = {
    on(event: string, handler: () => void) {
      if (event === "session_shutdown") shutdown = handler;
    },
    registerMessageRenderer() {},
    registerFlag() {},
    getFlag() { return undefined; },
    registerTool() {},
    registerCommand(name: string, options: Command) {
      commands.set(name, options);
    },
    getAllTools() { return []; },
  };

  const originalCwd = process.cwd();
  const isolatedCwd = mkdtempSync(join(tmpdir(), "pi-task-command-"));
  process.chdir(isolatedCwd);
  try {
    registerTaskExtension(pi as never);
    const task = commands.get("task");
    assert.ok(task, "the /task command is registered");
    assert.match(task.description ?? "", /cancel/i);

    const ui = {
      notify: (message: string, level: string) => notices.push({ message, level }),
    };
    const ctx = { ui, sessionManager: { getCwd: () => isolatedCwd } };

    await task.handler("", ctx);
    assert.equal(notices.at(-1)?.level, "info");
    assert.match(notices.at(-1)?.message ?? "", /No durable pi-task conversations found/);

    await task.handler("status", ctx);
    assert.equal(notices.at(-1)?.level, "error");
    assert.match(notices.at(-1)?.message ?? "", /needs a task id/);

    // The control path still fails closed on unreadable durable state.
    mkdirSync(join(isolatedCwd, ".pi"), { recursive: true });
    writeFileSync(join(isolatedCwd, ".pi", "task-registry.json"), "{not-json", "utf-8");
    await task.handler("status task-1", ctx);
    assert.equal(notices.at(-1)?.level, "error");
    assert.match(notices.at(-1)?.message ?? "", /Unreadable durable state: task-registry\.json/);
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
  const artifactsDir = join(piDir, "artifacts");
  const sessionDir = join(artifactsDir, "sessions", "task-history");
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, "history-task.jsonl"),
    [
      JSON.stringify({ type: "session_info", name: "history-task" }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "toolCall", id: "call-1" }] },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      }),
    ].join("\n"),
  );
  mkdirSync(join(piDir, "task-exits"), { recursive: true });
  writeFileSync(
    join(piDir, "task-exits", "task-history.exit.json"),
    JSON.stringify({
      schemaVersion: 1,
      taskId: "task-history",
      exitCode: 0,
      completedAt: new Date(350).toISOString(),
    }),
  );
  const sessionRef = join(sessionDir, "history-task.jsonl");
  upsertTaskSessionHistory(piDir, {
    id: "task-history",
    agentType: "scout",
    description: "History task",
    sessionName: "history-task",
    conversationId: "architecture",
    piDir,
    dir: artifactsDir,
    sessionRef,
    backend: "tmux",
    startedAt: 100,
    completedAt: 350,
    status: "done",
    rawStatus: "success",
    resultValid: true,
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
  assert.equal(result.details.runtime, "pi");
  assert.equal(result.details.started_at, 100);
  assert.equal(result.details.completed_at, 350);
  assert.equal(result.details.elapsed_ms, 250);
  assert.equal(result.details.session_ref, sessionRef);
  assert.equal(result.details.turn_count, 2);
  assert.equal(result.details.tool_uses, 1);
  assert.equal(result.details.raw_status, "success");
  assert.equal(result.details.result_valid, true);
  assert.equal(result.details.exit_code, 0);
});

test("status reports unreadable durable state instead of treating it as empty", () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-control-corrupt-"));
  writeFileSync(join(piDir, "task-registry.json"), "{not-json", "utf-8");

  const result = handleTaskControl(
    { operation: "status", taskId: "task-corrupt" },
    {
      pi: {} as never,
      piDir,
      backgroundTasks: new Map(),
      registryEntryStatus: () => "missing",
      clearTaskWidgetIfIdle: () => {},
    },
  );

  assert.equal(result.isError, true);
  assert.equal(result.details.error, "durable_state_unreadable");
  assert.match(result.content[0].text, /unreadable durable state/i);
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
      completeTask: ({ phase }) => {
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
      completeTask: (options) =>
        persistCompletedTask({
          ...options,
          resourceCloser: () => {
            throw new Error("tmux unavailable");
          },
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
