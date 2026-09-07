/**
 * Unit tests for Claude Code child argv construction (buildClaudeArgs).
 *
 * Run: npx tsx --test test/claudeArgs.test.ts
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import {
  buildChildArgs,
  buildClaudeArgs,
  buildPiArgv,
} from "../src/subagent/buildArgv.js";
import type { AgentConfig } from "../src/helpers.js";

function claudeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "claude-code",
    description: "Claude Code worker",
    runtime: "claude",
    permissionMode: "bypassPermissions",
    model: "sonnet",
    body: "# Claude Code",
    source: "bundled",
    ...overrides,
  };
}

test("buildClaudeArgs: model, permission mode, and session id are emitted", () => {
  const args = buildClaudeArgs({
    agent: claudeAgent(),
    sessionId: "00000000-0000-4000-8000-000000000001",
    promptContent: "Do the work.",
    deferTaskPrompt: true,
  });
  assert.deepEqual(args, [
    "--permission-mode",
    "bypassPermissions",
    "--model",
    "sonnet",
    "--session-id",
    "00000000-0000-4000-8000-000000000001",
  ]);
});

test("buildClaudeArgs: model omitted when unset, session id always present", () => {
  const args = buildClaudeArgs({
    agent: claudeAgent({ model: undefined, permissionMode: undefined }),
    sessionId: "sid",
    promptContent: "Do the work.",
  });
  assert.ok(!args.includes("--model"));
  assert.ok(!args.includes("--permission-mode"));
  assert.deepEqual(
    args.filter((arg) => arg === "--session-id").length,
    1,
    "exactly one --session-id flag",
  );
  assert.equal(args[args.length - 1], "Do the work.");
});

test("buildClaudeArgs: prompt positional only when deferTaskPrompt is false", () => {
  const args = buildClaudeArgs({
    agent: claudeAgent(),
    sessionId: "sid",
    promptContent: "the initial prompt",
    deferTaskPrompt: false,
  });
  assert.equal(args[args.length - 1], "the initial prompt");
  assert.ok(!args.includes("--session-id") || args.indexOf("sid") > -1);
});

test("buildClaudeArgs: permission mode passthrough accepts arbitrary values", () => {
  const args = buildClaudeArgs({
    agent: claudeAgent({ permissionMode: "acceptEdits" }),
    sessionId: "sid",
    promptContent: "p",
    deferTaskPrompt: true,
  });
  assert.deepEqual(args, ["--permission-mode", "acceptEdits", "--model", "sonnet", "--session-id", "sid"]);
});

test("buildChildArgs routes claude runtime to buildClaudeArgs", () => {
  const args = buildChildArgs(claudeAgent(), {
    sessionName: "task-x",
    sessionDir: "/repo/.pi/artifacts/tasks/sessions/x",
    promptContent: "Do the work.",
    sessionId: "sid-1",
    deferTaskPrompt: true,
  });
  assert.deepEqual(args, [
    "--permission-mode",
    "bypassPermissions",
    "--model",
    "sonnet",
    "--session-id",
    "sid-1",
  ]);
});

test("buildChildArgs routes pi runtime to the pi argv (unchanged shape)", () => {
  const piAgent: AgentConfig = {
    name: "general",
    description: "General worker",
    model: "gpt-5",
    body: "body",
    source: "user",
  };
  const args = buildChildArgs(piAgent, {
    sessionName: "task-x",
    sessionDir: "/repo/sessions",
    promptContent: "Do the work.",
    sessionId: "ignored-for-pi",
    deferTaskPrompt: false,
  });
  const expected = buildPiArgv({
    agent: piAgent,
    sessionName: "task-x",
    sessionDir: "/repo/sessions",
    promptContent: "Do the work.",
  });
  assert.deepEqual(args, expected);
  assert.ok(args.includes("--session-dir"));
});
