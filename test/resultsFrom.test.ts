/**
 * `results_from`: a task names the settled task ids whose results it needs, and
 * admission injects them as one prompt section.
 *
 * These tests drive the real `task` tool so the schema, validation, history
 * persistence, and prompt assembly are all exercised together. Children are
 * never launched: every case either resolves against seeded durable history or
 * is refused before a backend is chosen (a refusal is the assertion).
 */

import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import taskExtension from "../src/index.js";
import {
  readTaskSessionHistory,
  upsertTaskSessionHistory,
} from "../src/conversation.js";
import {
  RESULT_INJECTION_LIMIT_CHARS,
  formatResultInjection,
  truncateResultText,
} from "../src/result-passing.js";
import { resolveResultsFrom } from "../src/lifecycle/result-resolution.js";
import type { SessionView } from "../src/panel/delivery.js";
import { buildTaskPrompt, taskParametersSchema } from "../src/tool/index.js";
import type { TaskSessionHistoryEntry } from "../src/types.js";

// Delegated pi-task children disable recursive registration; these tests
// exercise host registration.
const inheritedTaskToolDisabled = process.env.PI_TASK_TOOL_DISABLED;
delete process.env.PI_TASK_TOOL_DISABLED;
process.on("exit", () => {
  if (inheritedTaskToolDisabled === undefined) delete process.env.PI_TASK_TOOL_DISABLED;
  else process.env.PI_TASK_TOOL_DISABLED = inheritedTaskToolDisabled;
});

const SESSION_ID = "sess-results-from";
const LEAF_ID = "leaf-results-from";

function makeSession(over: Partial<{ id: string; leafId: string | null; branchIds: string[] }> = {}): SessionView {
  const id = over.id ?? SESSION_ID;
  const leafId = over.leafId !== undefined ? over.leafId : LEAF_ID;
  const branchIds = over.branchIds ?? ["root", LEAF_ID];
  return {
    getSessionId: () => id,
    getLeafId: () => leafId,
    getBranch: () => branchIds.map((entryId) => ({ id: entryId })),
  };
}

interface HistorySeed {
  id: string;
  agentType?: string;
  status?: TaskSessionHistoryEntry["status"];
  resultText?: string;
  ownerSessionId?: string;
  ownerLeafId?: string | null;
  completedAt?: number;
}

/** Seed one settled task's durable history record. */
function seedTask(piDir: string, seed: HistorySeed): TaskSessionHistoryEntry {
  const entry: TaskSessionHistoryEntry = {
    id: seed.id,
    agentType: seed.agentType ?? "explore",
    description: `${seed.id} work`,
    sessionName: `task-${seed.id}`,
    startedAt: Date.now() - 60_000,
    piDir,
    dir: join(piDir, "artifacts", "tasks"),
    status: seed.status ?? "done",
    background: true,
    completedAt: seed.completedAt ?? Date.now() - 30_000,
    ownerSessionId: seed.ownerSessionId ?? SESSION_ID,
    ownerLeafId: seed.ownerLeafId === undefined ? LEAF_ID : seed.ownerLeafId,
    ...(seed.resultText !== undefined ? { resultText: seed.resultText } : {}),
  };
  upsertTaskSessionHistory(piDir, entry);
  return entry;
}

