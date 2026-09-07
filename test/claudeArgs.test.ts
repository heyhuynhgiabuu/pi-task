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

test("buildClaudeArgs maps thinking to --effort", () => {
  const base = { sessionId: "s-1", promptContent: "p", deferTaskPrompt: true } as const;
  const agent = (thinking?: string) => ({ name: "a", description: "d", body: "", source: "bundled" as const, path: "", thinking }) as Parameters<typeof buildClaudeArgs>[0]["agent"];
  assert.deepEqual(buildClaudeArgs({ agent: agent("max"), ...base }), ["--model-x"].slice(0,0).concat(["--effort", "max", "--session-id", "s-1"]));
  assert.deepEqual(buildClaudeArgs({ agent: agent("high"), ...base }), ["--effort", "high", "--session-id", "s-1"]);
  assert.deepEqual(buildClaudeArgs({ agent: agent("off"), ...base }), ["--effort", "low", "--session-id", "s-1"]);
  assert.deepEqual(buildClaudeArgs({ agent: agent(undefined), ...base }), ["--session-id", "s-1"]);
  assert.deepEqual(buildClaudeArgs({ agent: agent("bogus"), ...base }), ["--session-id", "s-1"]);
});

// ── Tool policy enforcement ─────────────────────────────────────────────────

function indexOfValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

test("buildClaudeArgs: unrestricted claude agent keeps the default tool surface", () => {
  const args = buildClaudeArgs({
    agent: claudeAgent(),
    sessionId: "sid",
    promptContent: "p",
    deferTaskPrompt: true,
  });
  assert.ok(!args.includes("--tools"), "no --tools allowlist by default");
  assert.ok(!args.includes("--disallowedTools"), "no deny list by default");
});

test("buildClaudeArgs: readonly agent never gets Bash/Write/Edit/NotebookEdit despite bypassPermissions", () => {
  const args = buildClaudeArgs({
    agent: claudeAgent({ readonly: true }),
    sessionId: "sid",
    promptContent: "p",
    deferTaskPrompt: true,
  });
  const tools = indexOfValue(args, "--tools") ?? "";
  for (const mutating of ["Bash", "Write", "Edit", "NotebookEdit"]) {
    assert.ok(!tools.includes(mutating), `readonly surface excludes ${mutating}: ${tools}`);
  }
  for (const readonlyTool of ["Read", "Grep", "Glob"]) {
    assert.ok(tools.includes(readonlyTool), `readonly surface includes ${readonlyTool}: ${tools}`);
  }
  assert.ok(tools.includes("WebSearch") && tools.includes("WebFetch"), `read-only web tools exposed: ${tools}`);
});

test("buildClaudeArgs: explicit tools map pi names to Claude names preserving order", () => {
  const args = buildClaudeArgs({
    agent: claudeAgent({ tools: ["read", "bash", "grep", "read"] }),
    sessionId: "sid",
    promptContent: "p",
    deferTaskPrompt: true,
  });
  assert.equal(indexOfValue(args, "--tools"), "Read,Bash,Grep");
});

test("buildClaudeArgs: explicit disallowed_tools map onto --disallowedTools", () => {
  const args = buildClaudeArgs({
    agent: claudeAgent({ disallowedTools: ["bash", "write"] }),
    sessionId: "sid",
    promptContent: "p",
    deferTaskPrompt: true,
  });
  assert.equal(indexOfValue(args, "--disallowedTools"), "Bash,Write");
  assert.ok(!args.includes("--tools"), "no allowlist for deny-only policy");
});

test("buildClaudeArgs: unsupported explicit tools reject with an actionable error", () => {
  assert.throws(
    () =>
      buildClaudeArgs({
        agent: claudeAgent({ tools: ["read", "context7"] }),
        sessionId: "sid",
        promptContent: "p",
        deferTaskPrompt: true,
      }),
    /cannot be mapped to Claude Code built-in tools[\s\S]*"context7"/,
  );
});

test("buildClaudeArgs: unsupported explicit disallowed_tools reject", () => {
  assert.throws(
    () =>
      buildClaudeArgs({
        agent: claudeAgent({ disallowedTools: ["memory-search"] }),
        sessionId: "sid",
        promptContent: "p",
        deferTaskPrompt: true,
      }),
    /cannot be mapped to Claude Code built-in tools[\s\S]*"memory-search"/,
  );
});

test("buildClaudeArgs: readonly agent requesting a mutating tool rejects", () => {
  assert.throws(
    () =>
      buildClaudeArgs({
        agent: claudeAgent({ readonly: true, tools: ["read", "bash"] }),
        sessionId: "sid",
        promptContent: "p",
        deferTaskPrompt: true,
      }),
    /readonly: true but tools: requests the mutating Claude Code tool "Bash"/,
  );
});
