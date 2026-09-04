import { strict as assert } from "node:assert";
import { setTimeout as sleep } from "node:timers/promises";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import taskExtension from "../src/index.js";
import { TASK_PROMPT_INSTRUCTIONS } from "../src/helpers.js";
import { buildTaskFollowUpPrompt, buildTaskPrompt, taskParametersSchema } from "../src/tool/index.js";
import { resolveTaskCwd } from "../src/task-cwd.js";
import { upsertTaskSessionHistory } from "../src/conversation.js";

// Delegated pi-task children disable recursive registration; this test exercises host registration.
const inheritedTaskToolDisabled = process.env.PI_TASK_TOOL_DISABLED;
delete process.env.PI_TASK_TOOL_DISABLED;
process.on("exit", () => {
  if (inheritedTaskToolDisabled === undefined) delete process.env.PI_TASK_TOOL_DISABLED;
  else process.env.PI_TASK_TOOL_DISABLED = inheritedTaskToolDisabled;
});

{
  const t = "buildTaskPrompt workspace scope";
  const prompt = buildTaskPrompt({
    description: "smoke",
    agentName: "explore",
    agentSource: "project",
    prompt: "Find foo",
    cwd: "/tmp/parent-cwd",
  });
  assert.ok(prompt.includes("/tmp/parent-cwd"), t + " cwd");
  assert.ok(prompt.includes("## Workspace scope"), t + " section");
  assert.ok(prompt.includes("Default workspace: /tmp/parent-cwd."), t + " default workspace");
  assert.ok(!prompt.includes("parent Pi session cwd"), t + " does not mislabel task cwd");
  assert.ok(prompt.includes("Do not search sibling repositories"), t + " boundary");
  assert.ok(prompt.includes("explore"), t + " explore rule");
}