function tempProject(): { root: string; piDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pi-task-results-from-"));
  const piDir = join(root, ".pi");
  mkdirSync(join(piDir, "artifacts", "tasks"), { recursive: true });
  return { root, piDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// ─── Prompt formatting ───────────────────────────────────────────────────────

test("results_from is an optional string array on the tool schema", () => {
  const schema = taskParametersSchema() as unknown as {
    properties: Record<string, { type?: string; items?: { type?: string } }>;
  };
  const property = schema.properties.results_from;
  assert.ok(property, "results_from is advertised to the model");
  assert.equal(property.type, "array");
  assert.equal(property.items?.type, "string");
});

test("injected results sit at the end of the prompt, before the closing instructions", () => {
  const injection = formatResultInjection([
    { taskId: "t-1", agentType: "explore", content: "auth entry points: login.ts" },
    { taskId: "t-2", agentType: "scout", content: "prior art: playwright" },
  ]);
  const prompt = buildTaskPrompt({
    description: "fan-in",
    agentName: "general",
    agentSource: "bundled",
    prompt: "Implement the change from these findings.",
    cwd: "/repo",
    results: injection,
  });

  // One labeled section, one header per source with id and agent type.
  assert.match(prompt, /## Results from previous tasks/);
  assert.match(prompt, /## Result from t-1 \(explore\)\n\nauth entry points: login\.ts/);
  assert.match(prompt, /## Result from t-2 \(scout\)\n\nprior art: playwright/);
  assert.ok(
    prompt.indexOf("## Result from t-1") < prompt.indexOf("## Result from t-2"),
    "caller order is preserved",
  );

  // Placed after the handoff sections and immediately before the closing
  // instructions, so the child reads its inputs before it starts reporting.
  assert.ok(prompt.indexOf("## Results from previous tasks") > prompt.indexOf("## Handoff integrity"));
  assert.ok(
    prompt.indexOf("## Results from previous tasks") <
      prompt.indexOf("Your final assistant message IS the result"),
    "results precede the closing instructions",
  );
  assert.ok(prompt.trimEnd().endsWith("not from any file."), "instructions stay last");
});

test("a prompt without results_from carries no results section", () => {
  const prompt = buildTaskPrompt({
    description: "plain",
    agentName: "general",
    agentSource: "bundled",
    prompt: "Do the work.",
    cwd: "/repo",
  });
  assert.doesNotMatch(prompt, /Results from previous tasks/);
  assert.doesNotMatch(prompt, /## Result from /);
});

test("one long result is truncated at the injection limit", () => {
  const long = "x".repeat(RESULT_INJECTION_LIMIT_CHARS + 2_500);
  const truncated = truncateResultText(long);
  assert.equal(
    truncated,
    `${"x".repeat(RESULT_INJECTION_LIMIT_CHARS)}\n[truncated: 2500 more characters]`,
  );
  // Short text is passed through untouched: no marker for a result that fits.
  assert.equal(truncateResultText("short"), "short");
});

// ─── Admission resolution ───────────────────────────────────────────────────

test("results_from resolves settled task results in caller order", () => {
  const project = tempProject();
  try {
    seedTask(project.piDir, { id: "t-auth", resultText: "login flow starts at auth/login.ts" });
    seedTask(project.piDir, {
      id: "t-api",
      agentType: "scout",
      resultText: "the API keeps sessions in Redis",
    });

    const resolution = resolveResultsFrom({
      piDir: project.piDir,
      ids: ["t-auth", "t-api"],
      session: makeSession(),
    });
    assert.equal(resolution.kind, "resolved");
    assert(resolution.kind === "resolved");
    assert.deepEqual(
      resolution.results.map((result) => [result.taskId, result.agentType]),
      [["t-auth", "explore"], ["t-api", "scout"]],
    );
    assert.match(resolution.injection, /## Result from t-auth \(explore\)/);
    assert.match(resolution.injection, /login flow starts at auth\/login\.ts/);
    assert.match(resolution.injection, /## Result from t-api \(scout\)/);
  } finally {
    project.cleanup();
  }
});

test("results_from rejects a task id that does not exist, naming it", () => {
  const project = tempProject();
  try {
    const resolution = resolveResultsFrom({
      piDir: project.piDir,
      ids: ["t-ghost"],
      session: makeSession(),
    });
    assert.equal(resolution.kind, "rejected");
    assert(resolution.kind === "rejected");
    assert.equal(resolution.result.isError, true);
    assert.equal(resolution.result.details.error, "unknown_results_from");
    assert.equal(resolution.result.details.task_id, "t-ghost");
    assert.match(resolution.result.content[0].text, /t-ghost/);
  } finally {
    project.cleanup();
  }
});

test("results_from refuses an unsettled task instead of injecting a partial answer", () => {
  const project = tempProject();
  try {
    for (const status of ["running", "failed", "cancelled", "timeout"] as const) {
      seedTask(project.piDir, { id: `t-${status}`, status, resultText: "partial work" });
      const resolution = resolveResultsFrom({
        piDir: project.piDir,
        ids: [`t-${status}`],
        session: makeSession(),
      });
      assert.equal(resolution.kind, "rejected", status);
      assert(resolution.kind === "rejected");
      assert.equal(resolution.result.details.error, "results_from_not_settled", status);
      assert.equal(resolution.result.details.task_status, status);
    }
  } finally {
    project.cleanup();
  }
});

test("results_from refuses a task id that is this task's own id", () => {
  const project = tempProject();
  try {
    seedTask(project.piDir, { id: "t-self", resultText: "its own answer" });
    const resolution = resolveResultsFrom({
      piDir: project.piDir,
      ids: ["t-self"],
      session: makeSession(),
      selfTaskId: "t-self",
    });
    assert.equal(resolution.kind, "rejected");
    assert(resolution.kind === "rejected");
    assert.equal(resolution.result.details.error, "results_from_self_reference");
  } finally {
    project.cleanup();
  }
});

test("results_from reuses the delivery-guard owner rule", () => {
  const project = tempProject();
  try {
    seedTask(project.piDir, { id: "t-owned", resultText: "owned result" });

    // Another session must not read it.
    const otherSession = resolveResultsFrom({
      piDir: project.piDir,
      ids: ["t-owned"],
      session: makeSession({ id: "sess-other" }),
    });
    assert.equal(otherSession.kind, "rejected");
    assert(otherSession.kind === "rejected");
    assert.equal(otherSession.result.details.error, "results_from_foreign_owner");

    // The same session on a branch that no longer descends from the spawn
    // point is refused too, exactly as a completion notice would be.
    const otherBranch = resolveResultsFrom({
      piDir: project.piDir,
      ids: ["t-owned"],
      session: makeSession({ leafId: "leaf-elsewhere", branchIds: ["root", "leaf-elsewhere"] }),
    });
    assert.equal(otherBranch.kind, "rejected");
    assert(otherBranch.kind === "rejected");
    assert.equal(otherBranch.result.details.error, "results_from_foreign_owner");

    // A task with no recorded owner (legacy) never blocks: nothing to check.
    seedTask(project.piDir, { id: "t-legacy", resultText: "legacy" });
    const history = readTaskSessionHistory(project.piDir);
    const legacyIndex = history.findIndex((entry) => entry.id === "t-legacy");
    writeFileSync(
      join(project.piDir, "task-session-history.json"),
      `${JSON.stringify(
        history.map((entry, index) =>
          index === legacyIndex ? { ...entry, ownerSessionId: undefined } : entry,
        ),
        null,
        2,
      )}\n`,
    );
    const legacy = resolveResultsFrom({
      piDir: project.piDir,
      ids: ["t-legacy"],
      session: makeSession({ id: "sess-anyone" }),
    });
    assert.equal(legacy.kind, "resolved");
  } finally {
    project.cleanup();
  }
});

test("a long recorded result is truncated on the way into the prompt", () => {
  const project = tempProject();
  try {
    const long = `start ${"y".repeat(RESULT_INJECTION_LIMIT_CHARS)} end`;
    seedTask(project.piDir, { id: "t-long", resultText: long });
    const resolution = resolveResultsFrom({
      piDir: project.piDir,
      ids: ["t-long"],
      session: makeSession(),
    });
    assert(resolution.kind === "resolved");
    assert.equal(resolution.results[0].content.length > RESULT_INJECTION_LIMIT_CHARS, true);
    assert.match(resolution.results[0].content, /\[truncated: \d+ more characters\]/);
    assert.ok(
      !resolution.injection.includes("end"),
      "the tail beyond the cap never reaches the child prompt",
    );
  } finally {
    project.cleanup();
  }
});

test("a settled task with no recorded result text falls back to its session file", () => {
  const project = tempProject();
  try {
    const id = "t-fallback";
    const sessionDir = join(project.piDir, "artifacts", "tasks", "sessions", id);
    mkdirSync(sessionDir, { recursive: true });
    const startedAt = Date.now() - 60_000;
    writeFileSync(
      join(sessionDir, "task-t-fallback.jsonl"),
      [
        JSON.stringify({ type: "session_info", name: "task-t-fallback" }),
        JSON.stringify({
          type: "message",
          timestamp: new Date().toISOString(),
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "Status: success\nFound three call sites." }],
          },
        }),
      ].join("\n") + "\n",
    );
    upsertTaskSessionHistory(project.piDir, {
      id,
      agentType: "explore",
      description: "fallback",
      sessionName: "task-t-fallback",
      startedAt,
      piDir: project.piDir,
      dir: join(project.piDir, "artifacts", "tasks"),
      status: "done",
      background: true,
      ownerSessionId: SESSION_ID,
      ownerLeafId: LEAF_ID,
      completedAt: Date.now(),
    });
    // The upsert recorded the text itself; drop it to force the file path.
    const history = readTaskSessionHistory(project.piDir);
    writeFileSync(
      join(project.piDir, "task-session-history.json"),
      `${JSON.stringify(history.map(({ resultText: _drop, ...entry }) => entry), null, 2)}\n`,
    );

    const resolution = resolveResultsFrom({
      piDir: project.piDir,
      ids: [id],
      session: makeSession(),
    });
    assert.equal(resolution.kind, "resolved");
    assert(resolution.kind === "resolved");
    assert.match(resolution.results[0].content, /Found three call sites\./);
  } finally {
    project.cleanup();
  }
});

// ─── Persistence at settle time ─────────────────────────────────────────────

test("a done record persists its result text, bounded, and a new run clears it", () => {
  const project = tempProject();
  try {
    const id = "t-persist";
    const sessionDir = join(project.piDir, "artifacts", "tasks", "sessions", id);
    mkdirSync(sessionDir, { recursive: true });
    const finished = "Status: success\nThe migration is safe to run.";
    writeFileSync(
      join(sessionDir, "task-t-persist.jsonl"),
      [
        JSON.stringify({ type: "session_info", name: "task-t-persist" }),
        JSON.stringify({
          type: "message",
          timestamp: new Date().toISOString(),
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: finished }],
          },
        }),
      ].join("\n") + "\n",
    );
    const base = {
      id,
      agentType: "general",
      description: "persist",
      sessionName: "task-t-persist",
      startedAt: Date.now() - 60_000,
      piDir: project.piDir,
      dir: join(project.piDir, "artifacts", "tasks"),
      background: true,
      ownerSessionId: SESSION_ID,
      ownerLeafId: LEAF_ID,
    };
    upsertTaskSessionHistory(project.piDir, { ...base, status: "done", completedAt: Date.now() });

    const settled = readTaskSessionHistory(project.piDir).find((entry) => entry.id === id);
    assert.ok(settled?.resultText, "the settle write records the child's final text");
    assert.match(settled!.resultText!, /migration is safe to run/);

    // A failed run must not keep the previous answer around as its own.
    upsertTaskSessionHistory(project.piDir, { ...base, status: "failed", completedAt: Date.now() });
    const failed = readTaskSessionHistory(project.piDir).find((entry) => entry.id === id);
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.resultText, undefined, "a failed run has no injectable result");

    // And a fresh run of the same id starts clean.
    upsertTaskSessionHistory(project.piDir, { ...base, status: "done", completedAt: Date.now() });
    upsertTaskSessionHistory(project.piDir, { ...base, status: "running" });
    const running = readTaskSessionHistory(project.piDir).find((entry) => entry.id === id);
    assert.equal(running?.status, "running");
    assert.equal(running?.resultText, undefined, "a new run does not inherit the old result");
  } finally {
    project.cleanup();
  }
});

// ─── Through the tool: admission and injection ───────────────────────────────

function registerTaskTool() {
  let tool:
    | { execute: (...args: unknown[]) => Promise<{ isError?: boolean; content?: Array<{ text: string }>; details?: Record<string, unknown> }> }
    | undefined;
  let shutdown: (() => void) | undefined;
  taskExtension({
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
    appendEntry() {},
    getAllTools() {
      return [];
    },
  } as never);
  assert.ok(tool, "the task tool is registered");
  return { tool, shutdown: () => shutdown?.() };
}

const TASK_CONTEXT = {
  sessionManager: {
    getSessionId: () => SESSION_ID,
    getLeafId: () => LEAF_ID,
    getBranch: () => [{ id: "root" }, { id: LEAF_ID }],
  },
};

test("the task tool refuses a results_from id that does not exist", async () => {
  const project = tempProject();
  const registered = registerTaskTool();
  try {
    const result = await registered.tool.execute(
      "results-from-unknown",
      {
        agent_type: "general",
        prompt: "Use the earlier result.",
        description: "fan-in",
        results_from: ["t-does-not-exist"],
        background: false,
      },
      undefined,
      undefined,
      { cwd: project.root, isProjectTrusted: () => true, ...TASK_CONTEXT },
    );
    assert.equal(result.isError, true);
    assert.equal(result.details?.error, "unknown_results_from");
    assert.equal(result.details?.task_id, "t-does-not-exist");
    assert.match(result.content?.[0]?.text ?? "", /t-does-not-exist/);
  } finally {
    registered.shutdown();
    project.cleanup();
  }
});

// The injected section must reach the real child prompt, not just the prompt
// builder. This drives a background launch: a foreground task would block in
// `waitForTaskCompletion` waiting for a child that the fake backend never
// produces (its pane stays "alive" until the hard timeout), which is a hang,
// not a failure. The launch script the terminal backend writes carries the
// full prompt, so it is the artifact to assert.
test("the task tool accepts a results_from list of settled tasks", {
  skip: process.platform === "win32" ? "tmux backend is POSIX only" : false,
}, async () => {
  const project = tempProject();
  const registered = registerTaskTool();
  const savedPath = process.env.PATH;
  const savedTmux = process.env.TMUX;
  const savedBackend = process.env.PI_TASK_BACKEND;
  try {
    seedTask(project.piDir, {
      id: "t-done",
      resultText: "Status: success\nThe auth flow starts in login.ts.",
    });
    seedTask(project.piDir, {
      id: "t-scout",
      agentType: "scout",
      resultText: "Status: success\nPrior art lives in axe-core.",
    });
    const binDir = join(project.root, "bin");
    mkdirSync(binDir);
    const tmux = join(binDir, "tmux");
    writeFileSync(
      tmux,
      `#!/bin/sh\ncase "$1" in\n  -V) printf '%s\\n' 'tmux 3.4' ;;\n  display-message) case "$*" in *pane_width*) printf '%s\\n' '120 40' ;; *) printf '%s\\n' '%pane-1' ;; esac ;;\n  split-window) printf '%s\\n' '%pane-1' ;;\n  *) exit 0 ;;\nesac\n`,
    );
    chmodSync(tmux, 0o755);
    process.env.PATH = `${binDir}:${savedPath ?? ""}`;
    process.env.TMUX = join(project.root, "tmux.sock");
    process.env.PI_TASK_BACKEND = "tmux";

    const result = await registered.tool.execute(
      "results-from-accepted",
      {
        agent_type: "general",
        prompt: "Implement the change these findings imply.",
        description: "fan-in",
        results_from: ["t-done", "t-scout"],
        background: true,
      },
      undefined,
      undefined,
      { cwd: project.root, isProjectTrusted: () => true, ...TASK_CONTEXT },
    );
    assert.equal(result.isError, undefined, JSON.stringify(result.details ?? result.content));

    // The injected results travel in the child prompt: read the launch script
    // the terminal backend wrote for this task.
    const taskId = String(result.details?.task_id ?? "");
    assert.ok(taskId, "the task was admitted with an id");
    const launchScript = readFileSync(
      join(project.piDir, "artifacts", "tasks", "sessions", taskId, "pane-launch.sh"),
      "utf8",
    );
    assert.match(launchScript, /## Results from previous tasks/);
    assert.match(launchScript, /## Result from t-done \(explore\)/);
    assert.match(launchScript, /## Result from t-scout \(scout\)/);
    assert.match(launchScript, /The auth flow starts in login\.ts\./);
    assert.match(launchScript, /Prior art lives in axe-core\./);
    // The parent adapter is still intact: the results section sits before the
    // closing instructions rather than replacing them.
    assert.ok(
      launchScript.indexOf("## Results from previous tasks") <
        launchScript.indexOf("Your final assistant message IS the result"),
      "results precede the closing instructions",
    );
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = savedTmux;
    if (savedBackend === undefined) delete process.env.PI_TASK_BACKEND;
    else process.env.PI_TASK_BACKEND = savedBackend;
    registered.shutdown();
    project.cleanup();
  }
});
