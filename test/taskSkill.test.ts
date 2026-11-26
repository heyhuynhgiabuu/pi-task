import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ResourcesDiscoverResult } from "@earendil-works/pi-coding-agent";
import taskExtension from "../src/index.js";
import { buildSdkResourceLoaderOptions } from "../src/subagent/runSdk.js";

function registerExtension(child = false, argv: string[] = []) {
  const handlers = new Map<string, () => ResourcesDiscoverResult | undefined>();
  const oldDisabled = process.env.PI_TASK_TOOL_DISABLED;
  const oldArgv = process.argv;
  try {
    if (child) process.env.PI_TASK_TOOL_DISABLED = "1";
    else delete process.env.PI_TASK_TOOL_DISABLED;
    process.argv = [oldArgv[0], oldArgv[1], ...argv];
    taskExtension({
      on(event: string, handler: () => ResourcesDiscoverResult | undefined) { handlers.set(event, handler); },
      registerFlag() {},
      getFlag() { return undefined; },
      registerTool() {},
      registerCommand() {},
      registerMessageRenderer() {},
    } as never);
  } finally {
    handlers.get("session_shutdown")?.();
    process.argv = oldArgv;
    if (oldDisabled === undefined) delete process.env.PI_TASK_TOOL_DISABLED;
    else process.env.PI_TASK_TOOL_DISABLED = oldDisabled;
  }
  return handlers;
}

test("parent extension exposes its bundled delegation skill", () => {
  const paths = registerExtension().get("resources_discover")?.()?.skillPaths;
  assert.ok(paths);
  assert.deepEqual(paths, [fileURLToPath(new URL("../resources/task/SKILL.md", import.meta.url))]);
  const skill = readFileSync(paths[0], "utf8");
  assert.match(skill, /name: task/);
  assert.match(skill, /goal, scope, non-goals, write policy, acceptance criteria, verification recipe/i);
  assert.match(skill, /no design changes/i);
  assert.match(skill, /what must not break/i);
  assert.match(skill, /approaches already tried/i);
  assert.match(skill, /does not create, merge, or remove worktrees/i);
  assert.match(skill, /PI_TASK_TOOL_NAME/);
  assert.match(skill, /starts or resumes a named, reusable specialist conversation/i);
  assert.match(skill, /SDK and SQLite durable backends do not support this parameter/i);
});

test("delegation-disabled children do not expose the parent skill", () => {
  assert.equal(registerExtension(true).has("resources_discover"), false);
});

for (const flag of ["--no-skills", "-ns"]) {
  test(`the extension respects ${flag}`, () => {
    const handler = registerExtension(false, [flag]).get("resources_discover");
    assert.ok(handler, "the parent registers discovery even when skills are disabled");
    assert.equal(handler(), undefined);
  });
}

test("SDK package discovery does not expose the parent-only guide", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-sdk-skill-"));
  try {
    const loader = new DefaultResourceLoader(buildSdkResourceLoaderOptions({
      cwd: root,
      agentDir: join(root, "agent"),
      settingsManager: SettingsManager.inMemory({
        packages: [fileURLToPath(new URL("..", import.meta.url))],
      }),
    }));
    await loader.reload();
    assert.equal(loader.getSkills().skills.some((skill) => skill.name === "task"), false);
    assert.deepEqual(loader.getExtensions().extensions, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi loads the extension skill exactly once and reload restores it", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-skill-"));
  try {
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: join(root, "agent"),
      settingsManager: SettingsManager.inMemory(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
    });
    await loader.reload();
    assert.deepEqual(loader.getSkills().skills, []);
    const paths = registerExtension().get("resources_discover")?.()?.skillPaths;
    assert.ok(paths);
    const resources = { skillPaths: paths.map((path) => ({
      path,
      metadata: { source: "extension:pi-task", scope: "temporary" as const, origin: "top-level" as const },
    })) };
    loader.extendResources(resources);
    loader.extendResources(resources);
    assert.deepEqual(loader.getSkills().skills.map((skill) => skill.name), ["task"]);
    assert.deepEqual(loader.getSkills().diagnostics, []);
    await loader.reload();
    loader.extendResources(resources);
    assert.deepEqual(loader.getSkills().skills.map((skill) => skill.name), ["task"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
