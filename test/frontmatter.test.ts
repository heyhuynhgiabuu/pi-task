import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envTurnLimit, loadAgentsFromDir, parseBool, parseModelList, parseModelSpecs, resolveTaskFastMode, type AgentConfig } from "../src/helpers.js";

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
  const t = "resolveTaskFastMode gives explicit task fast precedence over agent defaults";
  assert.equal(resolveTaskFastMode(undefined, true), true, t + " omitted task uses agent true");
  assert.equal(resolveTaskFastMode(undefined, false), false, t + " omitted task uses agent false");
  assert.equal(resolveTaskFastMode(undefined, undefined), false, t + " omitted defaults false");
  assert.equal(resolveTaskFastMode(true, false), true, t + " explicit true wins");
  assert.equal(resolveTaskFastMode(false, true), false, t + " explicit false wins");
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
