import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import taskExtension from "../src/index.js";
import { TASK_PROMPT_INSTRUCTIONS } from "../src/helpers.js";
import { buildTaskFollowUpPrompt, buildTaskPrompt, taskParametersSchema } from "../src/tool/index.js";
import { resolveTaskCwd } from "../src/task-cwd.js";

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