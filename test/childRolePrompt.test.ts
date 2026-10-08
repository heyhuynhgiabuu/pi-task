import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  parseArgs,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../src/helpers.js";
import { registerChildRolePrompt } from "../src/subagent/child-role-prompt.js";
import { launchComparisonTerminalTasks } from "../src/lifecycle/comparison-terminal-launch.js";
import { buildPiArgv } from "../src/subagent/buildArgv.js";
import { buildSdkResourceLoaderOptions } from "../src/subagent/runSdk.js";
import type { TerminalBackend, TerminalLaunchInput } from "../src/subagent/terminalBackend.js";

// The extension entry Pi loads for every CLI child (`--extension <path>`).
const TASK_EXTENSION_PATH = join(import.meta.dirname, "..", "src", "index.ts");

function agent(body: string): AgentConfig {
  return { name: "role", description: "role", body, source: "bundled", path: "/agents/role.md" };
}

function childArgv(
  body: string,
  extra: Partial<Parameters<typeof buildPiArgv>[0]> = {},
): string[] {
  return buildPiArgv({
    agent: agent(body),
    sessionName: "task-role",
    sessionDir: "/tmp/task-role",
    promptContent: "perform the task",
    fastExtensionPath: TASK_EXTENSION_PATH,
    ...extra,
  });
}

async function withEnv<T>(env: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await run();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

interface Fixture {
  root: string;
  cwd: string;
  agentDir: string;
}

function fixture(t: TestContext): Fixture {
  const root = mkdtempSync(join(tmpdir(), "pi-task-role-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  return { root, cwd, agentDir };
}

interface ChildRun {
  /** `addendum` section of the system prompt that reached the provider, per request. */
  addenda: Array<string | undefined>;
  sections: Array<Record<string, string>>;
  toolNames: string[];
  extensionErrors: string[];
}

/**
 * Drive a child the way Pi's CLI does: parse the real argv with Pi's parser,
 * feed `--append-system-prompt` to the resource loader and unknown flags to
 * the extension flag application, then run prompts through a real session
 * whose provider is a local fake (no network, no credentials).
 */
async function runChild(
  argv: string[],
  options: {
    cwd: string;
    agentDir: string;
    trusted?: boolean;
    prompts?: number;
    sessionManager?: SessionManager;
  },
): Promise<ChildRun> {
  const parsed = parseArgs(argv);
  const faux = fauxProvider();
  const sections: Array<Record<string, string>> = [];
  const responses = Array.from({ length: options.prompts ?? 1 }, () =>
    (context: { messages: Array<{ role: string; sections?: Record<string, string | null> }> }) => {
      const current: Record<string, string> = {};
      for (const message of context.messages) {
        if (message.role !== "system") continue;
        for (const [name, value] of Object.entries(message.sections ?? {})) {
          if (value === null) delete current[name];
          else current[name] = value;
        }
      }
      sections.push(current);
      return fauxAssistantMessage("ok");
    });
  faux.setResponses(responses);

  const services = await createAgentSessionServices({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager: SettingsManager.create(options.cwd, options.agentDir, {
      projectTrusted: options.trusted === true,
    }),
    extensionFlagValues: parsed.unknownFlags,
    resourceLoaderOptions: {
      additionalExtensionPaths: parsed.extensions,
      noExtensions: parsed.noExtensions,
      disabledBuiltinExtensions: parsed.noMcp ? ["mcp"] : undefined,
      appendSystemPrompt: parsed.appendSystemPrompt,
    },
  });
  services.modelRuntime.registerNativeProvider(faux.provider);
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: options.sessionManager ?? SessionManager.inMemory(options.cwd),
    model: faux.getModel(),
    noTools: "all",
  });
  try {
    await session.bindExtensions({});
    for (let index = 0; index < (options.prompts ?? 1); index += 1) {
      await session.prompt(`turn ${index}`);
    }
    return {
      addenda: sections.map((entry) => entry.addendum),
      sections,
      toolNames: session.extensionRunner.getAllRegisteredTools().map(({ definition }) => definition.name),
      extensionErrors: services.resourceLoader.getExtensions().errors.map(({ error }) => error),
    };
  } finally {
    await session.extensionRunner.emit({ type: "session_shutdown" });
    session.dispose();
  }
}

const CHILD_ENV = { PI_TASK_TOOL_DISABLED: "1", PI_TASK_CHILD_NO_EXTENSIONS: undefined } as const;

function addendumBody(addendum: string | undefined): string | undefined {
  return addendum?.replace(/^<addendum>\n/, "").replace(/\n<\/addendum>$/, "");
}

test("CLI child keeps the native APPEND_SYSTEM and appends the role second", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.agentDir, "APPEND_SYSTEM.md"), "NATIVE APPEND\n");
  const run = await withEnv(CHILD_ENV, () =>
    runChild(childArgv("ROLE BODY"), { cwd: f.cwd, agentDir: f.agentDir }),
  );
  assert.deepEqual(run.extensionErrors, []);
  assert.equal(addendumBody(run.addenda[0]), "NATIVE APPEND\n\n\nROLE BODY");
});

