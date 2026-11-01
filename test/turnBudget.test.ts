/**
 * Per-request soft turn budget for terminal tasks (issue #30).
 *
 * `turns` / `toolUses` / `recentCalls` stay lifetime counters; the soft limit
 * applies to the turns since `turnBaseline`, which is captured before a
 * relaunch and granted (after a successful steer) on an explicit follow-up to
 * an active task. Everything runs against a fake `tmux` shim and a fake
 * terminal backend: no real panes, nested Pi, or models.
 */
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DeliveryGuard } from "../src/panel/delivery.ts";
import { startBackgroundPolling } from "../src/lifecycle/polling.ts";
import { startToolStatsPolling } from "../src/lifecycle/toolStats.ts";
import { resolveTaskResume } from "../src/lifecycle/task-resume.ts";
import { resolveConversationResume } from "../src/lifecycle/conversation-resume.ts";
import { executeTerminalTask } from "../src/lifecycle/terminal-execution.ts";
import type { BackgroundTask } from "../src/types.ts";

const STARTED_AT = 1_700_000_000_000;
const TASK_ID = "task-a";
const SESSION_NAME = "conv-a";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function turnLine(text: string): string {
  return JSON.stringify({
    type: "message",
    timestamp: new Date().toISOString(),
    message: { role: "assistant", content: [{ type: "text", text }] },
  }) + "\n";
}

function writeTurns(sessionDir: string, count: number): void {
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, `${SESSION_NAME}.jsonl`),
    JSON.stringify({ type: "session_info", name: SESSION_NAME }) + "\n" +
      Array.from({ length: count }, (_, i) => turnLine(`turn ${i}`)).join(""),
  );
}

function appendTurns(sessionDir: string, count: number): void {
  appendFileSync(
    join(sessionDir, `${SESSION_NAME}.jsonl`),
    Array.from({ length: count }, (_, i) => turnLine(`new ${i}`)).join(""),
  );
}

interface Harness {
  piDir: string;
  artifactsDir: string;
  sessionDir: string;
  registryFile: string;
  modeFile: string;
  backgroundTasks: Map<string, BackgroundTask>;
  deliveryGuard: DeliveryGuard;
  ctx: any;
}

let harness: Harness;
let originalPath: string | undefined;
const originalRegistryEnv = process.env.PI_TASK_TEST_REGISTRY;
const originalModeEnv = process.env.PI_TASK_TEST_TMUX_MODE;

function readRegistryEntry(): Record<string, any> {
  return (JSON.parse(readFileSync(harness.registryFile, "utf8")) as Array<Record<string, any>>)
    .find((entry) => entry.id === TASK_ID)!;
}

function writeRegistry(extra: Record<string, unknown> = {}): void {
  writeFileSync(
    harness.registryFile,
    JSON.stringify([
      {
        id: TASK_ID,
        agentType: "general",
        description: "original",
        sessionName: SESSION_NAME,
        conversationId: SESSION_NAME,
        startedAt: STARTED_AT,
        piDir: harness.piDir,
        dir: harness.artifactsDir,
        paneId: "%pane-1",
        maxTurns: 3,
        ownerSessionId: "old-owner",
        ownerLeafId: null,
        ...extra,
      },
    ]),
  );
}

