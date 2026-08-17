import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentsFromDir, parseBool, resolveTaskFastMode } from "../src/helpers.js";

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

console.log("frontmatter.test.ts: all passed");