test("role hook reads flags after registration and supports text-only or forced prompts", async () => {
  type HookEvent = {
    systemPrompt: string;
    systemPromptOptions?: { appendSystemPrompt: string; forceSystemPrompt?: string };
  };
  let hook: ((event: HookEvent) => unknown) | undefined;
  let role: string | undefined;
  // Reduced registration boundary: legacy events cannot be emitted by newer Pi.
  const api = {
    registerFlag() {},
    getFlag: () => role,
    on(_name: string, handler: (event: HookEvent) => unknown) {
      hook = handler;
      return () => {};
    },
  } as unknown as ExtensionAPI;

  await withEnv(CHILD_ENV, async () => {
    registerChildRolePrompt(api);
    assert.ok(hook);
    role = "ROLE";
    assert.deepEqual(await hook({ systemPrompt: "NATIVE PROMPT" }), {
      systemPrompt: "NATIVE PROMPT\n\nROLE",
    });
    const forced = {
      systemPrompt: "FORCED PROMPT",
      systemPromptOptions: { appendSystemPrompt: "NATIVE", forceSystemPrompt: "FORCED PROMPT" },
    };
    assert.deepEqual(await hook(forced), { systemPrompt: "FORCED PROMPT\n\nROLE" });
    assert.equal(forced.systemPromptOptions.appendSystemPrompt, "NATIVE");
  });
});

test("child argv no longer suppresses native discovery with --append-system-prompt", () => {
  const args = childArgv("ROLE BODY");
  assert.equal(args.includes("--append-system-prompt"), false);
  assert.ok(args.includes("--task-role-prompt=ROLE BODY"));
  assert.equal(args.filter((arg) => arg === "--extension").length, 1);
  assert.equal(args[args.indexOf("--extension") + 1], TASK_EXTENSION_PATH);
});

test("default child entry loads once even when the same extension is discovered", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.agentDir, "APPEND_SYSTEM.md"), "NATIVE");
  writeFileSync(join(f.agentDir, "settings.json"), JSON.stringify({ extensions: [TASK_EXTENSION_PATH] }));
  const argv = childArgv("ROLE", { fastExtensionPath: undefined });
  const run = await withEnv(CHILD_ENV, () =>
    runChild(argv, { cwd: f.cwd, agentDir: f.agentDir }),
  );
  assert.deepEqual(run.extensionErrors, []);
  assert.equal(addendumBody(run.addenda[0]), "NATIVE\n\nROLE");
});

test("trusted project APPEND_SYSTEM wins over global; untrusted falls back to global", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.agentDir, "APPEND_SYSTEM.md"), "GLOBAL APPEND");
  mkdirSync(join(f.cwd, ".pi"), { recursive: true });
  writeFileSync(join(f.cwd, ".pi", "APPEND_SYSTEM.md"), "PROJECT APPEND");

  const trusted = await withEnv(CHILD_ENV, () =>
    runChild(childArgv("ROLE"), { cwd: f.cwd, agentDir: f.agentDir, trusted: true }),
  );
  assert.equal(addendumBody(trusted.addenda[0]), "PROJECT APPEND\n\nROLE");

  const untrusted = await withEnv(CHILD_ENV, () =>
    runChild(childArgv("ROLE"), { cwd: f.cwd, agentDir: f.agentDir, trusted: false }),
  );
  assert.equal(addendumBody(untrusted.addenda[0]), "GLOBAL APPEND\n\nROLE");
});

