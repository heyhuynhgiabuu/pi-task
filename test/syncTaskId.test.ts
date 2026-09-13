/**
 * Issue #27: synchronous (background:false) task results must expose the
 * durable task id in model-visible content, not only in UI-only details.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTerminalForegroundTask } from "../src/lifecycle/terminal-foreground.js";
import { executeSdkTask } from "../src/lifecycle/sdk-execution.js";
import { DurableStateError, readTaskSessionHistory } from "../src/conversation.js";
import type { TerminalBackend } from "../src/subagent/terminalBackend.js";

const FAKE_HERDR_BACKEND = {
  kind: "herdr",
  isAlive: async () => true,
  close: async () => {},
} as unknown as TerminalBackend;

/** Terminal foreground fixture: creates the task session dir the caller
 * writes its transcript into. */
function terminalForegroundFixture(
  root: string,
  piDir: string,
  artifactsDir: string,
  id: string,
  runtime?: { runtime: "claude"; claudeSessionId: string; claudeSessionFile: string },
) {
  const sessionName = `task-${id}`;
  const sessionDir = join(artifactsDir, "sessions", id);
  mkdirSync(sessionDir, { recursive: true });
  return {
    sessionName,
    sessionDir,
    options: {
      id,
      agentType: "explore",
      description: "Sync probe",
      sessionName,
      sessionDir,
      artifactsDir,
      taskCwd: root,
      piDir,
      ...(runtime ?? {}),
      handle: {
        backend: "herdr" as const,
        resourceId: "pane-1",
        socketPath: join(root, "fake.sock"),
        terminalId: "term-1",
      },
      paneId: "pane-1",
      originalPane: null,
      startedAt: Date.now() - 500,
      selectedBackend: "herdr" as const,
      terminalBackend: FAKE_HERDR_BACKEND,
      foregroundTasks: new Map(),
      clearTaskWidgetIfIdle: () => {},
    },
  };
}

function resultContent(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content
    .map((block) => block.text)
    .join("\n");
}