{
  const t = "task prompt makes context handoff explicit";
  const prompt = buildTaskPrompt({
    description: "audit",
    agentName: "reviewer",
    agentSource: "bundled",
    prompt: "Goal: audit the manifest.",
    parentContext: "The parent found naming drift in manifest and session records.",
    proposedChanges: [
      "stable stepId: one durable identifier per logical step, preserved across retries",
      "tool_batch_started: record the batch boundary before tool execution",
    ],
    cwd: "/repo",
  });
  assert.match(prompt, /## Parent context/);
  assert.match(prompt, /naming drift in manifest/);
  assert.match(prompt, /## Proposed changes/);
  assert.match(prompt, /stable stepId: one durable identifier per logical step/);
  assert.match(prompt, /## Workspace scope/);
  assert.doesNotMatch(prompt, /## Working Directory/);
  assert.match(prompt, /## Handoff integrity/);
  assert.match(prompt, /A referenced file is evidence, not a context handoff/);
  assert.match(prompt, /enumerate every proposed change/);

  const followUp = buildTaskFollowUpPrompt({
    prompt: "Continue the audit.",
    parentContext: "The parent clarified the retry identity requirement.",
    proposedChanges: ["abort closure id: preserve the id through cancellation cleanup"],
  });
  assert.match(followUp, /retry identity requirement/);
  assert.match(followUp, /abort closure id: preserve the id/);
}

{
  const t = "task cwd is an explicit validated public contract";
  const schema = taskParametersSchema() as {
    properties?: Record<string, { description?: string }>;
    anyOf?: Array<{ properties?: Record<string, { description?: string }> }>;
  };
  const startSchema = schema.anyOf?.find((candidate) => candidate.properties?.cwd) ?? schema;
  const cwdSchema = startSchema.properties?.cwd;
  assert.ok(cwdSchema, t + " schema");
  assert.match(cwdSchema.description ?? "", /absolute existing directory/i, t + " validation docs");
  assert.match(cwdSchema.description ?? "", /does not create.*worktree/i, t + " lifecycle docs");
  const promptSchema = schema.properties?.prompt;
  assert.ok(promptSchema, t + " prompt schema");
  assert.match(promptSchema.description ?? "", /parent_context.*proposed_changes/i, t + " handoff docs");

  let tool: { execute: (...args: unknown[]) => Promise<{ isError?: boolean; details?: { error?: string } }> } | undefined;
  let shutdown: (() => void) | undefined;
  const pi = {
    on(event: string, handler: () => void) {
      if (event === "session_shutdown") shutdown = handler;
    },
    registerMessageRenderer() {},
      registerFlag() {},
    registerTool(value: typeof tool) {
      tool = value;
    },
    registerCommand() {},
    getAllTools() {
      return [];
    },
  };
  taskExtension(pi as never);
  assert.ok(tool, t + " registration");
  const result = await tool.execute(
    "cwd-contract",
    {
      agent_type: "explore",
      prompt: "Inspect only",
      description: "Inspect cwd",
      cwd: "relative/worktree",
      background: false,
    },
    undefined,
    undefined,
    { cwd: process.cwd() },
  );
  shutdown?.();
  assert.equal(result.isError, true, t + " rejected");
  assert.equal(result.details?.error, "invalid cwd", t + " error contract");
}

{
  const t = "task cwd resume precedence";
  const root = mkdtempSync(join(tmpdir(), "pi-task-cwd-"));
  const persisted = join(root, "persisted-worktree");
  const explicit = join(root, "replacement-worktree");
  try {
    mkdirSync(persisted);
    mkdirSync(explicit);
    assert.deepEqual(resolveTaskCwd(root, undefined, persisted), {
      kind: "resolved",
      cwd: persisted,
    }, t + " persisted default");
    assert.deepEqual(resolveTaskCwd(root, explicit, persisted), {
      kind: "resolved",
      cwd: explicit,
    }, t + " explicit override");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.platform !== "win32") {
  const t = "active durable conversations reject foreground relaunch";
  const root = mkdtempSync(join(tmpdir(), "pi-task-active-cwd-"));
  const piDir = join(root, ".pi");
  const artifactsDir = join(piDir, "artifacts", "tasks");
  const originalPath = process.env.PATH;
  const originalTmux = process.env.TMUX;
  const originalBackend = process.env.PI_TASK_BACKEND;
  let shutdown: (() => void) | undefined;
  try {
    mkdirSync(artifactsDir, { recursive: true });
    const binDir = join(root, "bin");
    mkdirSync(binDir);
    const tmux = join(binDir, "tmux");
    writeFileSync(tmux, "#!/bin/sh\ncase \"$1\" in\n  -V|display-message) printf '%s\\n' '%pane-1' ;;\n  *) exit 0 ;;\nesac\n");
    chmodSync(tmux, 0o755);
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    process.env.TMUX = join(root, "tmux.sock");
    process.env.PI_TASK_BACKEND = "invalid-after-active-check";

    writeFileSync(join(piDir, "task-registry.json"), JSON.stringify([{
      id: "active-task",
      agentType: "explore",
      description: "active isolated task",
      sessionName: "active-conversation",
      startedAt: Date.now() - 1000,
      handle: {
        backend: "tmux",
        resourceId: "%pane-1",
      },
      piDir,
      dir: artifactsDir,
      cwd: root,
      conversationId: "active-conversation",
    }]));
    writeFileSync(join(piDir, "task-session-history.json"), JSON.stringify([{
      id: "active-task",
      agentType: "explore",
      description: "active isolated task",
      sessionName: "active-conversation",
      startedAt: Date.now() - 1000,
      piDir,
      dir: artifactsDir,
      cwd: root,
      conversationId: "active-conversation",
      status: "running",
      background: true,
    }]));
    writeFileSync(join(piDir, "artifacts", "task-sessions.json"), JSON.stringify({
      "active-conversation": { task_id: "active-task", updated_at: new Date().toISOString() },
    }));

    let tool: { execute: (...args: unknown[]) => Promise<{ isError?: boolean; details?: { error?: string } }> } | undefined;
    taskExtension({
      on(event: string, handler: () => void) {
        if (event === "session_shutdown") shutdown = handler;
      },
      registerMessageRenderer() {},
      registerFlag() {},
      registerTool(value: typeof tool) {
        tool = value;
      },
      registerCommand() {},
      getAllTools() {
        return [];
      },
    } as never);
    assert.ok(tool, t + " registration");
    const replacementCwd = join(root, "replacement-worktree");
    mkdirSync(replacementCwd);
    const result = await tool.execute(
      "active-cwd-contract",
      {
        agent_type: "explore",
        prompt: "Continue",
        description: "Continue active task",
        conversation_id: "active-conversation",
        cwd: replacementCwd,
        background: false,
      },
      undefined,
      undefined,
      { cwd: root, isProjectTrusted: () => true },
    );
    assert.equal(result.isError, true, `${t} rejected: ${JSON.stringify(result)}`);
    assert.equal(result.details?.error, "active task cannot run foreground", t + " error contract");
  } finally {
    shutdown?.();
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = originalTmux;
    if (originalBackend === undefined) delete process.env.PI_TASK_BACKEND;
    else process.env.PI_TASK_BACKEND = originalBackend;
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.platform !== "win32") {
  const t = "concurrent durable launches create one child";
  const root = mkdtempSync(join(tmpdir(), "pi-task-concurrent-cwd-"));
  const piDir = join(root, ".pi");
  const originalPath = process.env.PATH;
  const originalTmux = process.env.TMUX;
  const originalBackend = process.env.PI_TASK_BACKEND;
  let shutdown: (() => void) | undefined;
  try {
    mkdirSync(join(piDir, "artifacts", "tasks"), { recursive: true });
    const binDir = join(root, "bin");
    mkdirSync(binDir);
    const tmux = join(binDir, "tmux");
    writeFileSync(tmux, "#!/bin/sh\ncase \"$1\" in\n  -V) printf '%s\\n' 'tmux 3.4' ;;\n  display-message) case \"$*\" in *pane_width*) printf '%s\\n' '120 40' ;; *) printf '%s\\n' '%pane-1' ;; esac ;;\n  split-window) printf '%s\\n' '%pane-1' ;;\n  *) exit 0 ;;\nesac\n");
    chmodSync(tmux, 0o755);
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    process.env.TMUX = join(root, "tmux.sock");
    process.env.PI_TASK_BACKEND = "tmux";

    let tool: { execute: (...args: unknown[]) => Promise<{ isError?: boolean; details?: { error?: string; task_id?: string } }> } | undefined;
    taskExtension({
      on(event: string, handler: () => void) {
        if (event === "session_shutdown") shutdown = handler;
      },
      registerMessageRenderer() {},
      registerFlag() {},
      registerTool(value: typeof tool) {
        tool = value;
      },
      registerCommand() {},
      appendEntry() {},
      getAllTools() {
        return [];
      },
    } as never);
    assert.ok(tool, t + " registration");
    const replacementCwd = join(root, "replacement-worktree");
    mkdirSync(replacementCwd);
    const base = {
      agent_type: "explore",
      prompt: "Continue",
      description: "Concurrent durable task",
      conversation_id: "concurrent-conversation",
      background: true,
    };
    const [first, second] = await Promise.all([
      tool.execute("concurrent-first", { ...base, cwd: root }, undefined, undefined, { cwd: root, isProjectTrusted: () => true }),
      tool.execute("concurrent-second", { ...base, cwd: replacementCwd }, undefined, undefined, { cwd: root, isProjectTrusted: () => true }),
    ]);
    assert.equal(first.isError, undefined, t + " first launch");
    assert.equal(second.isError, undefined, t + " second resume");
    assert.ok(first.details?.task_id, t + " first task id");
    assert.equal(second.details?.task_id, first.details?.task_id, t + " only one child");

    const foreground = await tool.execute(
      "concurrent-foreground",
      { ...base, cwd: replacementCwd, background: false },
      undefined,
      undefined,
      { cwd: root, isProjectTrusted: () => true },
    );
    assert.equal(foreground.isError, true, t + " foreground rejection");
    assert.equal(foreground.details?.error, "active task cannot run foreground", t + " foreground error");
  } finally {
    shutdown?.();
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = originalTmux;
    if (originalBackend === undefined) delete process.env.PI_TASK_BACKEND;
    else process.env.PI_TASK_BACKEND = originalBackend;
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.platform !== "win32") {
  const t = "tmux launch keeps long subagent prompts out of the tmux command string";
  const root = mkdtempSync(join(tmpdir(), "pi-task-long-prompt-"));
  const piDir = join(root, ".pi");
  const originalPath = process.env.PATH;
  const originalTmux = process.env.TMUX;
  const originalBackend = process.env.PI_TASK_BACKEND;
  let shutdown: (() => void) | undefined;
  try {
    mkdirSync(join(piDir, "artifacts", "tasks"), { recursive: true });
    const agentsDir = join(piDir, "agents");
    mkdirSync(agentsDir);
    const bodyMarker = "PROMPT_BODY_MARKER_" + "x".repeat(20000);
    writeFileSync(
      join(agentsDir, "huge.md"),
      `---\ndescription: Agent with an oversized body\n---\n\n${bodyMarker}\n`,
    );

    const binDir = join(root, "bin");
    mkdirSync(binDir);
    const tmuxLog = join(root, "tmux-args.log");
    const tmux = join(binDir, "tmux");
    writeFileSync(
      tmux,
      `#!/bin/sh\ncase "$1" in\n  -V) printf '%s\\n' 'tmux 3.4' ;;\n  display-message) case "$*" in *pane_width*) printf '%s\\n' '120 40' ;; *) printf '%s\\n' '%pane-1' ;; esac ;;\n  split-window) printf '%s\\n' '%pane-1'; printf '%s\\n' "$*" | tr '\\n' ' ' >> '${tmuxLog}'; printf '\\n' >> '${tmuxLog}' ;;\n  *) exit 0 ;;\nesac\n`,
    );
    chmodSync(tmux, 0o755);
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    process.env.TMUX = join(root, "tmux.sock");
    process.env.PI_TASK_BACKEND = "tmux";

    let tool: { execute: (...args: unknown[]) => Promise<{ isError?: boolean; details?: { error?: string; task_id?: string } }> } | undefined;
    taskExtension({
      on(event: string, handler: () => void) {
        if (event === "session_shutdown") shutdown = handler;
      },
      registerMessageRenderer() {},
      registerFlag() {},
      registerTool(value: typeof tool) {
        tool = value;
      },
      registerCommand() {},
      appendEntry() {},
      getAllTools() {
        return [];
      },
    } as never);
    assert.ok(tool, t + " registration");

    const result = await tool.execute(
      "long-prompt-1",
      {
        agent_type: "huge",
        prompt: "Check the huge prompt launch",
        description: "Long prompt launch",
        background: true,
      },
      undefined,
      undefined,
      { cwd: root, isProjectTrusted: () => true },
    );
    assert.equal(result.isError, undefined, t + " launch succeeds: " + JSON.stringify(result.details));

    const log = readFileSync(tmuxLog, "utf8").trim();
    const splitLine = log.split("\n").at(-1) ?? "";
    assert.ok(splitLine.startsWith("split-window "), t + " split-window was invoked");
    const command = splitLine.split(" ").at(-1) ?? "";
    assert.ok(
      command.length < 1000,
      t + ` split-window command stays short (got ${command.length} chars)`,
    );
    assert.ok(
      !log.includes("x".repeat(1000)),
      t + " body text never crosses the tmux protocol",
    );
    // The command must be a script invocation whose file carries the full
    // launch (system prompt path, initial prompt, watcher) instead.
    const scriptPath = command.replace(/^'/, "").replace(/'$/, "");
    const script = readFileSync(scriptPath, "utf8");
    assert.ok(script.includes("--append-system-prompt"), t + " script contains pi argv");
    assert.ok(script.includes("Check the huge prompt launch"), t + " script contains the task prompt");
  } finally {
    shutdown?.();
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = originalTmux;
    if (originalBackend === undefined) delete process.env.PI_TASK_BACKEND;
    else process.env.PI_TASK_BACKEND = originalBackend;
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.platform !== "win32") {
  const t = "fast herdr launch loads the herdr integration extension and surfaces launch failures";
  const root = mkdtempSync(join(tmpdir(), "pi-task-herdr-fast-"));
  const home = mkdtempSync(join(tmpdir(), "pi-task-herdr-home-"));
  const originalPath = process.env.PATH;
  const originalHome = process.env.HOME;
  const originalHerdrEnv = process.env.HERDR_ENV;
  const originalHerdrPane = process.env.HERDR_PANE_ID;
  const originalHerdrSocket = process.env.HERDR_SOCKET_PATH;
  const originalBackend = process.env.PI_TASK_BACKEND;
  const originalHerdrExtension = process.env.PI_TASK_HERDR_EXTENSION;
  let shutdown: (() => void) | undefined;
  try {
    mkdirSync(join(root, ".pi", "artifacts", "tasks"), { recursive: true });
    const agentsDir = join(root, ".pi", "agents");
    mkdirSync(agentsDir);
    writeFileSync(
      join(agentsDir, "fastaudit.md"),
      "---\ndescription: Fast audit agent\nfast: true\n---\n\n# Fast audit\n",
    );

    const binDir = join(root, "bin");
    mkdirSync(binDir);
    const herdrLog = join(root, "herdr-args.log");
    const herdr = join(binDir, "herdr");
    writeFileSync(
      herdr,
      `#!/bin/sh\necho "$*" >> '${herdrLog}'\ncase "$1 $2" in\n  "status server") exit 0 ;;\n  "pane current") exit 0 ;;\n  "pane split") echo '{"pane":{"pane_id":"w9:p2","terminal_id":"term-9"}}' ;;\n  "agent start") echo 'agent start exploded: fake-herdr-failure-9137' >&2; exit 1 ;;\n  *) exit 0 ;;\nesac\n`,
    );
    chmodSync(herdr, 0o755);
    const integrationPath = join(home, ".pi", "agent", "extensions", "herdr-agent-state.ts");
    mkdirSync(join(home, ".pi", "agent", "extensions"), { recursive: true });
    writeFileSync(integrationPath, "// fake herdr integration\n");

    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    process.env.HOME = home;
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "w9:p1";
    process.env.HERDR_SOCKET_PATH = join(root, "herdr.sock");
    process.env.PI_TASK_BACKEND = "herdr";
    delete process.env.PI_TASK_HERDR_EXTENSION;

    let tool: { execute: (...args: unknown[]) => Promise<{ isError?: boolean; content?: Array<{ type: string; text: string }>; details?: { reason?: string } }> } | undefined;
    taskExtension({
      on(event: string, handler: () => void) {
        if (event === "session_shutdown") shutdown = handler;
      },
      registerMessageRenderer() {},
      registerFlag() {},
      registerTool(value: typeof tool) {
        tool = value;
      },
      registerCommand() {},
      appendEntry() {},
      getAllTools() {
        return [];
      },
    } as never);
    assert.ok(tool, t + " registration");

    const result = await tool.execute(
      "herdr-fast-1",
      {
        agent_type: "fastaudit",
        prompt: "Audit the diff",
        description: "Fast audit",
        background: false,
      },
      undefined,
      undefined,
      { cwd: root, isProjectTrusted: () => true },
    );
    assert.equal(result.isError, true, t + " launch fails at agent start");
    const log = readFileSync(herdrLog, "utf8");
    const startLine = log.split("\n").find((line) => line.startsWith("agent start "));
    assert.ok(startLine, t + " agent start was invoked");
    assert.ok(
      startLine!.includes("--extension"),
      t + " fast herdr argv carries explicit --extension flags",
    );
    assert.ok(
      startLine!.includes(integrationPath),
      t + ` herdr integration extension loaded explicitly; argv: ${startLine}`,
    );
    const text = result.content?.[0]?.text ?? "";
    assert.ok(
      text.includes("fake-herdr-failure-9137"),
      t + ` underlying launch failure surfaces: ${JSON.stringify(result.content)}`,
    );
    assert.ok(
      (result.details?.reason ?? "").includes("fake-herdr-failure-9137"),
      t + " details.reason carries the underlying failure",
    );
  } finally {
    shutdown?.();
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalHerdrEnv === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = originalHerdrEnv;
    if (originalHerdrPane === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = originalHerdrPane;
    if (originalHerdrSocket === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = originalHerdrSocket;
    if (originalBackend === undefined) delete process.env.PI_TASK_BACKEND;
    else process.env.PI_TASK_BACKEND = originalBackend;
    if (originalHerdrExtension === undefined) delete process.env.PI_TASK_HERDR_EXTENSION;
    else process.env.PI_TASK_HERDR_EXTENSION = originalHerdrExtension;
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

if (process.platform !== "win32") {
  const t = "fast herdr compare launch carries the integration extension on every sibling";
  const root = mkdtempSync(join(tmpdir(), "pi-task-herdr-compare-"));
  const home = mkdtempSync(join(tmpdir(), "pi-task-herdr-compare-home-"));
  const originalPath = process.env.PATH;
  const originalHome = process.env.HOME;
  const originalHerdrEnv = process.env.HERDR_ENV;
  const originalHerdrPane = process.env.HERDR_PANE_ID;
  const originalHerdrSocket = process.env.HERDR_SOCKET_PATH;
  const originalBackend = process.env.PI_TASK_BACKEND;
  const originalHerdrExtension = process.env.PI_TASK_HERDR_EXTENSION;
  let shutdown: (() => void) | undefined;
  try {
    mkdirSync(join(root, ".pi", "artifacts", "tasks"), { recursive: true });
    const agentsDir = join(root, ".pi", "agents");
    mkdirSync(agentsDir);
    writeFileSync(
      join(agentsDir, "fastcmp.md"),
      "---\ndescription: Fast compare agent\nfast: true\ntools: read, grep, find, ls\nmodels:\n  - zai/glm-5.3\n  - openai-codex/gpt-5.6-sol\n---\n\n# Fast compare\n",
    );

    const binDir = join(root, "bin");
    mkdirSync(binDir);
    const herdrLog = join(root, "herdr-args.log");
    const herdr = join(binDir, "herdr");
    writeFileSync(
      herdr,
      `#!/bin/sh\necho "$*" >> '${herdrLog}'\ncase "$1 $2" in\n  "status server") exit 0 ;;\n  "pane current") exit 0 ;;\n  "pane split") echo '{"pane":{"pane_id":"w9:p2","terminal_id":"term-9"}}' ;;\n  "pane process-info") echo '{"process_info":{"pane_id":"w9:p2","foreground_process_group_id":42}}' ;;\n  "agent get") echo '{"agent":{"pane_id":"w9:p2","terminal_id":"term-9","name":"pi-task","agent":"pi","agent_status":"idle","state_change_seq":10}}' ;;\n  "agent start") echo '{"agent":{"pane_id":"w9:p2","terminal_id":"term-9"}}' ;;\n  "agent prompt") echo '{"agent":{"pane_id":"w9:p2","terminal_id":"term-9"}}' ;;\n  *) exit 0 ;;\nesac\n`,
    );
    chmodSync(herdr, 0o755);
    const integrationPath = join(home, ".pi", "agent", "extensions", "herdr-agent-state.ts");
    mkdirSync(join(home, ".pi", "agent", "extensions"), { recursive: true });
    writeFileSync(integrationPath, "// fake herdr integration\n");

    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    process.env.HOME = home;
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "w9:p1";
    process.env.HERDR_SOCKET_PATH = join(root, "herdr.sock");
    process.env.PI_TASK_BACKEND = "herdr";
    delete process.env.PI_TASK_HERDR_EXTENSION;

    let tool: { execute: (...args: unknown[]) => Promise<{ isError?: boolean; content?: Array<{ type: string; text: string }> }> } | undefined;
    taskExtension({
      on(event: string, handler: () => void) {
        if (event === "session_shutdown") shutdown = handler;
      },
      registerMessageRenderer() {},
      registerFlag() {},
      registerTool(value: typeof tool) {
        tool = value;
      },
      registerCommand() {},
      appendEntry() {},
      getAllTools() {
        return [];
      },
    } as never);
    assert.ok(tool, t + " registration");

    const result = await tool.execute(
      "herdr-compare-1",
      {
        agent_type: "fastcmp",
        prompt: "Compare outputs",
        description: "Fast compare",
        compare: true,
      },
      undefined,
      undefined,
      { cwd: root, isProjectTrusted: () => true },
    );
    assert.equal(result.isError, undefined, t + " compare launches: " + JSON.stringify(result.details));
    const startLines = readFileSync(herdrLog, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("agent start "));
    assert.equal(startLines.length, 2, t + ` both siblings start: ${startLines.join(" | ")}`);
    for (const startLine of startLines) {
      assert.ok(
        startLine.includes(integrationPath),
        t + ` sibling argv carries the integration extension: ${startLine}`,
      );
    }
  } finally {
    shutdown?.();
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalHerdrEnv === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = originalHerdrEnv;
    if (originalHerdrPane === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = originalHerdrPane;
    if (originalHerdrSocket === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = originalHerdrSocket;
    if (originalBackend === undefined) delete process.env.PI_TASK_BACKEND;
    else process.env.PI_TASK_BACKEND = originalBackend;
    if (originalHerdrExtension === undefined) delete process.env.PI_TASK_HERDR_EXTENSION;
    else process.env.PI_TASK_HERDR_EXTENSION = originalHerdrExtension;
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

if (process.platform !== "win32") {
  // Decision pin: a missing herdr integration file must degrade the fast
  // launch (no --extension) instead of hard-failing — herdr may detect agent
  // state natively in future versions.
  const t = "fast herdr launch degrades without the integration file";
  const root = mkdtempSync(join(tmpdir(), "pi-task-herdr-degrade-"));
  const home = mkdtempSync(join(tmpdir(), "pi-task-herdr-degrade-home-"));
  const originalPath = process.env.PATH;
  const originalHome = process.env.HOME;
  const originalHerdrEnv = process.env.HERDR_ENV;
  const originalHerdrPane = process.env.HERDR_PANE_ID;
  const originalHerdrSocket = process.env.HERDR_SOCKET_PATH;
  const originalBackend = process.env.PI_TASK_BACKEND;
  const originalHerdrExtension = process.env.PI_TASK_HERDR_EXTENSION;
  let shutdown: (() => void) | undefined;
  try {
    mkdirSync(join(root, ".pi", "artifacts", "tasks"), { recursive: true });
    const agentsDir = join(root, ".pi", "agents");
    mkdirSync(agentsDir);
    writeFileSync(
      join(agentsDir, "fastaudit.md"),
      "---\ndescription: Fast audit agent\nfast: true\n---\n\n# Fast audit\n",
    );

    const binDir = join(root, "bin");
    mkdirSync(binDir);
    const herdrLog = join(root, "herdr-args.log");
    const herdr = join(binDir, "herdr");
    writeFileSync(
      herdr,
      `#!/bin/sh\necho "$*" >> '${herdrLog}'\ncase "$1 $2" in\n  "status server") exit 0 ;;\n  "pane current") exit 0 ;;\n  "pane split") echo '{"pane":{"pane_id":"w9:p2","terminal_id":"term-9"}}' ;;\n  "agent start") echo 'agent start exploded: fake-herdr-failure-9137' >&2; exit 1 ;;\n  *) exit 0 ;;\nesac\n`,
    );
    chmodSync(herdr, 0o755);
    // HOME exists but no .pi/agent/extensions/herdr-agent-state.ts.

    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    process.env.HOME = home;
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "w9:p1";
    process.env.HERDR_SOCKET_PATH = join(root, "herdr.sock");
    process.env.PI_TASK_BACKEND = "herdr";
    delete process.env.PI_TASK_HERDR_EXTENSION;

    let tool: { execute: (...args: unknown[]) => Promise<{ isError?: boolean; content?: Array<{ type: string; text: string }> }> } | undefined;
    taskExtension({
      on(event: string, handler: () => void) {
        if (event === "session_shutdown") shutdown = handler;
      },
      registerMessageRenderer() {},
      registerFlag() {},
      registerTool(value: typeof tool) {
        tool = value;
      },
      registerCommand() {},
      appendEntry() {},
      getAllTools() {
        return [];
      },
    } as never);
    assert.ok(tool, t + " registration");

    await tool.execute(
      "herdr-degrade-1",
      {
        agent_type: "fastaudit",
        prompt: "Audit the diff",
        description: "Fast audit",
        background: false,
      },
      undefined,
      undefined,
      { cwd: root, isProjectTrusted: () => true },
    );
    const startLine = readFileSync(herdrLog, "utf8")
      .split("\n")
      .find((line) => line.startsWith("agent start "));
    assert.ok(startLine, t + " agent start was invoked");
    assert.ok(
      !startLine!.includes("herdr-agent-state.ts"),
      t + " missing integration file degrades without adding a bogus --extension",
    );
  } finally {
    shutdown?.();
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalHerdrEnv === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = originalHerdrEnv;
    if (originalHerdrPane === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = originalHerdrPane;
    if (originalHerdrSocket === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = originalHerdrSocket;
    if (originalBackend === undefined) delete process.env.PI_TASK_BACKEND;
    else process.env.PI_TASK_BACKEND = originalBackend;
    if (originalHerdrExtension === undefined) delete process.env.PI_TASK_HERDR_EXTENSION;
    else process.env.PI_TASK_HERDR_EXTENSION = originalHerdrExtension;
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

{
  const t = "TASK_PROMPT_INSTRUCTIONS aligned with XML";
  assert.ok(
    !TASK_PROMPT_INSTRUCTIONS.includes("Do not wrap it in XML"),
    t,
  );
  assert.ok(TASK_PROMPT_INSTRUCTIONS.includes("XML envelope"), t);
}

{
  const t = "task tool guidance lives in one place: description, not duplicated guidelines";
  const indexSrc = readFileSync(
    fileURLToPath(new URL("../src/index.ts", import.meta.url)),
    "utf8",
  );
  const schemaSrc = readFileSync(
    fileURLToPath(new URL("../src/tool/schema.ts", import.meta.url)),
    "utf8",
  );
  const helpersSrc = readFileSync(
    fileURLToPath(new URL("../src/helpers.ts", import.meta.url)),
    "utf8",
  );
  // Guidance must not be duplicated in a second model-visible block:
  // promptGuidelines were removed and folded into the tool description.
  assert.ok(!indexSrc.includes("promptGuidelines"), t + " no duplicated guidelines block");
  assert.ok(schemaSrc.toLowerCase().includes("set cwd to an absolute existing directory"), t + " cwd hint");
  assert.ok(helpersSrc.includes("file paths alone are not a context handoff"), t + " handoff guidance");
  assert.ok(helpersSrc.includes("parent-synthesized facts, decisions"), t + " context handoff folded into description");
  // Schema descriptions are lean call-time pointers, not a second copy of
  // the prompt contract (which lives in the tool description).
  const schemaDescs = [...schemaSrc.matchAll(/description:\s*(?:\n\s*)?"([^"]+)"/g)].map((m) => m[1]);
  const schemaChars = schemaDescs.reduce((a, d) => a + d.length, 0);
  assert.ok(schemaChars < 1300, `${t}: schema descriptions stay lean (${schemaChars} chars)`);
  assert.ok(!indexSrc.includes("pi.getAllTools()"), "extension load avoids runtime-only tool enumeration");
  assert.ok(indexSrc.includes("cwd: taskCwd"), t + " prompt and backend cwd");
  assert.ok(indexSrc.includes("shellQuote(taskCwd)"), t + " tmux shell cwd");
  assert.ok(indexSrc.includes("splitWindowPane(taskCwd"), t + " tmux pane cwd");
  assert.ok(indexSrc.includes("previous?.cwd"), t + " conversation resume cwd");
  assert.ok(indexSrc.includes("persistedTaskCwd = entry.cwd"), t + " task resume cwd");
  assert.ok(indexSrc.includes("resolveTaskCwd(ctx.cwd, taskParams.cwd, persistedTaskCwd)"), t + " resume precedence");
}

console.log("prompt.test.ts: all passed");
if (process.platform !== "win32") {
  const t = "live resume reattach keeps enforcing the agent turn limit";
  const root = mkdtempSync(join(tmpdir(), "pi-task-resume-turns-"));
  const originalPath = process.env.PATH;
  const originalTmux = process.env.TMUX;
  const originalBackend = process.env.PI_TASK_BACKEND;
  let shutdown: (() => void) | undefined;
  try {
    mkdirSync(join(root, ".pi", "artifacts", "tasks"), { recursive: true });
    const agentsDir = join(root, ".pi", "agents");
    mkdirSync(agentsDir);
    writeFileSync(
      join(agentsDir, "limited.md"),
      "---\ndescription: Turn limited agent\nmax_turns: 1\n---\n\n# Limited\n",
    );

    const binDir = join(root, "bin");
    mkdirSync(binDir);
    const tmuxLog = join(root, "tmux-args.log");
    const tmux = join(binDir, "tmux");
    // paste-buffer args carry no message text: the wrap-up prompt travels
    // through `load-buffer` stdin, so capture stdin into the log.
    writeFileSync(
      tmux,
      `#!/bin/sh\ncase "$1" in\n  -V) printf '%s\\\\n' 'tmux 3.4' ;;\n  load-buffer) cat >> '${tmuxLog}' ;;\n  display-message) case "$*" in *pane_width*) printf '%s\\\\n' '120 40' ;; *) printf '%s\\\\n' '%pane-1' ;; esac ;;\n  split-window) printf '%s\\\\n' '%pane-1' ;;\n  *) exit 0 ;;\nesac\n`,
    );
    chmodSync(tmux, 0o755);
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    process.env.TMUX = join(root, "tmux.sock");
    process.env.PI_TASK_BACKEND = "tmux";

    let tool: { execute: (...args: unknown[]) => Promise<{ isError?: boolean; details?: { task_id?: string } }> } | undefined;
    taskExtension({
      on(event: string, handler: () => void) {
        if (event === "session_shutdown") shutdown = handler;
      },
      registerMessageRenderer() {},
      registerFlag() {},
      registerTool(value: typeof tool) {
        tool = value;
      },
      registerCommand() {},
      appendEntry() {},
      getAllTools() {
        return [];
      },
    } as never);
    assert.ok(tool, t + " registration");

    const base = {
      agent_type: "limited",
      prompt: "Do the work",
      description: "Turn limited task",
      background: true,
    };
    const first = await tool.execute(
      "resume-turns-1",
      { ...base, conversation_id: "conv-turns-1" },
      undefined,
      undefined,
      { cwd: root, isProjectTrusted: () => true },
    );
    assert.equal(first.isError, undefined, t + " first launch");
    const id = first.details?.task_id;
    assert.ok(id, t + " task id");

    // Simulate one completed assistant turn in the child session JSONL.
    // The explicit conversation_id makes sessionName = conversationId.
    const sessionDir = join(root, ".pi", "artifacts", "tasks", "sessions", id!);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "conv-turns-1.jsonl"),
      JSON.stringify({ type: "session_info", name: "conv-turns-1" }) + "\n" +
      JSON.stringify({
        type: "message",
        timestamp: new Date().toISOString(),
        message: { role: "assistant", content: [{ type: "text", text: "turn one" }] },
      }) + "\n",
    );

    // Resume via conversation_id: the reattached tracker must restore
    // maxTurns from the registry entry, so the polling loop steers a wrap-up
    // once the recounted turn count reaches the limit.
    const resumeOne = await tool.execute(
      "resume-turns-2",
      { ...base, conversation_id: "conv-turns-1" },
      undefined,
      undefined,
      { cwd: root, isProjectTrusted: () => true },
    );
    assert.equal(resumeOne.isError, undefined, t + " conversation resume");
    assert.equal(resumeOne.details?.task_id, id, t + " reattached to the same task");

    await sleep(14000); // BACKGROUND_CHECK_MS tick + COUNT_POLL_MS recount

    let log = readFileSync(tmuxLog, "utf8");
    const steerOne = (log.match(/turn soft limit/g) ?? []).length;
    assert.ok(steerOne >= 1, t + ` conversation resume enforces the limit (steer log: ${log.slice(-400)})`);

    // Resume via task_id: second reattach site must restore maxTurns too.
    const resumeTwo = await tool.execute(
      "resume-turns-3",
      { ...base, task_id: id },
      undefined,
      undefined,
      { cwd: root, isProjectTrusted: () => true },
    );
    assert.equal(resumeTwo.isError, undefined, t + " task_id resume");

    await sleep(14000);

    log = readFileSync(tmuxLog, "utf8");
    const steerTwo = (log.match(/turn soft limit/g) ?? []).length;
    assert.ok(
      steerTwo >= steerOne + 1,
      t + ` task_id resume enforces the limit (steers: ${steerOne} -> ${steerTwo})`,
    );
  } finally {
    shutdown?.();
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = originalTmux;
    if (originalBackend === undefined) delete process.env.PI_TASK_BACKEND;
    else process.env.PI_TASK_BACKEND = originalBackend;
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.platform !== "win32") {
  const t = "background restore runs on the first session_start and respects session ownership";
  const root = mkdtempSync(join(tmpdir(), "pi-task-ownership-"));
  const originalPath = process.env.PATH;
  const originalTmux = process.env.TMUX;
  const originalBackend = process.env.PI_TASK_BACKEND;
  const originalCwd = process.cwd();
  let shutdown: (() => void) | undefined;
  try {
    mkdirSync(join(root, ".pi", "artifacts", "tasks"), { recursive: true });
    const agentsDir = join(root, ".pi", "agents");
    mkdirSync(agentsDir);
    writeFileSync(
      join(agentsDir, "scout.md"),
      "---\ndescription: Scout agent\n---\n\n# Scout\n",
    );

    const binDir = join(root, "bin");
    mkdirSync(binDir);
    const tmux = join(binDir, "tmux");
    writeFileSync(
      tmux,
      "#!/bin/sh\ncase \"$1\" in\n  -V) printf '%s\\n' 'tmux 3.4' ;;\n  display-message) case \"$*\" in *pane_width*) printf '%s\\n' '120 40' ;; *) printf '%s\\n' '%pane-1' ;; esac ;;\n  split-window) printf '%s\\n' '%pane-1' ;;\n  *) exit 0 ;;\nesac\n",
    );
    chmodSync(tmux, 0o755);
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    process.env.TMUX = join(root, "tmux.sock");
    process.env.PI_TASK_BACKEND = "tmux";
    // The extension resolves its registry piDir from process.cwd().
    process.chdir(root);

    // Registry fixture at extension load:
    // A: owned by another live session — must stay untouched.
    // B: owned by this session, already finished — recovered as done.
    // C: legacy entry without ownership — restored as before.
    const registry = [
      {
        id: "task-foreign",
        dir: join(root, ".pi", "artifacts", "tasks"),
        sessionName: "task-task-foreign",
        startedAt: Date.now() - 1000,
        paneId: "%pane-1",
        agentType: "scout",
        description: "foreign live task",
        ownerSessionId: "sess-a",
        ownerPid: process.pid,
      },
      {
        id: "task-owned-done",
        dir: join(root, ".pi", "artifacts", "tasks"),
        sessionName: "task-task-owned-done",
        startedAt: Date.now() - 1000,
        paneId: "%pane-1",
        agentType: "scout",
        description: "own finished task",
        ownerSessionId: "sess-host",
        ownerPid: process.pid,
      },
      {
        id: "task-legacy",
        dir: join(root, ".pi", "artifacts", "tasks"),
        sessionName: "task-task-legacy",
        startedAt: Date.now() - 1000,
        paneId: "%pane-1",
        agentType: "scout",
        description: "legacy live task",
      },
    ];
    writeFileSync(join(root, ".pi", "task-registry.json"), JSON.stringify(registry));

    const timestamp = new Date().toISOString();
    const sessionDir = join(root, ".pi", "artifacts", "tasks", "sessions");
    mkdirSync(join(sessionDir, "task-owned-done"), { recursive: true });
    writeFileSync(
      join(sessionDir, "task-owned-done", "task-owned-done.jsonl"),
      JSON.stringify({ type: "session_info", timestamp, name: "task-task-owned-done" }) + "\n" +
      JSON.stringify({
        type: "message",
        timestamp,
        message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
      }) + "\n",
    );

    const sessionStartHandlers: Array<(...args: unknown[]) => unknown> = [];
    taskExtension({
      on(event: string, handler: (...args: unknown[]) => unknown) {
        if (event === "session_start") sessionStartHandlers.push(handler);
        if (event === "session_shutdown") shutdown = handler as () => void;
      },
      registerMessageRenderer() {},
      registerFlag() {},
      registerTool() {},
      registerCommand() {},
      appendEntry() {},
      getAllTools() {
        return [];
      },
    } as never);

    // No restore may run at registration time (issue #20): the session id
    // does not exist yet, so nothing has been decided about ownership.
    assert.equal(
      existsSync(join(root, ".pi", "task-session-history.json")),
      false,
      t + " no durable restore before session_start",
    );

    const hostCtx = {
      cwd: root,
      isProjectTrusted: () => true,
      sessionManager: {
        getSessionId: () => "sess-host",
        getLeafId: () => null,
        getBranch: () => [],
      },
    };
    for (const handler of sessionStartHandlers) {
      handler({ type: "session_start", reason: "startup" }, hostCtx);
    }

    const readRegistryIds = (): string[] =>
      JSON.parse(readFileSync(join(root, ".pi", "task-registry.json"), "utf8")).map(
        (entry: { id: string }) => entry.id,
      );
    assert.deepEqual(
      readRegistryIds().sort(),
      ["task-foreign", "task-legacy"],
      t + " foreign entry untouched, finished own entry recovered, legacy stays registered",
    );
    const history = JSON.parse(
      readFileSync(join(root, ".pi", "task-session-history.json"), "utf8"),
    ) as Array<{ id: string; status: string }>;
    assert.equal(history.find((entry) => entry.id === "task-owned-done")?.status, "done", t + " own finished entry receipt");

    // A later session switch must not re-run restore (once-guard).
    const otherCtx = {
      cwd: root,
      isProjectTrusted: () => true,
      sessionManager: {
        getSessionId: () => "sess-other",
        getLeafId: () => null,
        getBranch: () => [],
      },
    };
    for (const handler of sessionStartHandlers) {
      handler({ type: "session_start", reason: "resume" }, otherCtx);
    }
    assert.equal(
      readRegistryIds().includes("task-foreign"),
      true,
      t + " restore runs once; the foreign entry is not reconsidered",
    );
  } finally {
    shutdown?.();
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = originalTmux;
    if (originalBackend === undefined) delete process.env.PI_TASK_BACKEND;
    else process.env.PI_TASK_BACKEND = originalBackend;
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
  }
}

// Issue #21 Major (reviewer round 5): a history record whose recorded dir is
// stale must not block resume when the transcript is discoverable under the
// current tasks root — the artifact-dir guard may only fire when there is no
// usable session ref either.
if (process.platform !== "win32") {
  const t = "task_id resume proceeds when recorded dir is stale";
  const root = mkdtempSync(join(tmpdir(), "pi-task-resume-stale-dir-"));
  const originalPath = process.env.PATH;
  const originalTmux = process.env.TMUX;
  const originalBackend = process.env.PI_TASK_BACKEND;
  const originalCwd = process.cwd();
  let shutdown: (() => void) | undefined;
  try {
    const piDir = join(root, ".pi");
    const tasksRoot = join(piDir, "artifacts", "tasks");
    mkdirSync(join(tasksRoot, "sessions"), { recursive: true });
    const agentsDir = join(piDir, "agents");
    mkdirSync(agentsDir);
    writeFileSync(
      join(agentsDir, "resumeagent.md"),
      "---\ndescription: Resume agent\n---\n\n# Resume\n",
    );

    const binDir = join(root, "bin");
    mkdirSync(binDir);
    const spawnLog = join(root, "spawn-args.log");
    const tmux = join(binDir, "tmux");
    writeFileSync(
      tmux,
      `#!/bin/sh\ncase "$1" in\n  -V) printf '%s\\n' 'tmux 3.4' ;;\n  display-message) printf '%s\\n' '%pane-1' ;;\n  split-window) printf '%s\\n' "$*" >> '${spawnLog}'; printf '%s\\n' '%pane-1' ;;\n  *) exit 0 ;;\nesac\n`,
    );
    chmodSync(tmux, 0o755);
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    process.env.TMUX = join(root, "tmux.sock");
    process.env.PI_TASK_BACKEND = "tmux";

    // Settled task: recorded dir is gone, transcript lives under the CURRENT
    // tasks root (probe 2 of the rewritten lookup).
    const id = "stale-dir-task";
    const sessionName = "stale-dir-sess";
    const sessionDir = join(tasksRoot, "sessions", id);
    mkdirSync(sessionDir, { recursive: true });
    const sessionRef = join(sessionDir, `${sessionName}.jsonl`);
    writeFileSync(
      sessionRef,
      JSON.stringify({ type: "session_info", name: sessionName }) + "\n",
      "utf-8",
    );
    process.chdir(root);
    upsertTaskSessionHistory(piDir, {
      id,
      agentType: "resumeagent",
      description: "stale dir resume",
      sessionName,
      startedAt: Date.now(),
      piDir,
      dir: join(root, "gone"),
      cwd: root,
      status: "done",
      background: true,
    });

    let tool: { execute: (...args: unknown[]) => Promise<{ isError?: boolean; details?: { task_id?: string } }> } | undefined;
    taskExtension({
      on(event: string, handler: () => void) {
        if (event === "session_shutdown") shutdown = handler;
      },
      registerMessageRenderer() {},
      registerFlag() {},
      registerTool(value: typeof tool) {
        tool = value;
      },
      registerCommand() {},
      appendEntry() {},
      getAllTools() {
        return [];
      },
    } as never);
    assert.ok(tool, t + " registration");

    const resumed = await tool.execute(
      "resume-stale-dir-1",
      {
        agent_type: "resumeagent",
        prompt: "Continue",
        description: "stale dir resume",
        background: true,
        task_id: id,
      },
      undefined,
      undefined,
      { cwd: root, isProjectTrusted: () => true },
    );
    assert.equal(resumed.isError, undefined, t + " resume proceeds");
    assert.equal(resumed.details?.task_id, id, t + " same task id");
    const spawnArgs = readFileSync(spawnLog, "utf8");
    assert.ok(
      spawnArgs.includes("pane-launch.sh"),
      t + " spawn launched via pane script",
    );
    const launcher = readFileSync(
      join(tasksRoot, "sessions", id, "pane-launch.sh"),
      "utf8",
    );
    assert.ok(
      launcher.includes(sessionRef),
      t + ` spawn resumes the discovered transcript (launcher: ${launcher.slice(-500)})`,
    );

    // Counter-scenario for the same guard: stale dir AND a dead ref with
    // nothing discoverable must produce the informative error, not a
    // silent fresh-session resume.
    const deadId = "stale-dir-dead-ref-task";
    upsertTaskSessionHistory(piDir, {
      id: deadId,
      agentType: "resumeagent",
      description: "dead ref",
      sessionName: `task-${deadId}`,
      startedAt: Date.now(),
      piDir,
      dir: join(root, "gone"),
      cwd: root,
      sessionRef: join(root, "gone.jsonl"),
      status: "done",
      background: true,
    });
    const deadResume = await tool.execute(
      "resume-stale-dir-2",
      {
        agent_type: "resumeagent",
        prompt: "Continue",
        description: "dead ref",
        background: true,
        task_id: deadId,
      },
      undefined,
      undefined,
      { cwd: root, isProjectTrusted: () => true },
    );
    assert.equal(deadResume.isError, true, t + " dead ref + stale dir errors");
    const deadText = JSON.stringify(deadResume);
    assert.ok(
      deadText.includes("artifact directory no longer exists") ||
        deadText.includes("gone.jsonl"),
      t + ` informative error (got: ${deadText.slice(0, 300)})`,
    );
  } finally {
    shutdown?.();
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = originalTmux;
    if (originalBackend === undefined) delete process.env.PI_TASK_BACKEND;
    else process.env.PI_TASK_BACKEND = originalBackend;
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("prompt.test.ts: stale-dir resume passed");