test("missing or empty native append leaves only the role; empty role leaves only native", async (t) => {
  const f = fixture(t);
  const missing = await withEnv(CHILD_ENV, () =>
    runChild(childArgv("ROLE ONLY"), { cwd: f.cwd, agentDir: f.agentDir }),
  );
  assert.equal(addendumBody(missing.addenda[0]), "ROLE ONLY");

  writeFileSync(join(f.agentDir, "APPEND_SYSTEM.md"), "");
  const emptyNative = await withEnv(CHILD_ENV, () =>
    runChild(childArgv("ROLE ONLY"), { cwd: f.cwd, agentDir: f.agentDir }),
  );
  assert.equal(addendumBody(emptyNative.addenda[0]), "ROLE ONLY");

  writeFileSync(join(f.agentDir, "APPEND_SYSTEM.md"), "NATIVE ONLY");
  const emptyRole = await withEnv(CHILD_ENV, () =>
    runChild(childArgv(""), { cwd: f.cwd, agentDir: f.agentDir }),
  );
  assert.equal(addendumBody(emptyRole.addenda[0]), "NATIVE ONLY");

  rmSync(join(f.agentDir, "APPEND_SYSTEM.md"));
  const neither = await withEnv(CHILD_ENV, () =>
    runChild(childArgv(""), { cwd: f.cwd, agentDir: f.agentDir }),
  );
  assert.equal(neither.addenda[0], undefined);
});

test("child agent dir override selects the global APPEND_SYSTEM", async (t) => {
  const first = fixture(t);
  const second = fixture(t);
  writeFileSync(join(first.agentDir, "APPEND_SYSTEM.md"), "FIRST AGENT DIR");
  writeFileSync(join(second.agentDir, "APPEND_SYSTEM.md"), "SECOND AGENT DIR");
  const run = await withEnv({ ...CHILD_ENV, PI_CODING_AGENT_DIR: second.agentDir }, () =>
    runChild(childArgv("ROLE"), { cwd: first.cwd, agentDir: getAgentDir() }),
  );
  assert.equal(addendumBody(run.addenda[0]), "SECOND AGENT DIR\n\nROLE");
});

test("resumed child in a different cwd reads that cwd's trusted project APPEND_SYSTEM", async (t) => {
  const f = fixture(t);
  const resumedCwd = join(f.root, "resumed-project");
  mkdirSync(join(resumedCwd, ".pi"), { recursive: true });
  mkdirSync(join(f.cwd, ".pi"), { recursive: true });
  writeFileSync(join(f.cwd, ".pi", "APPEND_SYSTEM.md"), "ORIGINAL CWD APPEND");
  writeFileSync(join(resumedCwd, ".pi", "APPEND_SYSTEM.md"), "RESUMED CWD APPEND");
  const sessionDir = join(f.root, "sessions");
  const original = SessionManager.create(resumedCwd, sessionDir);
  original.appendMessage({ role: "user", content: "earlier turn", timestamp: 1 });
  original.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "earlier answer" }],
    api: "faux",
    provider: "faux",
    model: "faux",
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
  });
  const sessionFile = original.getSessionFile();
  assert.ok(sessionFile);

  const resumed = SessionManager.open(sessionFile, sessionDir);
  assert.equal(resumed.getCwd(), resumedCwd);
  assert.notEqual(resumed.getCwd(), f.cwd);
  const argv = childArgv("ROLE", { resume: true, resumeSessionRef: sessionFile });
  // CLI services use the persisted session cwd, not the shell's launch cwd.
  const run = await withEnv(CHILD_ENV, () =>
    runChild(argv, { cwd: resumed.getCwd(), agentDir: f.agentDir, trusted: true, sessionManager: resumed }),
  );
  assert.equal(addendumBody(run.addenda[0]), "RESUMED CWD APPEND\n\nROLE");
});

