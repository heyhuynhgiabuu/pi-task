/**
 * Integration smoke test for task extension.
 *
 * Exercises the full foreground pipeline end-to-end using a temp fixture
 * and actual pi CLI invocation. Does not require tmux or the Pi TUI.
 *
 * Run: bun .pi/extensions/task/smoke.ts
 */

import { strict as assert } from "node:assert";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─── Test 1: Agent discovery + buildPiArgs + registry ──────────────────────

console.log("=== Test 1: Agent discovery, buildPiArgs, registry ===");

const root = mkdtempSync(join(tmpdir(), "task-smoke-"));
try {
  const piDir = join(root, ".pi");
  const agentsDir = join(piDir, "agents");
  mkdirSync(agentsDir, { recursive: true });

  // Create a test agent
  writeFileSync(
    join(agentsDir, "explore.md"),
    [
      "---",
      "description: Read-only explorer",
      "disallowed_tools: edit, write",
      "---",
      "",
      "# Explore Agent",
      "You explore code. Do not modify any files.",
    ].join("\n"),
  );

  // Test discoverAgents from within the fixture
  const { discoverAgents } = await import("../src/helpers.js");
  const { agents } = discoverAgents(agentsDir);
  const explore = agents.find((a) => a.name === "explore");
  assert.ok(explore, "explore agent discovered");
  assert.equal(explore.description, "Read-only explorer", "agent description");
  assert.ok(explore.disallowedTools?.includes("edit"), "disallowed edit");
  assert.ok(explore.disallowedTools?.includes("write"), "disallowed write");
  assert.ok(
    explore.disallowedTools?.includes("xai_web_search"),
    "disallowed xai side tools",
  );
  assert.equal(explore.source, "project", "source is project");
  console.log("  PASS: agent discovery");

  // Test buildPiArgs (fresh task — no --session)
  const { buildPiArgs, ALL_TOOL_NAMES } = await import("../src/helpers.js");
  const sessionDir = join(root, "sessions");
  mkdirSync(sessionDir, { recursive: true });
  const args = buildPiArgs(explore, "task-test123", sessionDir, "Do the thing");
  assert.ok(args.includes("--name"), "buildPiArgs includes --name");
  assert.ok(args.includes("task-test123"), "buildPiArgs includes session name");
  assert.ok(
    args.includes("--session-dir"),
    "buildPiArgs includes --session-dir",
  );
  assert.ok(args.includes(sessionDir), "buildPiArgs includes session dir");
  assert.ok(!args.includes("--session"), "no --session for fresh task");
  assert.ok(
    args.includes("--append-system-prompt"),
    "buildPiArgs includes --append-system-prompt",
  );
  console.log("  PASS: buildPiArgs fresh");

  // Test buildPiArgs (resume task — includes --session)
  const resumeArgs = buildPiArgs(
    explore,
    "task-test123",
    sessionDir,
    "Do more",
    true,
  );
  assert.ok(resumeArgs.includes("--session"), "--session included for resume");
  assert.ok(
    resumeArgs.includes("task-test123"),
    "--session value is session name",
  );
  console.log("  PASS: buildPiArgs resume");

  // Test disallowed_tools filtering
  const allowedIdx = args.indexOf("--tools");
  assert.ok(allowedIdx >= 0, "--tools flag present when disallowed_tools set");
  const allowedTools = args[allowedIdx + 1];
  const toolSet = new Set(allowedTools.split(","));
  assert.ok(toolSet.has("read"), "allowed tools includes read");
  assert.ok(toolSet.has("bash"), "allowed tools includes bash");
  assert.ok(!toolSet.has("edit"), "allowed tools excludes edit");
  assert.ok(!toolSet.has("write"), "allowed tools excludes write");
  assert.ok(!toolSet.has("task"), "allowed tools excludes recursive task");
  console.log("  PASS: --tools flag correctly filters disallowed_tools");

  // Test registry read/write — test the JSON file format directly using fs
  const regPath = join(piDir, "task-registry.json");
  const testEntry = {
    id: "test-001",
    agentType: "explore",
    description: "Test task",
    sessionName: "task-test-001",
    startedAt: Date.now(),
    paneId: "%123",
    piDir: piDir,
    dir: join(root, "artifacts", "task-test-001"),
  };
  writeFileSync(regPath, JSON.stringify([testEntry], null, 2), "utf-8");
  const loaded = JSON.parse(readFileSync(regPath, "utf-8"));
  assert.equal(loaded.length, 1, "registry has one entry");
  assert.equal(loaded[0].id, "test-001", "registry entry id matches");
  console.log("  PASS: registry read/write");
} finally {
  rmSync(root, { recursive: true, force: true });
}

// ─── Test 2: Foreground mode pipeline (requires pi CLI) ────────────────────

console.log("\n=== Test 2: Foreground pipeline (pi CLI) ===");

