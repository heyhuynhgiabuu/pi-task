import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { initTheme, ProjectTrustStore, type SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { createTaskWidgetController } from "../src/lifecycle/widget.js";
import type { TaskTranscriptOverlay } from "../src/panel/task-transcript-overlay.js";
import {
  availableChildBuiltinCommands,
  loadChildPromptTemplates,
  routeChildBuiltinCommand,
} from "../src/panel/child-prompts.js";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writePrompt(cwd: string, name: string, content: string): string {
  const path = join(cwd, ".pi", "prompts", `${name}.md`);
  mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
  writeFileSync(path, content, "utf8");
  return path;
}

function promptCommand(
  name: string,
  path: string,
  scope: "user" | "project" = "user",
  source = "local",
) {
  return {
    name,
    description: `prompt ${name}`,
    source: "prompt",
    sourceInfo: { path, source, scope, origin: "top-level" },
  } as SlashCommandInfo;
}

function extensionCommand(name: string, source: "extension" | "skill" = "extension"): SlashCommandInfo {
  return {
    name,
    source,
    sourceInfo: { path: "/parent/extension.js", source: "local", scope: "user", origin: "top-level" },
  };
}

const reviewBody = [
  "---",
  "description: Review a file",
  "argument-hint: <file> [mode]",
  "---",
  "Review $1 with $2; all=$@; fallback=${3:-safe}.",
].join("\n");

test("child prompt autocomplete is scoped to enabled prompt templates and native expansion uses quoted arguments", async () => {
  const root = tempDir("pi-task-child-prompts-");
  try {
    const agentDir = join(root, "agent");
    const parentCwd = join(root, "parent");
    const childCwd = join(root, "child");
    mkdirSync(parentCwd, { recursive: true });
    mkdirSync(childCwd, { recursive: true });

    const reviewPath = writePrompt(childCwd, "review", reviewBody);
    const childExplicitPath = join(childCwd, "custom-prompts", "from-settings.md");
    mkdirSync(join(childCwd, "custom-prompts"), { recursive: true });
    writeFileSync(childExplicitPath, "Child setting template: $1", "utf8");
    writeFileSync(
      join(childCwd, ".pi", "settings.json"),
      JSON.stringify({ prompts: ["../custom-prompts"] }),
      "utf8",
    );
    writePrompt(childCwd, "model", "A template that must not shadow Pi's /model command.");
    writePrompt(childCwd, "ship", "A template that must not shadow the parent extension.");
    mkdirSync(agentDir, { recursive: true });
    new ProjectTrustStore(agentDir).set(childCwd, true);
    const explicitPath = join(root, "parent-explicit.md");
    writeFileSync(explicitPath, "Explicit parent template: $1", "utf8");
    const disabledPath = join(root, "not-enabled.md");
    writeFileSync(disabledPath, "This path was not returned by getCommands().", "utf8");

    const service = await loadChildPromptTemplates({
      cwd: childCwd,
      parentCwd,
      parentProjectTrusted: true,
      agentDir,
      parentCommands: [
        promptCommand("parent-explicit", explicitPath),
        extensionCommand("ship"),
        // A file being present is not enough: only enabled parent descriptors
        // are carried into the child resource loader.
      ],
    });

    assert.deepEqual(
      service.templates.map((template) => template.name).sort(),
      ["from-settings", "model", "parent-explicit", "review", "ship"],
    );
    assert.ok(service.templates.some((template) => template.filePath === reviewPath));
    assert.ok(
      service.templates.some((template) => template.filePath === childExplicitPath),
      "trusted child settings paths are resolved relative to the child .pi directory",
    );
    assert.ok(!service.templates.some((template) => template.filePath === disabledPath));

    const signal = new AbortController().signal;
    const suggestions = await service.autocompleteProvider.getSuggestions(
      ["/rev"],
      0,
      4,
      { signal },
    );
    assert.ok(suggestions?.items.some((item) => item.value === "review"));
    const parentSuggestions = await service.autocompleteProvider.getSuggestions(
      ["/par"],
      0,
      4,
      { signal },
    );
    assert.ok(parentSuggestions?.items.some((item) => item.value === "parent-explicit"));
    assert.ok(
      !(suggestions?.items ?? []).some((item) => ["model", "ship"].includes(item.value)),
      "Pi built-ins and parent extension commands are not advertised as child templates",
    );
    const builtinSuggestions = await service.autocompleteProvider.getSuggestions(
      ["/model"],
      0,
      6,
      { signal },
    );
    assert.equal(builtinSuggestions, null, "the child editor does not offer /model");

    assert.equal(
      service.prepareSteeringInput('/review "some file.ts" strict', "durable").text,
      "Review some file.ts with strict; all=some file.ts strict; fallback=safe.",
      "durable steering uses Pi's native quoted-argument and placeholder expansion",
    );
    assert.equal(
      service.prepareSteeringInput('/parent-explicit "arg with spaces"', "durable").text,
      "Explicit parent template: arg with spaces",
      "enabled parent prompt paths are expanded from their actual file bodies",
    );

    const sdkInput = '/review "some file.ts" strict';
    assert.deepEqual(
      service.prepareSteeringInput(sdkInput, "sdk"),
      { text: sdkInput },
      "SDK input remains raw so AgentSession.steer performs exactly one native expansion",
    );
    assert.match(
      service.prepareSteeringInput("/model something", "durable").error ?? "",
      /conflicts with a Pi built-in/,
    );
    assert.equal(
      (await routeChildBuiltinCommand("/model something", "durable"))?.kind,
      "supported",
      "the child built-in router runs before the same-named template expansion path",
    );
    assert.match(
      service.prepareSteeringInput("/ship something", "terminal").error ?? "",
      /conflicts with a Pi built-in or parent-session command/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("child built-in routing and autocomplete expose only verified backend commands", async () => {
  const terminal = await availableChildBuiltinCommands("terminal");
  const sdk = await availableChildBuiltinCommands("sdk");
  const durable = await availableChildBuiltinCommands("durable");
  const names = (commands: readonly { name: string }[]) => commands.map(({ name }) => name);

  assert.deepEqual(names(terminal), ["thinking", "name", "session"]);
  assert.deepEqual(names(sdk), ["model", "thinking", "name", "session"]);
  assert.deepEqual(names(durable), ["model", "thinking", "session", "compact", "resume"]);
  assert.ok(terminal.every((command) => command.description?.includes("child")));

  assert.deepEqual(await routeChildBuiltinCommand("/model openai/gpt-test", "sdk"), {
    kind: "supported",
    command: { name: "model", argument: "openai/gpt-test", rawText: "/model openai/gpt-test" },
  });
  assert.deepEqual(await routeChildBuiltinCommand("/thinking high", "terminal"), {
    kind: "supported",
    command: { name: "thinking", argument: "high", rawText: "/thinking high" },
  });
  assert.deepEqual(await routeChildBuiltinCommand("/session", "terminal"), {
    kind: "supported",
    command: { name: "session", argument: "", rawText: "/session" },
  }, "terminal Pi children expose read-only session information from their own transcript file");
  assert.ok((await availableChildBuiltinCommands("terminal")).some(({ name }) => name === "session"));
  assert.deepEqual(await routeChildBuiltinCommand("/compact keep the failing test names", "durable"), {
    kind: "supported",
    command: {
      name: "compact",
      argument: "keep the failing test names",
      rawText: "/compact keep the failing test names",
    },
  });
  assert.equal((await routeChildBuiltinCommand("/resume", "durable"))?.kind, "supported");
  assert.equal((await routeChildBuiltinCommand("/resume", "sdk"))?.kind, "unsupported", "SDK /resume cannot switch the parent session");
  assert.equal(
    (await routeChildBuiltinCommand("/model\topenai/example", "sdk"))?.command.argument,
    "openai/example",
    "native command names are recognized when arguments use non-space whitespace",
  );
  const login = await routeChildBuiltinCommand("/login openai", "terminal");
  assert.equal(login?.kind, "unsupported");
  assert.match(login?.message ?? "", /credential/i);
  assert.deepEqual(await availableChildBuiltinCommands("none"), []);
  for (const [text, backend, reason] of [
    ["/logout", "sdk", /credential/i],
    ["/trust", "terminal", /trust/i],
    ["/import ./old-session.jsonl", "sdk", /session switching/i],
    ["/share", "durable", /private session data/i],
    ["/export", "terminal", /private session data/i],
    ["/quit", "terminal", /never forwarded/i],
    ["/compact", "sdk", /one-shot runner/i],
    ["/model", "terminal", /any mismatch opens Pi's model selector/],
    ["/llama", "durable", /llama\.cpp extension/i],
    ["/llama", "terminal", /requires its interactive UI/i],
  ] as const) {
    const denied = await routeChildBuiltinCommand(text, backend);
    assert.equal(denied?.kind, "unsupported", `${text} is explicitly denied`);
    assert.match(denied?.message ?? "", reason);
  }
  assert.equal(await routeChildBuiltinCommand("/not-a-command arg", "sdk"), undefined);

  const root = tempDir("pi-task-command-autocomplete-");
  try {
    const service = await loadChildPromptTemplates({
      cwd: root,
      parentCwd: root,
      parentProjectTrusted: true,
      agentDir: join(root, "agent"),
      parentCommands: [],
      backend: "sdk",
    });
    const suggestions = await service.autocompleteProvider.getSuggestions(
      ["/mod"],
      0,
      5,
      { signal: new AbortController().signal },
    );
    assert.ok(suggestions?.items.some((item) => item.value === "model"));
    assert.ok(
      !suggestions?.items.some((item) => ["login", "logout", "share", "quit"].includes(item.value)),
      "unsafe or unsupported Pi commands are not advertised",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prompt discovery follows the child cwd and does not inherit another project's auto-discovered prompts", async () => {
  const root = tempDir("pi-task-child-cwd-");
  try {
    const agentDir = join(root, "agent");
    const parentCwd = join(root, "parent");
    const childCwd = join(root, "child");
    const parentPrompt = writePrompt(parentCwd, "parent-local", "Parent project default.");
    const childPrompt = writePrompt(childCwd, "child-local", "Child project default.");
    mkdirSync(agentDir, { recursive: true });
    new ProjectTrustStore(agentDir).set(childCwd, true);

    const service = await loadChildPromptTemplates({
      cwd: childCwd,
      parentCwd,
      parentProjectTrusted: true,
      agentDir,
      parentCommands: [promptCommand("parent-local", parentPrompt, "project", "auto")],
    });
    assert.ok(service.templates.some((template) => template.filePath === childPrompt));
    assert.ok(
      !service.templates.some((template) => template.filePath === parentPrompt),
      "another cwd's implicit project prompt directory is not inherited",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("untrusted child prompt resources stay hidden and discovery never executes child extensions", async () => {
  const root = tempDir("pi-task-child-trust-");
  try {
    const agentDir = join(root, "agent");
    const parentCwd = join(root, "parent");
    const childCwd = join(root, "child");
    const projectPrompt = writePrompt(childCwd, "private", "Untrusted project template.");
    const marker = join(root, "extension-executed");
    const extensionPath = join(childCwd, ".pi", "extensions", "side-effect.js");
    mkdirSync(join(childCwd, ".pi", "extensions"), { recursive: true });
    writeFileSync(
      extensionPath,
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran");`,
      "utf8",
    );
    writeFileSync(
      join(childCwd, ".pi", "settings.json"),
      JSON.stringify({ extensions: ["./extensions/side-effect.js"] }),
      "utf8",
    );

    const service = await loadChildPromptTemplates({
      cwd: childCwd,
      parentCwd,
      parentProjectTrusted: false,
      agentDir,
      parentCommands: [],
    });
    assert.ok(!service.templates.some((template) => template.filePath === projectPrompt));
    assert.equal(existsSync(marker), false, "prompt discovery does not load/execute extensions");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the durable task-view steering path expands a child prompt template before admission", async () => {
  const root = tempDir("pi-task-durable-steer-");
  const cwd = join(root, "child");
  const agentDir = join(root, "agent");
  writePrompt(cwd, "review", reviewBody);
  const task = {
    agentType: "general",
    sessionName: "durable-steer",
    originalPane: null,
    description: "durable steer test",
    startedAt: Date.now(),
    toolUses: 0,
    turns: 0,
    recentCalls: [],
    dir: root,
    cwd,
    backend: "durable",
    status: "running",
  };
  let factory: ((tui: unknown, theme: unknown, keys: unknown, done: () => void) => TaskTranscriptOverlay) | undefined;
  const context = {
    mode: "tui",
    hasUI: true,
    cwd,
    isProjectTrusted: () => true,
    ui: {
      getEditorComponent: () => undefined,
      setEditorComponent: () => {},
      setWidget: () => {},
      notify: () => {},
      custom: (make: typeof factory) => {
        factory = make;
        return new Promise<unknown>(() => {});
      },
    },
  } as never;
  const steered: string[] = [];
  const controller = createTaskWidgetController(
    new Map([["durable-steer", task as never]]),
    new Map(),
    {
      getCommands: () => [],
      getPromptAgentDir: () => agentDir,
      steerTask: (_task, _id, text) => {
        steered.push(text);
        return null;
      },
      stopTask: () => null,
    },
  );
  initTheme();
  controller.ensureTaskWidget(context);
  controller.openTaskView("durable-steer");
  assert.ok(factory, "the child transcript overlay was created");
  const overlay = factory(
    { terminal: { rows: 30, columns: 90 }, requestRender: () => {} },
    { fg: (_token: string, text: string) => text, bg: (_token: string, text: string) => text },
    { matches: () => false },
    () => {},
  );
  try {
    const editor = (overlay as unknown as {
      editor: { setText(text: string): void; getText(): string; isShowingAutocomplete?: () => boolean };
    }).editor;
    editor.setText('/review "some file.ts" strict');
    // This case exercises submission routing, not menu acceptance (covered by
    // taskTranscriptOverlay.test.ts); keep the fake terminal's menu closed.
    editor.isShowingAutocomplete = () => false;
    assert.equal(editor.getText(), '/review "some file.ts" strict');
    overlay.handleInput("\r");
    assert.equal(editor.getText(), "", "the editor submitted its text");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(steered, [
      "Review some file.ts with strict; all=some file.ts strict; fallback=safe.",
    ]);
  } finally {
    overlay.dispose();
    controller.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown commands stay literal, terminal Pi commands are isolated, and SDK steering is not pre-expanded", async () => {
  const root = tempDir("pi-task-command-isolation-");
  try {
    const cwd = join(root, "child");
    mkdirSync(cwd, { recursive: true });
    const service = await loadChildPromptTemplates({
      cwd,
      parentCwd: cwd,
      parentProjectTrusted: true,
      agentDir: join(root, "agent"),
      parentCommands: [extensionCommand("parent-only"), extensionCommand("skill:parent-skill", "skill")],
    });

    for (const command of ["/model", "/compact", "/quit"]) {
      assert.equal(
        service.prepareSteeringInput(command, "terminal").text,
        `\u2060${command}`,
        `${command} is sent as prompt text instead of running in the terminal child`,
      );
      assert.equal(service.prepareSteeringInput(command, "sdk").text, command);
      assert.equal(service.prepareSteeringInput(command, "durable").text, command);
    }
    assert.equal(service.prepareSteeringInput("/not-a-command arg", "terminal").text, "/not-a-command arg");
    assert.equal(service.prepareSteeringInput("/parent-only arg", "terminal").text, "\u2060/parent-only arg");
    assert.equal(service.prepareSteeringInput("/skill:parent-skill", "terminal").text, "\u2060/skill:parent-skill");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
