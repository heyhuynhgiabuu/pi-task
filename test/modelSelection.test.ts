import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildPiArgs, loadAgentsFromDir, type AgentConfig } from "../src/helpers.js";
import { buildSdkResourceLoaderOptions, resolveSdkModel } from "../src/subagent/runSdk.js";
import { buildPiArgv } from "../src/subagent/buildArgv.js";
import { resolveAgentSkillPaths, resolveDeclaredSkillPaths } from "../src/subagent/skills.js";

const bundledAgentDir = fileURLToPath(new URL("../agents/", import.meta.url));

test("bundled agents have catalog-safe prompts and tools", () => {
  const agents = loadAgentsFromDir(bundledAgentDir, "bundled");
  assert.equal(agents.length, 4);
  for (const agent of agents) {
    assert.notEqual(agent.description, ">", `${agent.name} has a folded description`);
    assert.doesNotMatch(
      readFileSync(agent.path, "utf8"),
      /multi_grep|observation|context7|deepwiki|webclaw_scrape|webclaw_batch|opensrc/i,
      `${agent.name} contains a retired or unavailable tool reference`,
    );
  }
});

test("bundled agents defer model selection to Pi", () => {
  for (const name of ["explore", "general", "reviewer", "scout"]) {
    const content = readFileSync(`${bundledAgentDir}/${name}.md`, "utf8");
    assert.doesNotMatch(content, /^model:/m, `${name} pins a model`);
  }
});

test("bundled agents declare role-appropriate native skills", () => {
  const skillsByAgent = new Map(
    loadAgentsFromDir(bundledAgentDir, "bundled").map((agent) => [agent.name, agent.skills]),
  );
  assert.deepEqual(skillsByAgent.get("explore"), ["memory"]);
  assert.deepEqual(skillsByAgent.get("general"), [
    "memory",
    "development-lifecycle",
    "test-driven-development",
    "verification-before-completion",
  ]);
  assert.deepEqual(skillsByAgent.get("reviewer"), [
    "memory",
    "code-review-and-quality",
    "verification-before-completion",
  ]);
  assert.deepEqual(skillsByAgent.get("scout"), ["memory", "source-driven-development"]);
});

test("terminal subagents defer to Pi unless an agent explicitly selects a model", () => {
  const agent: AgentConfig = {
    name: "test",
    description: "test agent",
    body: "",
    source: "bundled",
    path: "/agents/test.md",
  };

  const defaults = buildPiArgs(agent, "task-default", "/tmp", "prompt");
  assert.ok(!defaults.includes("--model"));

  const explicit = buildPiArgs(
    { ...agent, model: "anthropic/claude-sonnet" },
    "task-explicit",
    "/tmp",
    "prompt",
  );
  assert.deepEqual(
    explicit.slice(explicit.indexOf("--model"), explicit.indexOf("--model") + 2),
    ["--model", "anthropic/claude-sonnet"],
  );
});

test("declared skill names resolve to native Pi skill paths", () => {
  assert.deepEqual(
    resolveDeclaredSkillPaths(
      ["memory", "review"],
      [
        { name: "memory", filePath: "/skills/memory/SKILL.md" },
        { name: "review", filePath: "/skills/review/SKILL.md" },
      ],
    ),
    ["/skills/memory/SKILL.md", "/skills/review/SKILL.md"],
  );
  assert.throws(
    () => resolveDeclaredSkillPaths(["missing"], []),
    /Declared subagent skill\(s\) not found: missing/,
  );
});

test("native skill resolution honors project trust", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-skills-"));
  const skillDir = join(root, ".pi", "skills", "local");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    "---\nname: local\ndescription: local test skill\n---\nUse the local skill.\n",
  );
  try {
    await assert.rejects(
      resolveAgentSkillPaths(["local"], root, false),
      /Declared subagent skill\(s\) not found: local/,
    );
    const trustedPaths = await resolveAgentSkillPaths(["local"], root, true);
    assert.deepEqual(trustedPaths, [join(skillDir, "SKILL.md")]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminal subagents pass declared skill paths to Pi", () => {
  const agent: AgentConfig = {
    name: "test",
    description: "test agent",
    body: "",
    source: "bundled",
    path: "/agents/test.md",
  };
  const args = buildPiArgv({
    agent,
    sessionName: "task-skills",
    sessionDir: "/tmp/tasks",
    promptContent: "prompt",
    skillPaths: ["/skills/memory/SKILL.md", "/skills/review/SKILL.md"],
  } as Parameters<typeof buildPiArgv>[0]);
  const firstSkill = args.indexOf("--skill");
  assert.deepEqual(args.slice(firstSkill, firstSkill + 4), [
    "--skill",
    "/skills/memory/SKILL.md",
    "--skill",
    "/skills/review/SKILL.md",
  ]);
});

test("SDK subagents pass declared skill paths to the native resource loader", () => {
  const settingsManager = { isProjectTrusted: () => true } as never;
  const options = buildSdkResourceLoaderOptions({
    cwd: "/tmp/task",
    agentDir: "/tmp/agent",
    settingsManager,
    systemPrompt: "system",
    skillPaths: ["/skills/memory/SKILL.md"],
  });
  assert.equal(options.cwd, "/tmp/task");
  assert.equal(options.agentDir, "/tmp/agent");
  assert.deepEqual(options.additionalSkillPaths, ["/skills/memory/SKILL.md"]);
  assert.equal(options.noExtensions, true);
});

test("SDK subagents use the current Pi model when their agent has no model", async () => {
  const current = { id: "gpt-5", provider: { id: "openai" } };
  const fallback = { id: "other", provider: { id: "other" } };

  const resolved = await resolveSdkModel({
    model: current,
    modelRegistry: { getAll: () => [fallback] },
  });

  assert.equal(resolved, current);
});

test("SDK subagents preserve an explicitly configured agent model", async () => {
  const current = { id: "gpt-5", provider: { id: "openai" } };
  const configured = { id: "claude-sonnet", provider: { id: "anthropic" } };

  const resolved = await resolveSdkModel(
    {
      model: current,
      modelRegistry: {
        find: (provider: string, modelId: string) =>
          provider === "anthropic" && modelId === "claude-sonnet"
            ? configured
            : undefined,
      },
    },
    "anthropic/claude-sonnet",
  );

  assert.equal(resolved, configured);
});

test("SDK subagents reject unavailable explicitly requested models", async () => {
  const current = { id: "gpt-5", provider: { id: "openai" } };
  const resolved = await resolveSdkModel(
    {
      model: current,
      modelRegistry: {
        find: () => undefined,
        getAll: () => [{ id: "other", provider: { id: "other" } }],
      },
    },
    "nonexistent/model",
  );

  assert.equal(resolved, undefined);
});