test("role value follows Pi text-or-file semantics", async (t) => {
  const f = fixture(t);
  const run = (body: string) =>
    withEnv(CHILD_ENV, () => runChild(childArgv(body), { cwd: f.cwd, agentDir: f.agentDir }));

  assert.equal(addendumBody((await run("inline role")).addenda[0]), "inline role");
  assert.equal((await run("")).addenda[0], undefined);
  // A leading dash or @ must survive Pi's argv parser as one flag value.
  assert.equal(addendumBody((await run("- bullet role")).addenda[0]), "- bullet role");
  assert.equal(addendumBody((await run("--double dash role")).addenda[0]), "--double dash role");
  assert.equal(addendumBody((await run("@mention role")).addenda[0]), "@mention role");
  // Multi-line bodies are one value.
  assert.equal(addendumBody((await run("line one\n\nline two")).addenda[0]), "line one\n\nline two");

  const roleFile = join(f.root, "agent-system-prompt.md");
  writeFileSync(roleFile, "\uFEFFFILE ROLE\n");
  const fileRun = await withEnv(CHILD_ENV, () =>
    runChild(
      childArgv("ignored", { promptLaunch: { systemPromptPath: roleFile, deferTaskPrompt: true } }),
      { cwd: f.cwd, agentDir: f.agentDir },
    ),
  );
  assert.equal(addendumBody(fileRun.addenda[0]), "FILE ROLE\n");
});

test("unreadable role file warns readably and falls back to the value as text", async (t) => {
  const f = fixture(t);
  const warnings: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    // A directory exists but cannot be read as a file.
    const directory = join(f.root, "role-dir");
    mkdirSync(directory);
    const run = await withEnv(CHILD_ENV, () =>
      runChild(
        childArgv("ignored", { promptLaunch: { systemPromptPath: directory, deferTaskPrompt: true } }),
        { cwd: f.cwd, agentDir: f.agentDir },
      ),
    );
    assert.equal(addendumBody(run.addenda[0]), directory);
    assert.ok(
      warnings.some((line) => line.includes("Could not read role prompt file") && line.includes(directory)),
      warnings.join("\n"),
    );
  } finally {
    console.error = originalError;
  }
});

test("disabled extension discovery and fast mode load the task extension exactly once", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.agentDir, "APPEND_SYSTEM.md"), "NATIVE");
  const disabled = await withEnv({ ...CHILD_ENV, PI_TASK_CHILD_NO_EXTENSIONS: "1" }, async () => {
    const argv = childArgv("ROLE");
    assert.ok(argv.includes("--no-extensions"));
    assert.equal(argv.filter((arg) => arg === TASK_EXTENSION_PATH).length, 1);
    return runChild(argv, { cwd: f.cwd, agentDir: f.agentDir });
  });
  assert.equal(addendumBody(disabled.addenda[0]), "NATIVE\n\nROLE");

  const requiredExtension = join(f.root, "required-extension.ts");
  writeFileSync(requiredExtension, "export default function () {}\n");
  const fast = await withEnv(CHILD_ENV, async () => {
    const argv = childArgv("ROLE", {
      fast: true,
      requiredExtensions: [requiredExtension, TASK_EXTENSION_PATH, requiredExtension],
    });
    assert.equal(argv.filter((arg) => arg === TASK_EXTENSION_PATH).length, 1);
    assert.equal(argv.filter((arg) => arg === "--fast").length, 1);
    assert.equal(argv.filter((arg) => arg === requiredExtension).length, 1);
    assert.ok(argv.includes("--no-mcp"));
    return runChild(argv, { cwd: f.cwd, agentDir: f.agentDir });
  });
  assert.deepEqual(fast.extensionErrors, []);
  assert.equal(addendumBody(fast.addenda[0]), "NATIVE\n\nROLE");
});