test("terminal foreground result carries the task id in model-visible content", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-sync-terminal-"));
  try {
    const piDir = join(root, ".pi");
    const artifactsDir = join(piDir, "artifacts", "tasks");
    const id = "sync-terminal-1";
    const { sessionName, sessionDir, options } = terminalForegroundFixture(
      root,
      piDir,
      artifactsDir,
      id,
    );

    writeFileSync(
      join(sessionDir, `${sessionName}.jsonl`),
      [
        JSON.stringify({ type: "session_info", name: sessionName }),
        JSON.stringify({
          type: "message",
          timestamp: new Date().toISOString(),
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "Status: success\n\nChild report." }],
          },
        }),
      ].join("\n") + "\n",
    );

    const result = await executeTerminalForegroundTask(options);
    const content = resultContent(result);
    const details = (result as { details: Record<string, unknown> }).details;

    assert.match(content, new RegExp(`Task ID: ${id}`), "content names the task id");
    assert.match(content, /pass as task_id to resume/, "content states how to resume");
    assert.equal(details.task_id, id, "details carries the task id");
    assert.equal(details.background, false, "details keeps the sync mode");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude Code foreground result carries the id without promising resume", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-sync-claude-"));
  try {
    const piDir = join(root, ".pi");
    const artifactsDir = join(piDir, "artifacts", "tasks");
    const id = "sync-claude-1";
    const claudeSessionId = "11111111-2222-4333-8444-555555555555";
    const claudeSessionFile = join(root, "claude-session.jsonl");
    const { options } = terminalForegroundFixture(root, piDir, artifactsDir, id, {
      runtime: "claude",
      claudeSessionId,
      claudeSessionFile,
    });

    writeFileSync(
      claudeSessionFile,
      JSON.stringify({
        type: "assistant",
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Status: success\n\nClaude report." }],
        },
      }) + "\n",
    );

    const result = await executeTerminalForegroundTask(options);
    const content = resultContent(result);

    assert.match(content, new RegExp(`Task ID: ${id}`), "content names the task id");
    assert.match(
      content,
      /session resume is unavailable/,
      "Claude pointer does not promise resume",
    );
    assert.ok(
      !/pass as task_id to resume/.test(content),
      "Claude pointer does not promise resume",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** SDK foreground options with no resolvable model, so the run throws before
 * any provider call and the failure path is exercised end to end. */
function sdkTaskOptions(root: string, piDir: string, artifactsDir: string, id: string) {
  return {
    id,
    agent: {
      name: "explore",
      description: "d",
      body: "b",
      source: "bundled" as const,
      path: join(root, "explore.md"),
    },
    description: "SDK sync probe",
    sessionName: `task-${id}`,
    prompt: "p",
    cwd: root,
    ctx: {
      model: undefined,
      modelRegistry: { getAll: () => [], getAvailable: async () => [] },
      isProjectTrusted: () => true,
    },
    pi: { sendMessage: () => {}, getFlag: () => undefined },
    piDir,
    artifactsDir,
    toolSelection: { tools: ["read"], excludeTools: [] },
    skillPaths: [],
    fast: false,
    isBackground: false,
    foregroundTask: {
      dir: artifactsDir,
      cwd: root,
      agentType: "explore",
      sessionName: `task-${id}`,
      backend: "sdk" as const,
      originalPane: null,
      description: "SDK sync probe",
      startedAt: Date.now() - 100,
      toolUses: 0,
      turns: 0,
      recentCalls: [],
    },
    backgroundTasks: new Map(),
    foregroundTasks: new Map<string, unknown>(),
    deliveryGuard: {
      track: () => {},
      allows: () => true,
      forget: () => {},
      restore: () => {},
    },
    taskWidget: { requestRender: () => {}, noteTaskFinished: () => {} },
    ensureTaskWidget: () => {},
    clearTaskWidgetIfIdle: () => {},
    enqueueDelivery: () => {},
  };
}

test("SDK foreground failure carries the task id without promising resume", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-sync-sdk-"));
  try {
    const piDir = join(root, ".pi");
    const artifactsDir = join(piDir, "artifacts", "tasks");
    mkdirSync(artifactsDir, { recursive: true });
    const id = "sync-sdk-1";

    const result = await executeSdkTask(
      sdkTaskOptions(root, piDir, artifactsDir, id) as never,
    );

    const typed = result as {
      content: Array<{ text: string }>;
      details: Record<string, unknown>;
      isError?: boolean;
    };
    const content = resultContent(result);

    assert.match(content, new RegExp(`Task ID: ${id}`), "content names the task id");
    assert.match(
      content,
      /session resume is unavailable/,
      "SDK pointer does not promise resume",
    );
    assert.equal(typed.details.task_id, id, "details carries the task id");
    assert.equal(typed.details.background, false, "details keeps the sync mode");
    assert.equal(typed.details.phase, "failed");

    const record = readTaskSessionHistory(piDir).find((entry) => entry.id === id);
    assert.ok(record, "SDK foreground run persists a durable history row");
    assert.equal(record.status, "failed");
    assert.equal(record.background, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SDK foreground clears its row when the durable write fails before the run", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-sync-sdk-durable-"));
  try {
    const piDir = join(root, ".pi");
    const artifactsDir = join(piDir, "artifacts", "tasks");
    mkdirSync(artifactsDir, { recursive: true });
    // A corrupt history file makes the pre-run durable write throw before the
    // run's try/finally is entered; the foreground row must still be cleared.
    writeFileSync(join(piDir, "task-session-history.json"), "{ not json", "utf8");
    const id = "sync-sdk-durable-1";
    const foregroundTasks = new Map<string, unknown>([[id, {}]]);
    let cleared = 0;

    await assert.rejects(
      executeSdkTask({
        ...sdkTaskOptions(root, piDir, artifactsDir, id),
        foregroundTasks,
        clearTaskWidgetIfIdle: () => {
          cleared += 1;
        },
      } as never),
      (error: unknown) => error instanceof DurableStateError,
    );

    assert.equal(foregroundTasks.has(id), false, "foreground row cleared");
    assert.equal(cleared, 1, "widget clear requested once");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