function priorTask(extra: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    dir: harness.artifactsDir,
    agentType: "general",
    sessionName: SESSION_NAME,
    paneId: "%pane-1",
    backend: "tmux",
    originalPane: null,
    description: "original",
    startedAt: STARTED_AT,
    toolUses: 0,
    turns: 0,
    maxTurns: 3,
    recentCalls: [],
    ...extra,
  };
}

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-turn-budget-"));
  const artifactsDir = join(root, "artifacts");
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  const modeFile = join(root, "tmux-mode");
  const registryFile = join(root, "task-registry.json");
  writeFileSync(modeFile, "ok");
  // Fake tmux: alive pane unless the mode says "dead"; "corrupt" mangles the
  // registry while the follow-up is being delivered (after the steer started).
  writeFileSync(
    join(binDir, "tmux"),
    [
      "#!/bin/sh",
      'MODE=$(cat "$PI_TASK_TEST_TMUX_MODE" 2>/dev/null)',
      'case "$1" in',
      "  display-message)",
      '    if [ "$MODE" = dead ]; then printf \'%s\\n\' \'%gone\'; else printf \'%s\\n\' \'%pane-1\'; fi ;;',
      "  load-buffer)",
      "    cat >/dev/null",
      '    if [ "$MODE" = corrupt ]; then printf \'{bad\' > "$PI_TASK_TEST_REGISTRY"; fi ;;',
      "  *) exit 0 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(join(binDir, "tmux"), 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
  process.env.PI_TASK_TEST_REGISTRY = registryFile;
  process.env.PI_TASK_TEST_TMUX_MODE = modeFile;
  harness = {
    piDir: root,
    artifactsDir,
    sessionDir: join(artifactsDir, "sessions", TASK_ID),
    registryFile,
    modeFile,
    backgroundTasks: new Map(),
    deliveryGuard: new DeliveryGuard(),
    ctx: {
      sessionManager: {
        getSessionId: () => "new-owner",
        getLeafId: () => "leaf-1",
        getBranch: () => [{ id: "leaf-1" }],
      },
    },
  };
  mkdirSync(artifactsDir, { recursive: true });
});

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalRegistryEnv === undefined) delete process.env.PI_TASK_TEST_REGISTRY;
  else process.env.PI_TASK_TEST_REGISTRY = originalRegistryEnv;
  if (originalModeEnv === undefined) delete process.env.PI_TASK_TEST_TMUX_MODE;
  else process.env.PI_TASK_TEST_TMUX_MODE = originalModeEnv;
  rmSync(harness.piDir, { recursive: true, force: true });
});

type ResumeKind = "task_id" | "conversation_id";

function resume(kind: ResumeKind) {
  const taskParams = { agent_type: "general", prompt: "follow up", description: "follow up" };
  const common = {
    taskParams,
    agentName: "general",
    piDir: harness.piDir,
    artifactsDir: harness.artifactsDir,
    extensionPiDir: harness.piDir,
    ctx: harness.ctx,
    backgroundTasks: harness.backgroundTasks,
    deliveryGuard: harness.deliveryGuard,
    registryEntryStatus: () => "alive" as const,
  };
  const resolution = kind === "task_id"
    ? resolveTaskResume({ ...common, requestedTaskId: TASK_ID, conversationId: SESSION_NAME })
    : resolveConversationResume({ ...common, conversationId: SESSION_NAME, registeredTaskId: TASK_ID });
  assert.equal(resolution.kind, "handled", "active resume reattaches without launching");
  return (resolution as { kind: "handled"; result: { isError?: boolean; content: Array<{ text: string }> } }).result;
}

