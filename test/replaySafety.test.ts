/**
 * Replay safety for fresh task starts, adapted from pi-durable's subagent
 * example (packages/durable/test/examples/22-subagent-foreground.ts):
 * find-before-create keyed by the owner, so a re-invocation of the same
 * delegation returns the live task instead of spawning a twin that burns
 * tokens. Identity is the intent hash (agent + prompt + cwd + mode), scanned
 * against the registry — the surviving children; SDK and foreground runs die
 * with the parent process, so they cannot have live twins.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import taskExtension from "../src/index.js";
import { startIntentHash } from "../src/task-intent.js";

// Delegated pi-task children disable recursive registration; this test exercises host registration.
const inheritedTaskToolDisabled = process.env.PI_TASK_TOOL_DISABLED;
delete process.env.PI_TASK_TOOL_DISABLED;
process.on("exit", () => {
  if (inheritedTaskToolDisabled === undefined) delete process.env.PI_TASK_TOOL_DISABLED;
  else process.env.PI_TASK_TOOL_DISABLED = inheritedTaskToolDisabled;
});

const baseParams = {
  agent_type: "explore",
  description: "Map the auth module",
  prompt: "Trace the login flow and report entry points.",
  background: true,
};

test("the intent hash is stable and sensitive to every identity field", () => {
  const a = startIntentHash({
    agentName: "explore",
    params: baseParams,
    ctxCwd: "/repo",
    claudeRuntime: false,
  });
  const again = startIntentHash({
    agentName: "explore",
    params: { ...baseParams },
    ctxCwd: "/repo",
    claudeRuntime: false,
  });
  assert.equal(a, again, "same intent, same hash");
  assert.ok(a && a.length > 0);

  const variants = [
    { name: "prompt", params: { ...baseParams, prompt: "Different prompt." } },
    { name: "description", params: { ...baseParams, description: "Other work" } },
    { name: "agent", agentName: "general" },
    { name: "cwd", ctxCwd: "/other" },
    { name: "background", params: { ...baseParams, background: false } },
    { name: "thinking", params: { ...baseParams, thinking: "high" } },
    { name: "workspace", params: { ...baseParams, workspace_group: "w1" } },
    { name: "runtime", claudeRuntime: true },
  ] as const;
  for (const variant of variants) {
    const other = startIntentHash({
      agentName: ("agentName" in variant ? variant.agentName : "explore") as string,
      params: ("params" in variant ? variant.params : baseParams) as typeof baseParams,
      ctxCwd: ("ctxCwd" in variant ? variant.ctxCwd : "/repo") as string,
      claudeRuntime: ("claudeRuntime" in variant ? variant.claudeRuntime : false) as boolean,
    });
    assert.notEqual(other, a, `hash must differ on ${variant.name}`);
  }
});

test("resume and compare starts have no intent hash", () => {
  for (const params of [
    { ...baseParams, task_id: "t1" },
    { ...baseParams, conversation_id: "c1" },
    { ...baseParams, compare: true },
  ]) {
    assert.equal(
      startIntentHash({
        agentName: "explore",
        params: params as typeof baseParams,
        ctxCwd: "/repo",
        claudeRuntime: false,
      }),
      undefined,
      JSON.stringify(params),
    );
  }
});

interface RegistryEntryLike {
  id: string;
  intentHash?: string;
  ownerSessionId?: string;
}

function makeContext(cwd: string, sessionId: string) {
  return {
    cwd,
    sessionManager: {
      getSessionId: () => sessionId,
      getLeafId: () => null,
      getCwd: () => cwd,
    },
  } as never;
}

function seedRegistry(piDir: string, entries: RegistryEntryLike[]): void {
  mkdirSync(piDir, { recursive: true });
  writeFileSync(
    join(piDir, "task-registry.json"),
    JSON.stringify(entries, null, 2),
  );
}

function readRawRegistry(piDir: string): RegistryEntryLike[] {
  return JSON.parse(readFileSync(join(piDir, "task-registry.json"), "utf8"));
}

function executeTask(cwd: string, params: Record<string, unknown>) {
  let tool:
    | { execute: (...args: unknown[]) => Promise<{ content?: { text?: string }[]; details?: Record<string, unknown> }> }
    | undefined;
  let shutdown: (() => void) | undefined;
  const pi = {
    on(event: string, handler: () => void) {
      if (event === "session_shutdown") shutdown = handler;
    },
    registerMessageRenderer() {},
    registerFlag() {},
    getFlag() {
      return undefined;
    },
    registerTool(value: typeof tool) {
      tool = value;
    },
    registerCommand() {},
    getAllTools() {
      return [];
    },
  };
  taskExtension(pi as never);
  const pending = tool!.execute(
    "replay-safety",
    { agent_type: "explore", prompt: "Inspect only", description: "Inspect cwd", ...params },
    undefined,
    undefined,
    makeContext(cwd, "sess-1"),
  );
  return { pending, done: async () => {
    const result = await pending;
    shutdown?.();
    return result;
  } };
}

test("a live registry twin returns its task instead of spawning", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-replay-"));
  try {
    const piDir = join(root, ".pi");
    const hash = startIntentHash({
      agentName: "explore",
      params: baseParams,
      ctxCwd: root,
      claudeRuntime: false,
    })!;
    seedRegistry(piDir, [
      {
        id: "t-twin",
        intentHash: hash,
        ownerSessionId: "sess-1",
      },
    ]);

    const { done } = executeTask(root, { ...baseParams, cwd: root, background: true });
    const result = await done();

    assert.equal(result.details?.duplicate_start, true, JSON.stringify(result.details));
    assert.equal(result.details?.task_id, "t-twin");
    assert.match(result.content?.[0]?.text ?? "", /t-twin/);
    assert.equal(readRawRegistry(piDir).length, 1, "no new task registered");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a different prompt starts normally", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-replay-"));
  try {
    const piDir = join(root, ".pi");
    const hash = startIntentHash({
      agentName: "explore",
      params: baseParams,
      ctxCwd: root,
      claudeRuntime: false,
    })!;
    seedRegistry(piDir, [
      { id: "t-twin", intentHash: hash, ownerSessionId: "sess-1" },
    ]);

    // A different prompt has a different intent: the twin must not block it.
    const different = executeTask(root, {
      ...baseParams,
      cwd: root,
      background: true,
      prompt: "A different delegation entirely.",
    });
    const differentResult = await different.done();
    assert.equal(
      differentResult.details?.duplicate_start,
      undefined,
      "a different prompt must not be treated as a twin",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a twin owned by another session never blocks this session", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-replay-"));
  try {
    const piDir = join(root, ".pi");
    const hash = startIntentHash({
      agentName: "explore",
      params: baseParams,
      ctxCwd: root,
      claudeRuntime: false,
    })!;
    seedRegistry(piDir, [
      { id: "t-other", intentHash: hash, ownerSessionId: "other-session" },
    ]);

    const other = executeTask(root, { ...baseParams, cwd: root, background: true });
    const otherResult = await other.done();
    assert.equal(
      otherResult.details?.duplicate_start,
      undefined,
      "another session's twin must not block this session",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
