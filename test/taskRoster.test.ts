import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { rosterLoadoutChange } from "../src/tool/task-roster.js";

const roots: string[] = [];

function makeProject(agents: Record<string, string>): string {
  const cwd = mkdtempSync(join(tmpdir(), "pi-task-roster-"));
  roots.push(cwd);
  const agentsDir = join(cwd, ".pi", "agents");
  mkdirSync(agentsDir, { recursive: true });
  for (const [name, description] of Object.entries(agents)) {
    writeFileSync(join(agentsDir, `${name}.md`), `---\ndescription: ${description}\n---\n`);
  }
  return cwd;
}

const TASK_ONLY = { declared: [{ name: "task" }] };

function descriptionFor(cwd: string): string {
  return rosterLoadoutChange(TASK_ONLY, cwd, undefined)?.descriptions?.task ?? "";
}

process.on("exit", () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("the roster lists the agents that exist in the session cwd", () => {
  const cwd = makeProject({ alpha: "Alpha does the first thing." });
  assert.match(descriptionFor(cwd), /alpha: Alpha does the first thing\./);
});

test("an agent added after the last render still shows up", () => {
  // The regression: the description was built once at registration, so a role
  // file added mid-session never reached the model.
  const cwd = makeProject({ alpha: "Alpha." });
  assert.doesNotMatch(descriptionFor(cwd), /beta/);

  writeFileSync(join(cwd, ".pi", "agents", "beta.md"), "---\ndescription: Beta reviews things.\n---\n");

  assert.match(descriptionFor(cwd), /beta: Beta reviews things\./);
});

test("editing and removing a role file both reach the description", () => {
  const cwd = makeProject({ alpha: "Old words.", beta: "Beta." });
  assert.match(descriptionFor(cwd), /Old words\./);

  writeFileSync(join(cwd, ".pi", "agents", "alpha.md"), "---\ndescription: New words.\n---\n");
  assert.match(descriptionFor(cwd), /New words\./);

  rmSync(join(cwd, ".pi", "agents", "beta.md"));
  assert.doesNotMatch(descriptionFor(cwd), /beta/);
});

test("each cwd renders its own roster, not the launch directory's", () => {
  // The other regression: pi launched in a subdirectory kept that directory's
  // agents for the whole session.
  const first = makeProject({ alpha: "From the first project." });
  const second = makeProject({ beta: "From the second project." });

  const a = descriptionFor(first);
  const b = descriptionFor(second);

  assert.match(a, /From the first project\./);
  assert.doesNotMatch(a, /second project/);
  assert.match(b, /From the second project\./);
  assert.doesNotMatch(b, /first project/);
});

test("nothing is declared when the task tool is not offered", () => {
  const cwd = makeProject({ alpha: "Alpha." });
  assert.equal(rosterLoadoutChange({ declared: [{ name: "bash" }] }, cwd, undefined), undefined);
  assert.equal(rosterLoadoutChange({ declared: [] }, cwd, undefined), undefined);
});

test("a project with no agents still renders the base description", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-task-roster-empty-"));
  roots.push(cwd);
  assert.match(descriptionFor(cwd), /Delegate multistep work/);
});