for (const kind of ["task_id", "conversation_id"] as const) {
  describe(`active follow-up via ${kind}`, () => {
    it("grants a fresh budget after a successful steer and enforces it by new turns", async () => {
      writeTurns(harness.sessionDir, 3); // historic turns == the limit
      writeRegistry();

      const result = resume(kind);
      assert.equal(result.isError, undefined, "follow-up delivered");

      const task = harness.backgroundTasks.get(TASK_ID);
      assert.ok(task, "reattached tracker");
      assert.equal(task.turnBaseline, 3, "baseline snapshots the lifetime turns before the steer");
      assert.equal(task.wrapUp, undefined);
      assert.equal(task.startedAt, STARTED_AT, "startedAt (and the hard timeout) are unchanged");
      assert.equal(task.maxTurns, 3);

      const persisted = readRegistryEntry();
      assert.equal(persisted.turnBaseline, 3, "baseline persisted");
      assert.equal("wrapUp" in persisted, false, "no wrap-up persisted");
      assert.equal(persisted.startedAt, STARTED_AT);
      assert.equal(persisted.maxTurns, 3, "other registry fields are merged, not replaced");
      assert.equal(persisted.ownerSessionId, "new-owner", "ownership transfer is kept");
      assert.equal(persisted.ownerPid, process.pid);

      const steered: string[] = [];
      const statsStop = startToolStatsPolling(new Map(), harness.backgroundTasks, 5);
      const stop = startBackgroundPolling(
        {
          backgroundTasks: harness.backgroundTasks,
          checkTaskCompletion: (async () => ({ status: "running", content: "" })) as any,
          clearTaskWidgetIfIdle: () => {},
          notifyUser: (text: string) => console.error(text),
          completeTask: (() => {}) as any,
          hardTimeoutMs: Number.POSITIVE_INFINITY,
          MAX_POLL_ERRORS: 3,
          piDir: harness.piDir,
          pi: {} as any,
          steerTask: (_task, prompt) => {
            steered.push(prompt);
            return true;
          },
        },
        10,
      );
      try {
        await sleep(80);
        assert.equal(task.turns, 3, "tracker still reports lifetime turns");
        assert.equal(steered.length, 0, "historic turns do not trigger an immediate wrap-up");
        appendTurns(harness.sessionDir, 2);
        await sleep(80);
        assert.equal(steered.length, 0, "2 new turns stay under the limit");
        appendTurns(harness.sessionDir, 1);
        await sleep(80);
      } finally {
        clearInterval(statsStop);
        stop();
      }
      assert.equal(steered.length, 1, "wrap-up fires after N new turns");
      assert.deepEqual(readRegistryEntry().wrapUp, { turnsAtStart: 6 }, "grace anchor is lifetime and persisted");
    });

    it("clears a prior wrap-up (memory and registry) only after the steer succeeds", () => {
      writeTurns(harness.sessionDir, 12);
      writeRegistry({ wrapUp: { turnsAtStart: 10 } });
      harness.backgroundTasks.set(
        TASK_ID,
        priorTask({ turns: 12, toolUses: 9, wrapUp: { turnsAtStart: 10 } }),
      );

      const result = resume(kind);
      assert.equal(result.isError, undefined);

      const task = harness.backgroundTasks.get(TASK_ID)!;
      assert.equal(task.turnBaseline, 12);
      assert.equal(task.wrapUp, undefined, "wrap-up cleared in memory");
      assert.equal(task.turns, 12, "lifetime tracker state is carried through the replacement");
      assert.equal(task.toolUses, 9);
      const persisted = readRegistryEntry();
      assert.equal(persisted.turnBaseline, 12);
      assert.equal("wrapUp" in persisted, false, "wrap-up cleared in the registry");
    });

    it("keeps the prior baseline, wrap-up and tracker state when the steer fails", () => {
      writeFileSync(harness.modeFile, "dead");
      writeTurns(harness.sessionDir, 12);
      writeRegistry({ turnBaseline: 2, wrapUp: { turnsAtStart: 10 } });
      harness.backgroundTasks.set(
        TASK_ID,
        priorTask({
          turns: 12,
          toolUses: 7,
          turnBaseline: 2,
          wrapUp: { turnsAtStart: 10 },
          recentCalls: [{ id: "c1", name: "read", detail: "x", status: "done" }],
        }),
      );

      const result = resume(kind);
      assert.equal(result.isError, true, "failed steer is reported");

      const task = harness.backgroundTasks.get(TASK_ID)!;
      assert.equal(task.turnBaseline, 2, "no budget granted");
      assert.deepEqual(task.wrapUp, { turnsAtStart: 10 }, "wrap-up not cleared");
      assert.equal(task.turns, 12);
      assert.equal(task.toolUses, 7);
      assert.equal(task.recentCalls.length, 1);
      assert.equal(task.startedAt, STARTED_AT);
      const persisted = readRegistryEntry();
      assert.equal(persisted.turnBaseline, 2);
      assert.deepEqual(persisted.wrapUp, { turnsAtStart: 10 });
    });

    it("carries the persisted baseline and wrap-up when no in-memory tracker exists and the steer fails", () => {
      writeFileSync(harness.modeFile, "dead");
      writeTurns(harness.sessionDir, 12);
      writeRegistry({ turnBaseline: 2, wrapUp: { turnsAtStart: 10 } });

      const result = resume(kind);
      assert.equal(result.isError, true);

      const task = harness.backgroundTasks.get(TASK_ID)!;
      assert.equal(task.turnBaseline, 2);
      assert.deepEqual(task.wrapUp, { turnsAtStart: 10 });
      const persisted = readRegistryEntry();
      assert.equal(persisted.turnBaseline, 2);
      assert.deepEqual(persisted.wrapUp, { turnsAtStart: 10 });
    });

    it("does not report a delivered follow-up as failed when budget persistence fails", () => {
      writeFileSync(harness.modeFile, "corrupt"); // registry is mangled mid-steer
      writeTurns(harness.sessionDir, 3);
      writeRegistry({ wrapUp: { turnsAtStart: 3 } });
      harness.backgroundTasks.set(TASK_ID, priorTask({ turns: 3, wrapUp: { turnsAtStart: 3 } }));

      const originalError = console.error;
      console.error = () => {};
      let result: ReturnType<typeof resume>;
      try {
        result = resume(kind);
      } finally {
        console.error = originalError;
      }
      assert.equal(readFileSync(harness.registryFile, "utf8"), "{bad", "the durable write really failed");
      assert.equal(result.isError, undefined, "steer succeeded, so the follow-up is not an error");
      assert.match(result.content[0]!.text, /delivered the follow-up/);
      const task = harness.backgroundTasks.get(TASK_ID)!;
      assert.equal(task.turnBaseline, 3, "budget still granted in memory");
      assert.equal(task.wrapUp, undefined);
    });
  });
}

