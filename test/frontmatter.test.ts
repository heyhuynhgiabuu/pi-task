import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envTurnLimit, loadAgentsFromDir, parseBool, parseModelList, parseModelSpecs, resolveTaskFastMode, resolveTaskThinking, type AgentConfig } from "../src/helpers.js";

{
  const t = "parseBool";
  assert.equal(parseBool(true), true, t);
  assert.equal(parseBool(false), false, t);
  assert.equal(parseBool("true"), true, t);
  assert.equal(parseBool("yes"), true, t);
  assert.equal(parseBool("false"), false, t);
  assert.equal(parseBool(undefined), undefined, t);
}

{
  const t = "loadAgentsFromDir parses hidden proactive readonly";
  const root = mkdtempSync(join(tmpdir(), "task-fm-"));
  try {
    const dir = join(root, "agents");
    mkdirSync(dir);
    writeFileSync(
      join(dir, "meta.md"),
      `---
description: Meta agent
skills: memory, verification-before-completion
hidden: true
proactive: yes
readonly: true
fast: true
---
Body.`,
    );
    writeFileSync(
      join(dir, "skip.md"),
      `---
model: foo
---
No description.`,
    );

    const agents = loadAgentsFromDir(dir, "bundled");
    assert.equal(agents.length, 1, t + " count");
    const a = agents[0]!;
    assert.equal(a.name, "meta", t);
    assert.equal(a.hidden, true, t + " hidden");
    assert.equal(a.proactive, true, t + " proactive");
    assert.equal(a.readonly, true, t + " readonly");
    assert.equal(a.fast, true, t + " fast");
      assert.deepEqual(a.skills, ["memory", "verification-before-completion"], t + " skills");
      assert.ok(
        !a.disallowedTools.includes("harness"),
        "readonly does not inject absent orchestration tools into disallowed tools",
      );

  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const t = "loadAgentsFromDir accepts CRLF frontmatter from Windows checkouts";
  const root = mkdtempSync(join(tmpdir(), "task-fm-crlf-"));
  try {
    const dir = join(root, "agents");
    mkdirSync(dir);
    writeFileSync(
      join(dir, "crlf.md"),
      "---\r\ndescription: CRLF agent\r\nfast: true\r\n---\r\nBody.\r\n",
    );
    const agent = loadAgentsFromDir(dir, "bundled")[0];
    assert.equal(agent?.description, "CRLF agent", t + " description");
    assert.equal(agent?.fast, true, t + " fast");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const t = "resolveTaskFastMode prefers the agent setting over the session flag";
  assert.equal(resolveTaskFastMode(undefined, true), true, t + ": the session flag applies when the agent is silent");
  assert.equal(resolveTaskFastMode(undefined, false), false, t + ": no flag and no setting");
  assert.equal(resolveTaskFastMode(true, false), true, t + ": agent true wins");
  assert.equal(resolveTaskFastMode(false, true), false, t + ": agent false wins");
}

{
  const t = "resolveTaskThinking uses the call value only when frontmatter is silent";
  const base: AgentConfig = {
    name: "dynamic",
    description: "Dynamic agent",
    body: "",
    source: "bundled",
    path: "",
  };
  const resolved = resolveTaskThinking(base, "high");
  assert.equal(resolved.thinking, "high", t + ": call value applies");
  assert.notEqual(resolved, base, t + ": dynamic agent is copied");
  assert.equal(base.thinking, undefined, t + ": source agent is unchanged");
  assert.equal(
    resolveTaskThinking({ ...base, thinking: "max" }, "low").thinking,
    "max",
    t + ": frontmatter wins",
  );
  assert.equal(resolveTaskThinking(base), base, t + ": no request preserves identity");
}

{
  const t = "parseModelList parses single, comma-separated, bracketed, and array inputs";
  assert.deepEqual(parseModelList(undefined), [], t + " undefined");
  assert.deepEqual(parseModelList(""), [], t + " empty string");
  assert.deepEqual(parseModelList("openai/gpt-4o"), ["openai/gpt-4o"], t + " single");
  assert.deepEqual(
    parseModelList("openai/gpt-4o, anthropic/claude-3-5-sonnet"),
    ["openai/gpt-4o", "anthropic/claude-3-5-sonnet"],
    t + " comma-separated",
  );
  assert.deepEqual(
    parseModelList("[openai/gpt-4o, anthropic/claude-3-5-sonnet]"),
    ["openai/gpt-4o", "anthropic/claude-3-5-sonnet"],
    t + " bracketed",
  );
  assert.deepEqual(
    parseModelList(["'openai/gpt-4o'", '"anthropic/claude-3-5-sonnet"']),
    ["openai/gpt-4o", "anthropic/claude-3-5-sonnet"],
    t + " array with quotes",
  );
}

{
  const t = "parseModelSpecs parses model with inline thinking and parallel thinking list";
  assert.deepEqual(
    parseModelSpecs("zai/glm-5.3 max, antigravity/gemini-3.8-flash high"),
    [
      { model: "zai/glm-5.3", thinking: "max" },
      { model: "antigravity/gemini-3.8-flash", thinking: "high" },
    ],
    t + " inline thinking",
  );
  assert.deepEqual(
    parseModelSpecs("zai/glm-5.3, antigravity/gemini-3.8-flash", undefined, "max, high"),
    [
      { model: "zai/glm-5.3", thinking: "max" },
      { model: "antigravity/gemini-3.8-flash", thinking: "high" },
    ],
    t + " parallel thinking list",
  );
}

{
  const t = "loadAgentsFromDir parses models and preserves backwards compatibility with model";
  const root = mkdtempSync(join(tmpdir(), "task-fm-models-"));
  try {
    const dir = join(root, "agents");
    mkdirSync(dir);
    writeFileSync(
      join(dir, "multi.md"),
      `---
description: Multi-model agent
models:
  - openai/gpt-4o
  - anthropic/claude-3-5-sonnet
---
Body.`,
    );
    writeFileSync(
      join(dir, "legacy.md"),
      `---
description: Legacy single-model agent
model: google/gemini-2.0-flash
---
Body.`,
    );
    writeFileSync(
      join(dir, "inline.md"),
      `---
description: Inline models agent
models: openai/gpt-4o-mini, anthropic/claude-3-haiku
---
Body.`,
    );

    const agents = loadAgentsFromDir(dir, "bundled");
    const multi = agents.find((a) => a.name === "multi")!;
    const legacy = agents.find((a) => a.name === "legacy")!;
    const inline = agents.find((a) => a.name === "inline")!;

    assert.ok(multi, t + " multi exists");
    assert.deepEqual(multi.models, ["openai/gpt-4o", "anthropic/claude-3-5-sonnet"], t + " multi models");
    assert.equal(multi.model, "openai/gpt-4o", t + " multi fallback model");

    assert.ok(legacy, t + " legacy exists");
    assert.equal(legacy.model, "google/gemini-2.0-flash", t + " legacy model");
    assert.deepEqual(legacy.models, ["google/gemini-2.0-flash"], t + " legacy models normalized");

    assert.ok(inline, t + " inline exists");
    assert.deepEqual(inline.models, ["openai/gpt-4o-mini", "anthropic/claude-3-haiku"], t + " inline models");
    assert.equal(inline.model, "openai/gpt-4o-mini", t + " inline fallback model");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("frontmatter.test.ts: all passed");
{
  const t = "loadAgentsFromDir parses max_turns";
  const root = mkdtempSync(join(tmpdir(), "task-fm-turns-"));
  try {
    const dir = join(root, "agents");
    mkdirSync(dir);
    writeFileSync(
      join(dir, "limited.md"),
      `---\ndescription: Limited agent\nmax_turns: 40\n---\nBody.`,
    );
    writeFileSync(
      join(dir, "badturns.md"),
      `---\ndescription: Bad turns agent\nmax_turns: banana\n---\nBody.`,
    );
    writeFileSync(
      join(dir, "noturns.md"),
      `---\ndescription: No turns agent\n---\nBody.`,
    );

    const agents = loadAgentsFromDir(dir, "bundled");
    const maxTurnsOf = (name: string): number | undefined =>
      (agents.find((a) => a.name === name) as (AgentConfig & { maxTurns?: number }) | undefined)?.maxTurns;
    assert.equal(maxTurnsOf("limited"), 40, t + " parsed");
    assert.equal(maxTurnsOf("badturns"), undefined, t + " invalid value ignored");
    assert.equal(maxTurnsOf("noturns"), undefined, t + " absent frontmatter stays undefined");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const t = "envTurnLimit: PI_TASK_MAX_TURNS global default with precedence to frontmatter";
  const prev = process.env.PI_TASK_MAX_TURNS;
  try {
    delete process.env.PI_TASK_MAX_TURNS;
    assert.equal(envTurnLimit(), undefined, t + " unset means unlimited");
    process.env.PI_TASK_MAX_TURNS = "25";
    assert.equal(envTurnLimit(), 25, t + " valid value parsed");
    process.env.PI_TASK_MAX_TURNS = "banana";
    assert.equal(envTurnLimit(), undefined, t + " invalid value ignored");
    process.env.PI_TASK_MAX_TURNS = "0";
    assert.equal(envTurnLimit(), undefined, t + " zero ignored");

    const agentWithFrontmatter = { maxTurns: 40 } as AgentConfig & { maxTurns: number };
    assert.equal(
      agentWithFrontmatter.maxTurns ?? envTurnLimit(),
      40,
      t + " frontmatter beats env",
    );
  } finally {
    if (prev === undefined) delete process.env.PI_TASK_MAX_TURNS;
    else process.env.PI_TASK_MAX_TURNS = prev;
  }
}

test("model: claude-code/<model> implies claude runtime and bypassPermissions default", async () => {
  const { loadAgentsFromDir } = await import("../src/helpers.js");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "pi-task-claude-"));
  try {
    writeFileSync(join(dir, "a.md"), `---\ndescription: x\nmodel: claude-code/opus\n---\nbody`);
    writeFileSync(join(dir, "b.md"), `---\ndescription: x\nmodel: claude-code/opus\npermission_mode: acceptEdits\n---\nbody`);
    writeFileSync(join(dir, "c.md"), `---\ndescription: x\nmodel: opus\n---\nbody`);
    writeFileSync(join(dir, "d.md"), `---\ndescription: x\nmodel: claude-code/\n---\nbody`);
    const agents = loadAgentsFromDir(dir, "project");
    const a = agents.find((x) => x.name === "a")!;
    const b = agents.find((x) => x.name === "b")!;
    const c = agents.find((x) => x.name === "c")!;
    const d = agents.find((x) => x.name === "d")!;
    assert.equal(a.runtime, "claude");
    assert.equal(a.model, "opus");
    assert.equal(a.permissionMode, "bypassPermissions");
    assert.equal(b.runtime, "claude");
    assert.equal(b.permissionMode, "acceptEdits");
    assert.equal(c.runtime, undefined);
    assert.equal(c.model, "opus");
    assert.equal(d.runtime, "claude");
    assert.equal(d.model, undefined);
    assert.equal(d.permissionMode, "bypassPermissions");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claude tool policy: frontmatter load to buildChildArgs without rejecting injected xAI defaults", async () => {
  const { loadAgentsFromDir } = await import("../src/helpers.js");
  const { buildChildArgs } = await import("../src/subagent/buildArgv.js");
  const { resolveClaudeToolPolicy } = await import("../src/agent-tools.js");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = mkdtempSync(join(tmpdir(), "pi-task-claude-policy-"));
  try {
    writeFileSync(
      join(dir, "plain.md"),
      `---\ndescription: plain claude worker\nmodel: claude-code/sonnet\n---\nbody`,
    );
    writeFileSync(
      join(dir, "combined.md"),
      [
        "---",
        "description: claude worker with allow and deny",
        "runtime: claude",
        "tools: read, bash",
        "disallowed_tools:",
        "  - bash",
        "  - write",
        "---",
        "body",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "unsupported.md"),
      `---\ndescription: claude worker with unmappable deny\nruntime: claude\ndisallowed_tools: memory-search\n---\nbody`,
    );
    writeFileSync(
      join(dir, "pinet.md"),
      `---\ndescription: pi worker\nmodel: gpt-5\n---\nbody`,
    );

    const agents = loadAgentsFromDir(dir, "project");
    const plain = agents.find((a) => a.name === "plain")!;
    const combined = agents.find((a) => a.name === "combined")!;
    const unsupported = agents.find((a) => a.name === "unsupported")!;

    const opts = {
      sessionName: "task-x",
      sessionDir: join(dir, "sessions"),
      promptContent: "p",
      sessionId: "00000000-0000-4000-8000-00000000000a",
      deferTaskPrompt: true,
    };

    // Minimal claude agent: no xAI provider defaults injected, policy keeps
    // the Claude default tool surface, and the child argv builds cleanly.
    assert.equal(plain.runtime, "claude");
    assert.ok(
      !plain.disallowedTools?.some((t) => t.startsWith("xai_")),
      "xAI provider defaults are not injected into claude agents",
    );
    assert.deepEqual(
      resolveClaudeToolPolicy({ tools: plain.tools, disallowedTools: plain.disallowedTools }),
      { tools: "default" },
      "unrestricted claude agent keeps tools: default",
    );
    const plainArgs = buildChildArgs(plain, opts);
    assert.ok(!plainArgs.includes("--tools"), "no --tools allowlist emitted");
    assert.ok(!plainArgs.includes("--disallowedTools"), "no deny list emitted");

    // Explicit tools + disallowed_tools: both flags reach the CLI with
    // correct pi→Claude mappings; deny survives alongside the allowlist.
    assert.deepEqual(
      combined.disallowedTools,
      ["bash", "write"],
      "user-declared disallowed_tools preserved on claude runtime",
    );
    const combinedArgs = buildChildArgs(combined, opts);
    const flagValue = (flag: string) => {
      const i = combinedArgs.indexOf(flag);
      return i >= 0 ? combinedArgs[i + 1] : undefined;
    };
    assert.equal(flagValue("--tools"), "Read,Bash");
    assert.equal(flagValue("--disallowedTools"), "Bash,Write");

    // User-declared unmappable restrictions still reject at spawn time.
    assert.throws(
      () => buildChildArgs(unsupported, opts),
      /cannot be mapped to Claude Code built-in tools[\s\S]*"memory-search"/,
    );

    // Pi runtime loading keeps the provider default deny list unchanged.
    const piAgent = loadAgentsFromDir(dir, "project").find((a) => a.name === "pinet")!;
    assert.ok(
      piAgent.disallowedTools?.includes("xai_web_search"),
      "pi runtime still injects xAI default disallowed tools",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