test("comparison launches share the same role argv path", async (t) => {
  const f = fixture(t);
  const launches: TerminalLaunchInput[] = [];
  const backend: TerminalBackend = {
    kind: "herdr",
    available: async () => true,
    launch: async (input) => {
      launches.push(input);
      return {
        backend: "herdr",
        resourceId: `pane-${launches.length}`,
        socketPath: "/fixture/herdr.sock",
        terminalId: `terminal-${launches.length}`,
      };
    },
    isAlive: async () => true,
    send: async () => {},
    readTail: async () => "",
    close: async () => {},
  };
  const sibling = (index: 0 | 1) => {
    const sessionDir = join(f.root, `sibling-${index}`);
    mkdirSync(sessionDir, { recursive: true });
    return {
      id: `s${index}`,
      index,
      model: `model-${index}`,
      agent: agent(`COMPARE ROLE ${index}`),
      desc: "compare",
      sessionName: `task-s${index}`,
      sessionDir,
    };
  };
  await withEnv({ PI_TASK_CHILD_NO_EXTENSIONS: undefined }, () =>
    launchComparisonTerminalTasks({
      siblings: [sibling(0), sibling(1)],
      agentName: "role",
      selectedBackend: "herdr",
      terminalBackend: backend,
      prompt: "compare",
      cwd: f.cwd,
      parentToolNames: [],
      taskToolName: "task",
      skillPaths: [],
      fast: false,
      taskExtensionPath: TASK_EXTENSION_PATH,
      isBackground: true,
    }),
  );
  assert.equal(launches.length, 2);
  for (const launch of launches) {
    const args = [...(launch.agentArgs ?? [])];
    assert.equal(args.includes("--append-system-prompt"), false);
    assert.equal(args[args.indexOf("--extension") + 1], TASK_EXTENSION_PATH);
    const role = args.find((arg) => arg.startsWith("--task-role-prompt="));
    assert.ok(role?.endsWith("agent-system-prompt.md"), `unexpected role arg ${role}`);
  }
});

test("repeated prompts do not accumulate the role or native append", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.agentDir, "APPEND_SYSTEM.md"), "NATIVE");
  const run = await withEnv(CHILD_ENV, () =>
    runChild(childArgv("ROLE"), { cwd: f.cwd, agentDir: f.agentDir, prompts: 3 }),
  );
  assert.equal(run.addenda.length, 3);
  for (const addendum of run.addenda) assert.equal(addendumBody(addendum), "NATIVE\n\nROLE");
});

test("child hook preserves AGENTS context, base prompt, and does not register the task tool", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.cwd, "AGENTS.md"), "PROJECT AGENTS RULES");
  const run = await withEnv(CHILD_ENV, () =>
    runChild(childArgv("ROLE"), { cwd: f.cwd, agentDir: f.agentDir, trusted: true }),
  );
  const sections = run.sections[0] ?? {};
  assert.match(sections.preamble ?? "", /expert coding assistant/);
  assert.match(JSON.stringify(sections), /PROJECT AGENTS RULES/);
  assert.equal(run.toolNames.includes("task"), false);
});

test("parent sessions and SDK children never inject a role", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.agentDir, "APPEND_SYSTEM.md"), "NATIVE");
  // Parent: task tool enabled; a stray flag value is inert because the
  // role hook is registered only for task-disabled children.
  const previousCwd = process.cwd();
  try {
    process.chdir(f.cwd);
    const parent = await withEnv({ PI_TASK_TOOL_DISABLED: undefined, PI_TASK_BACKEND: "sdk" }, () =>
      runChild(["--extension", TASK_EXTENSION_PATH, "--no-extensions", "--task-role-prompt=SHOULD NOT APPEAR"], {
        cwd: f.cwd,
        agentDir: f.agentDir,
      }),
    );
    assert.equal(addendumBody(parent.addenda[0]), "NATIVE");
    assert.ok(parent.toolNames.includes("task"));
  } finally {
    process.chdir(previousCwd);
  }

  // SDK-style child: task disabled, extension loaded, but no flag applied.
  const sdk = await withEnv(CHILD_ENV, () =>
    runChild(["--extension", TASK_EXTENSION_PATH, "--no-extensions"], {
      cwd: f.cwd,
      agentDir: f.agentDir,
    }),
  );
  assert.equal(addendumBody(sdk.addenda[0]), "NATIVE");
  assert.equal(sdk.toolNames.includes("task"), false);

  const sdkLoader = buildSdkResourceLoaderOptions({
    cwd: f.cwd,
    agentDir: f.agentDir,
    settingsManager: {} as never,
    systemPrompt: "child prompt",
  });
  assert.equal("appendSystemPrompt" in sdkLoader, false);
  assert.equal(sdkLoader.noExtensions, true);
});