describe("terminal relaunch of a finished session", () => {
  const herdrHandle = {
    backend: "herdr" as const,
    resourceId: "h-1",
    socketPath: "/tmp/fake-herdr.sock",
    terminalId: "term-1",
  };

  async function launch(options: {
    runtime?: "claude";
    onLaunch?: () => void;
  } = {}) {
    const terminalBackend = {
      kind: "herdr" as const,
      available: async () => true,
      launch: async () => {
        options.onLaunch?.();
        return herdrHandle;
      },
      isAlive: async () => true,
      send: async () => {},
      readTail: async () => "",
      close: async () => {},
    };
    return executeTerminalTask({
      id: TASK_ID,
      agentName: "general",
      description: "relaunch",
      sessionName: SESSION_NAME,
      sessionDir: harness.sessionDir,
      artifactsDir: harness.artifactsDir,
      cwd: harness.piDir,
      piDir: harness.piDir,
      prompt: "continue",
      piArgs: [],
      ...(options.runtime === "claude"
        ? { runtime: "claude" as const, claudeSessionId: "c1111111-2222-4333-8444-555555555555", claudeSessionFile: join(harness.piDir, "claude.jsonl") }
        : {}),
      selectedBackend: "herdr",
      requestedBackend: "herdr",
      terminalBackend: terminalBackend as any,
      agentMaxTurns: () => 3,
      ctx: harness.ctx,
      pi: { appendEntry() {} } as any,
      backgroundTasks: harness.backgroundTasks,
      foregroundTasks: new Map(),
      deliveryGuard: harness.deliveryGuard,
      clearTaskWidgetIfIdle: () => {},
      ensureTaskWidget: () => {},
    });
  }

  it("snapshots historic Pi turns before launch and forwards them to the registry", async () => {
    writeTurns(harness.sessionDir, 3);
    const result = await launch({ onLaunch: () => appendTurns(harness.sessionDir, 2) });
    assert.equal((result as { isError?: boolean }).isError, undefined);

    const task = harness.backgroundTasks.get(TASK_ID);
    assert.ok(task);
    assert.equal(task.turnBaseline, 3, "baseline is read BEFORE the child can add turns");
    assert.equal(readRegistryEntry().turnBaseline, 3, "baseline reaches the registry through registration");
    assert.ok(task.startedAt > STARTED_AT, "relaunch keeps its own fresh startedAt");
  });

  it("keeps the baseline at 0 for a fresh session", async () => {
    await launch();
    const task = harness.backgroundTasks.get(TASK_ID)!;
    assert.equal(task.turnBaseline ?? 0, 0);
    assert.equal(readRegistryEntry().turnBaseline ?? 0, 0);
  });

  it("does not alter Claude counting", async () => {
    writeTurns(harness.sessionDir, 3);
    await launch({ runtime: "claude" });
    const task = harness.backgroundTasks.get(TASK_ID)!;
    assert.equal(task.turnBaseline ?? 0, 0);
    assert.equal(readRegistryEntry().turnBaseline ?? 0, 0);
  });
});