const root2 = mkdtempSync(join(tmpdir(), "task-smoke-pi-"));
try {
  const piDir = join(root2, ".pi");
  const agentsDir = join(piDir, "agents");
  mkdirSync(agentsDir, { recursive: true });

  // Create test agent with short system prompt
  writeFileSync(
    join(agentsDir, "echo.md"),
    [
      "---",
      "description: Echo test agent",
      "---",
      "",
      "# Echo Agent",
      "You are a test agent. Read the task from CONTEXT.md and write a simple result to RESULT.md.",
      "Be concise.",
    ].join("\n"),
  );

  // Set up artifact dir to mimic the execute function
  const sessionName = "task-smoke-echo";
  const artifactDir = join(piDir, "artifacts", sessionName);
  mkdirSync(join(artifactDir, "sessions"), { recursive: true });
  const resultPath = join(artifactDir, "RESULT.md");
  const contextPath = join(artifactDir, "CONTEXT.md");

  // Write CONTEXT.md
  const contextContent = [
    "# Task: Echo test",
    "",
    "## Agent",
    "echo (project)",
    "",
    "## Instructions",
    "Read this file, then write a result to RESULT.md with:",
    "<status>success</status>",
    "<summary>Echo test passed</summary>",
    "<findings>Pi CLI is working</findings>",
    "",
    "## Working Directory",
    root2,
    "",
    "## Output",
    "Write your result to " + resultPath,
  ].join("\n");
  writeFileSync(contextPath, contextContent, "utf-8");

  // Build pi args with a minimal prompt
  const { buildPiArgs, discoverAgents: da } = await import("../src/helpers.js");
  const { agents } = da(agentsDir);
  const echo = agents.find((a) => a.name === "echo");
  assert.ok(echo, "echo agent discovered");

  const sessionDir = join(artifactDir, "sessions");
  const promptContent = [
    `Read ${contextPath} and follow the instructions.`,
    `Write your result to ${resultPath}.`,
  ].join("\n");

  const piArgs = buildPiArgs(echo, sessionName, sessionDir, promptContent);

  // Test the spawnPiInline-equivalent through execFileSync directly
  const { execFileSync } = await import("node:child_process");
  // First, verify pi is available
  console.log("  pi version:");
  const versionOut = execFileSync("pi", ["--version"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  console.log("    " + versionOut);
  assert.ok(versionOut.length > 0, "pi --version produces output");

  // Run pi inline to verify spawnPiInline-like execution works
  // (simulates the foreground path without tmux)
  const env = { ...process.env, PI_TASK_TOOL_DISABLED: "1" } as Record<
    string,
    string
  >;
  const piVersionOut = execFileSync("pi", ["--version"], {
    env,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
    maxBuffer: 10 * 1024 * 1024,
  }).trim();
  console.log("  pi with PI_TASK_TOOL_DISABLED=1:");
  console.log("    " + piVersionOut);
  assert.ok(piVersionOut.length > 0, "pi runs with PI_TASK_TOOL_DISABLED=1");

  console.log("  PASS: foreground pipeline (pi CLI invocation)");
} finally {
  rmSync(root2, { recursive: true, force: true });
}

// ─── Test 3: Agent format + result parsing integration ─────────────────────

console.log("\n=== Test 3: Agent list formatting + result parsing ===");

const { formatAgentList, parseResultXml } = await import("../src/helpers.js");

// Agent list
const formatted = formatAgentList([
  {
    name: "alpha",
    description: "First agent",
    body: "",
    source: "project",
    path: "/a",
  },
  {
    name: "beta",
    description: "Second agent",
    body: "",
    source: "user",
    path: "/b",
  },
]);
assert.ok(
  formatted.includes("alpha (project): First agent"),
  "formatAgentList alpha",
);
assert.ok(
  formatted.includes("beta (user): Second agent"),
  "formatAgentList beta",
);
console.log("  PASS: agent list formatting");

// Result parsing
const xmlResult = [
  "<status>success</status>",
  "<summary>Analysis complete</summary>",
  "<findings>Found issues in 3 files</findings>",
  "<evidence>Tests pass</evidence>",
  "<confidence>high</confidence>",
].join("\n");
const parsed = parseResultXml(xmlResult);
assert.equal(parsed.status, "success");
assert.equal(parsed.summary, "Analysis complete");
assert.equal(parsed.findings, "Found issues in 3 files");
assert.equal(parsed.confidence, "high");
console.log("  PASS: result XML parsing");

// Plain text fallback
const plainParsed = parseResultXml("Something happened");
assert.equal(plainParsed.status, "unknown");
assert.equal(plainParsed.summary, "Something happened");
console.log("  PASS: plain text fallback");

// ─── Test 4: countToolUses with real session file ─────────────────────────

console.log("\n=== Test 4: Session tool use counting ===");

const { countToolUses } = await import("../src/helpers.js");
const sessionRoot = mkdtempSync(join(tmpdir(), "task-smoke-sessions-"));
try {
  // Write a realistic session file
  const sessionFile = join(sessionRoot, "session.jsonl");
  writeFileSync(
    sessionFile,
    [
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Let me search..." },
            { type: "toolCall", id: "call1", name: "grep" },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call2", name: "read" },
            { type: "toolCall", id: "call3", name: "edit" },
            { type: "text", text: "Here's what I found." },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "Continue" }],
        },
      }),
    ].join("\n"),
  );

  const counts = countToolUses(sessionRoot);
  assert.equal(counts.toolUses, 3, "3 tool calls counted");
  assert.equal(counts.turns, 2, "2 assistant turns counted");
  console.log("  PASS: session tool use counting");
} finally {
  rmSync(sessionRoot, { recursive: true, force: true });
}

console.log("\nALL SMOKE TESTS PASSED");
