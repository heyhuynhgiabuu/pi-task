/**
 * Unit tests for task extension pure helpers.
 *
 * Run: npx tsx .pi/extensions/task/helpers.test.ts
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseResultXml,
  extractTag,
  formatMs,
  parseIdTimestamp,
  shellQuote,
  formatBackgroundReceipt,
  TASK_BACKGROUND_DEFAULT,
  TASK_RESULT_XML_INSTRUCTIONS,
  TASK_TOOL_DESCRIPTION,
  countToolUses,
  readRecentToolCalls,
  summarizeArgs,
  findPiDir,
  loadAgentsFromDir,
  discoverAgents,
  formatAgentList,
  type AgentConfig,
} from "../src/helpers.js";
import {
  getLastAssistantTextFromSessionDir,
  getSessionTerminalState,
} from "../src/session-text.js";
import { checkTaskCompletion, resolveSessionDir } from "../src/subagent/waitCompletion.js";

// ─── extractTag ──────────────────────────────────────────────────────────────

{
  const t = "extractTag returns content between tags";
  const re = /<foo>([\s\S]*?)<\/foo>/i;
  assert.equal(extractTag("<foo>bar</foo>", re), "bar", t);
}

{
  const t = "extractTag trims whitespace";
  const re = /<foo>([\s\S]*?)<\/foo>/i;
  assert.equal(extractTag("<foo>  bar  </foo>", re), "bar", t);
}

{
  const t = "extractTag returns empty string when no match";
  const re = /<foo>([\s\S]*?)<\/foo>/i;
  assert.equal(extractTag("<baz>bar</baz>", re), "", t);
}

{
  const t = "extractTag handles multiline content";
  const re = /<foo>([\s\S]*?)<\/foo>/i;
  assert.equal(extractTag("<foo>line1\nline2</foo>", re), "line1\nline2", t);
}

// ─── parseResultXml ──────────────────────────────────────────────────────────

{
  const t = "parseResultXml parses all XML fields";
  const raw = [
    "<status>success</status>",
    "<summary>Did the thing</summary>",
    "<findings>Found a bug at src/foo.ts:42</findings>",
    "<evidence>Tests pass</evidence>",
    "<confidence>high</confidence>",
  ].join("\n");
  const r = parseResultXml(raw);
  assert.equal(r.status, "success", t + " status");
  assert.equal(r.summary, "Did the thing", t + " summary");
  assert.equal(r.findings, "Found a bug at src/foo.ts:42", t + " findings");
  assert.equal(r.evidence, "Tests pass", t + " evidence");
  assert.equal(r.confidence, "high", t + " confidence");
}

{
  const t = "parseResultXml returns unknown status when no XML tags present";
  const r = parseResultXml("just plain text");
  assert.equal(r.status, "unknown", t + " status");
  assert.equal(r.summary, "just plain text", t + " summary");
  assert.equal(r.findings, "", t + " findings");
  assert.equal(r.raw, "just plain text", t + " raw");
}

{
  const t = "parseResultXml truncates summary to 500 chars for plain text";
  const longText = "x".repeat(600);
  const r = parseResultXml(longText);
  assert.equal(r.summary.length, 500, t);
}

{
  const t = "parseResultXml handles partial XML (status only)";
  const r = parseResultXml("<status>failure</status>\nSomething broke");
  assert.equal(r.status, "failure", t + " status");
  assert.equal(r.summary, "", t + " summary");
}

{
  const t = "parseResultXml handles case-insensitive tags";
  const r = parseResultXml("<STATUS>partial</STATUS>\n<SUMMARY>ok</SUMMARY>");
  assert.equal(r.status, "partial", t + " status");
  assert.equal(r.summary, "ok", t + " summary");
}

// ─── formatMs ────────────────────────────────────────────────────────────────

{
  const t = "formatMs returns ms for sub-second";
  assert.equal(formatMs(500), "500ms", t);
}

{
  const t = "formatMs returns seconds for 1-59s";
  assert.equal(formatMs(1500), "1.5s", t);
}

{
  const t = "formatMs returns minutes for 60s+";
  assert.equal(formatMs(90_000), "1m 30s", t);
}

{
  const t = "formatMs handles exact minute";
  assert.equal(formatMs(120_000), "2m 0s", t);
}

{
  const t = "formatMs handles zero";
  assert.equal(formatMs(0), "0ms", t);
}

// ─── parseIdTimestamp ────────────────────────────────────────────────────────

{
  const t = "parseIdTimestamp extracts base36 timestamp from id";
  const ts = Date.now();
  const id = `${ts.toString(36)}-abcd`;
  assert.equal(parseIdTimestamp(id), ts, t);
}

{
  const t =
    "parseIdTimestamp falls back to Date.now() when split yields empty string";
  const before = Date.now();
  const result = parseIdTimestamp("-");
  const after = Date.now();
  assert.ok(result >= before && result <= after, t);
}

{
  const t = "parseIdTimestamp handles empty string";
  const before = Date.now();
  const result = parseIdTimestamp("");
  const after = Date.now();
  assert.ok(result >= before && result <= after, t);
}

// ─── shellQuote ──────────────────────────────────────────────────────────────

{
  const t = "shellQuote wraps in single quotes";
  assert.equal(shellQuote("hello"), "'hello'", t);
}

{
  const t = "shellQuote escapes single quotes";
  assert.equal(shellQuote("it's"), "'it'\"'\"'s'", t);
}

{
  const t = "shellQuote handles empty string";
  assert.equal(shellQuote(""), "''", t);
}

{
  const t = "shellQuote preserves double quotes inside";
  assert.equal(shellQuote('say "hi"'), "'say \"hi\"'", t);
}

// ─── countToolUses ───────────────────────────────────────────────────────────

{
  const t = "countToolUses returns zeros for nonexistent dir";
  const r = countToolUses("/nonexistent/path");
  assert.equal(r.toolUses, 0, t + " toolUses");
  assert.equal(r.turns, 0, t + " turns");
}

{
  const t = "countToolUses counts tool calls from JSONL";
  const dir = mkdtempSync(join(tmpdir(), "task-test-count-"));
  try {
    const jsonl = [
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall" },
            { type: "toolCall" },
            { type: "text", text: "ok" },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall" }],
        },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "hello" },
      }),
      "not json",
      "",
    ].join("\n");
    writeFileSync(join(dir, "session.jsonl"), jsonl);

    const r = countToolUses(dir);
    assert.equal(r.toolUses, 3, t + " toolUses");
    assert.equal(r.turns, 2, t + " turns");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const t = "countToolUses handles multiple JSONL files";
  const dir = mkdtempSync(join(tmpdir(), "task-test-count-multi-"));
  try {
    writeFileSync(
      join(dir, "a.jsonl"),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "toolCall" }] },
      }),
    );
    writeFileSync(
      join(dir, "b.jsonl"),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall" }, { type: "toolCall" }],
        },
      }),
    );

    const r = countToolUses(dir);
    assert.equal(r.toolUses, 3, t + " toolUses");
    assert.equal(r.turns, 2, t + " turns");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── summarizeArgs ──────────────────────────────────────────────────────────

{
  const t = "summarizeArgs returns path for read/write/edit";
  assert.equal(
    summarizeArgs("read", { path: "/tmp/foo.ts" }),
    "/tmp/foo.ts",
    t,
  );
  assert.equal(
    summarizeArgs("write", { file_path: "/x.ts" }),
    "/x.ts",
    t + " file_path",
  );
  assert.equal(summarizeArgs("edit", { path: "/a/b/c" }), "/a/b/c", t);
}

{
  const t = "summarizeArgs returns command for bash";
  assert.equal(summarizeArgs("bash", { command: "npm test" }), "npm test", t);
  assert.equal(summarizeArgs("bash", { cmd: "ls -la" }), "ls -la", t + " cmd");
}

{
  const t = "summarizeArgs returns query for search tools";
  assert.equal(
    summarizeArgs("websearch", { query: "MCP spec 2026" }),
    "MCP spec 2026",
    t,
  );
  assert.equal(
    summarizeArgs("codesearch", { query: "MCP" }),
    "MCP",
    t + " codesearch",
  );
}

{
  const t = "summarizeArgs returns url for fetch tools";
  assert.equal(
    summarizeArgs("web_fetch", { url: "https://example.com" }),
    "https://example.com",
    t,
  );
  assert.equal(
    summarizeArgs("webclaw_scrape", { url: "https://x.com" }),
    "https://x.com",
    t + " webclaw",
  );
}

{
  const t = "summarizeArgs returns count for batch tools";
  assert.equal(
    summarizeArgs("webclaw_batch", { urls: ["a", "b", "c"] }),
    "3 urls",
    t,
  );
}

{
  const t = "summarizeArgs falls back to first string for unknown tool";
  assert.equal(summarizeArgs("custom_tool", { foo: "bar", n: 42 }), "bar", t);
}

{
  const t = "summarizeArgs returns empty for non-object args";
  assert.equal(summarizeArgs("read", null), "", t);
  assert.equal(summarizeArgs("read", undefined), "", t + " undefined");
  assert.equal(summarizeArgs("read", "string"), "", t + " string");
}

{
  const t = "summarizeArgs returns empty when no string args present";
  assert.equal(summarizeArgs("read", { n: 1, b: true }), "", t);
}

// ─── readRecentToolCalls ─────────────────────────────────────────────────────

{
  const t = "readRecentToolCalls returns zeros and empty for nonexistent dir";
  const r = readRecentToolCalls("/nonexistent/path");
  assert.equal(r.toolUses, 0, t + " toolUses");
  assert.equal(r.turns, 0, t + " turns");
  assert.deepEqual(r.recent, [], t + " recent");
}

{
  const t = "readRecentToolCalls marks calls without toolResult as in_progress";
  const dir = mkdtempSync(join(tmpdir(), "task-test-recent-"));
  try {
    const jsonl = [
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "c1",
              name: "websearch",
              arguments: { query: "MCP" },
            },
          ],
        },
      }),
    ].join("\n");
    writeFileSync(join(dir, "session.jsonl"), jsonl);

    const r = readRecentToolCalls(dir);
    assert.equal(r.toolUses, 1, t + " toolUses");
    assert.equal(r.turns, 1, t + " turns");
    assert.equal(r.recent.length, 1, t + " recent length");
    assert.equal(r.recent[0].name, "websearch", t + " name");
    assert.equal(r.recent[0].detail, "MCP", t + " detail");
    assert.equal(r.recent[0].status, "in_progress", t + " status");
    assert.equal(r.recent[0].id, "c1", t + " id");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const t = "readRecentToolCalls matches toolResult and marks done";
  const dir = mkdtempSync(join(tmpdir(), "task-test-recent-done-"));
  try {
    const jsonl = [
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "c1",
              name: "read",
              arguments: { path: "/foo.ts" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "toolResult", toolCallId: "c1", isError: false },
      }),
    ].join("\n");
    writeFileSync(join(dir, "session.jsonl"), jsonl);

    const r = readRecentToolCalls(dir);
    assert.equal(r.recent.length, 1, t + " recent length");
    assert.equal(r.recent[0].status, "done", t + " status");
    assert.equal(r.recent[0].detail, "/foo.ts", t + " detail");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const t = "readRecentToolCalls marks isError results as error";
  const dir = mkdtempSync(join(tmpdir(), "task-test-recent-err-"));
  try {
    const jsonl = [
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "c1",
              name: "bash",
              arguments: { command: "false" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "toolResult", toolCallId: "c1", isError: true },
      }),
    ].join("\n");
    writeFileSync(join(dir, "session.jsonl"), jsonl);

    const r = readRecentToolCalls(dir);
    assert.equal(r.recent[0].status, "error", t + " status");
    assert.equal(r.recent[0].detail, "false", t + " detail");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const t = "readRecentToolCalls respects limit and returns most recent calls";
  const dir = mkdtempSync(join(tmpdir(), "task-test-recent-limit-"));
  try {
    const blocks: string[] = [];
    for (let i = 0; i < 20; i++) {
      blocks.push(
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: `c${i}`,
                name: "bash",
                arguments: { command: `echo ${i}` },
              },
            ],
          },
        }),
      );
      blocks.push(
        JSON.stringify({
          type: "message",
          message: { role: "toolResult", toolCallId: `c${i}`, isError: false },
        }),
      );
    }
    writeFileSync(join(dir, "session.jsonl"), blocks.join("\n"));

    const r = readRecentToolCalls(dir, 5);
    assert.equal(r.toolUses, 20, t + " total toolUses");
    assert.equal(r.recent.length, 5, t + " recent length");
    // Last 5 should be c15..c19
    assert.equal(r.recent[0].detail, "echo 15", t + " first recent");
    assert.equal(r.recent[4].detail, "echo 19", t + " last recent");
    assert.equal(r.recent[0].status, "done", t + " status");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const t = "readRecentToolCalls walks multiple JSONL files";
  const dir = mkdtempSync(join(tmpdir(), "task-test-recent-multi-"));
  try {
    writeFileSync(
      join(dir, "a.jsonl"),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "c1",
              name: "read",
              arguments: { path: "/a" },
            },
          ],
        },
      }),
    );
    writeFileSync(
      join(dir, "b.jsonl"),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "c2",
              name: "read",
              arguments: { path: "/b" },
            },
          ],
        },
      }) +
        "\n" +
        JSON.stringify({
          type: "message",
          message: { role: "toolResult", toolCallId: "c2", isError: false },
        }),
    );

    const r = readRecentToolCalls(dir);
    assert.equal(r.toolUses, 2, t + " total toolUses");
    assert.equal(r.recent.length, 2, t + " recent length");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const t = "readRecentToolCalls skips toolCalls without id";
  const dir = mkdtempSync(join(tmpdir(), "task-test-recent-noid-"));
  try {
    const jsonl = [
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall" }, // no id
            {
              type: "toolCall",
              id: "c1",
              name: "read",
              arguments: { path: "/x" },
            },
          ],
        },
      }),
    ].join("\n");
    writeFileSync(join(dir, "session.jsonl"), jsonl);

    const r = readRecentToolCalls(dir);
    // toolUses counts both (per existing countToolUses contract), but recent only includes id'd ones
    assert.equal(r.toolUses, 2, t + " toolUses counts both");
    assert.equal(r.recent.length, 1, t + " recent only id'd");
    assert.equal(r.recent[0].id, "c1", t + " id");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const t = "readRecentToolCalls tolerates malformed lines";
  const dir = mkdtempSync(join(tmpdir(), "task-test-recent-bad-"));
  try {
    const jsonl = [
      "not json",
      "",
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "c1",
              name: "read",
              arguments: { path: "/x" },
            },
          ],
        },
      }),
      "{this is also broken",
    ].join("\n");
    writeFileSync(join(dir, "session.jsonl"), jsonl);

    const r = readRecentToolCalls(dir);
    assert.equal(r.toolUses, 1, t + " toolUses");
    assert.equal(r.recent.length, 1, t + " recent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── findPiDir ───────────────────────────────────────────────────────────────

{
  const t = "findPiDir finds .pi in parent directory";
  const root = mkdtempSync(join(tmpdir(), "task-test-findpi-"));
  try {
    const piDir = join(root, ".pi");
    mkdirSync(piDir);
    const nested = join(root, "a", "b", "c");
    mkdirSync(nested, { recursive: true });

    assert.equal(findPiDir(nested), piDir, t);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const t = "findPiDir returns null when no .pi exists";
  const root = mkdtempSync(join(tmpdir(), "task-test-findpi-null-"));
  try {
    assert.equal(findPiDir(join(root, "a", "b")), null, t);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const t = "findPiDir handles cwd inside .pi directory itself";
  const root = mkdtempSync(join(tmpdir(), "task-test-findpi-inside-"));
  try {
    const piDir = join(root, ".pi");
    mkdirSync(piDir);
    // cwd is the .pi dir itself — should find .pi in parent
    assert.equal(findPiDir(piDir), piDir, t);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ─── loadAgentsFromDir ───────────────────────────────────────────────────────

{
  const t = "loadAgentsFromDir returns empty for nonexistent dir";
  const r = loadAgentsFromDir("/nonexistent/path", "project");
  assert.equal(r.length, 0, t);
}

{
  const t = "loadAgentsFromDir parses agent markdown files";
  const dir = mkdtempSync(join(tmpdir(), "task-test-agents-"));
  try {
    writeFileSync(
      join(dir, "explore.md"),
      [
        "---",
        "description: Read-only codebase explorer",
        "model: gpt-4o",
        "tools: read, grep",
        "disallowed_tools: edit, write",
        "---",
        "",
        "# Explore Agent",
        "You explore code.",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "worker.md"),
      [
        "---",
        "description: Fast implementer",
        "thinking: high",
        "---",
        "",
        "# Worker Agent",
        "You implement code.",
      ].join("\n"),
    );

    const agents = loadAgentsFromDir(dir, "user");
    assert.equal(agents.length, 2, t + " count");

    const explore = agents.find((a) => a.name === "explore");
    assert.ok(explore, t + " explore exists");
    assert.equal(
      explore!.description,
      "Read-only codebase explorer",
      t + " description",
    );
    assert.equal(explore!.model, "gpt-4o", t + " model");
    assert.ok(
      explore!.disallowedTools?.includes("edit"),
      t + " disallowed edit",
    );
    assert.deepEqual(explore!.tools, ["read", "grep"], t + " tools");
    assert.ok(
      explore!.disallowedTools?.includes("write"),
      t + " disallowed write",
    );
    assert.ok(
      explore!.disallowedTools?.includes("xai_web_search"),
      t + " disallowed xai",
    );
    assert.equal(explore!.source, "user", t + " source");
    assert.match(explore!.body, /# Explore Agent/, t + " body");

    const worker = agents.find((a) => a.name === "worker");
    assert.ok(worker, t + " worker exists");
    assert.equal(worker!.thinking, "high", t + " thinking");
    assert.ok(
      worker!.disallowedTools?.includes("xai_generate_text"),
      t + " default xai disallow",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const t = "loadAgentsFromDir skips files without description";
  const dir = mkdtempSync(join(tmpdir(), "task-test-agents-nodesc-"));
  try {
    writeFileSync(
      join(dir, "no-desc.md"),
      ["---", "model: gpt-4o", "---", "Body without description."].join("\n"),
    );
    writeFileSync(
      join(dir, "has-desc.md"),
      ["---", "description: Has one", "---", "Body."].join("\n"),
    );

    const agents = loadAgentsFromDir(dir, "project");
    assert.equal(agents.length, 1, t + " count");
    assert.equal(agents[0].name, "has-desc", t + " name");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const t = "loadAgentsFromDir skips non-md files";
  const dir = mkdtempSync(join(tmpdir(), "task-test-agents-nonmd-"));
  try {
    writeFileSync(join(dir, "readme.txt"), "not an agent");
    writeFileSync(
      join(dir, "agent.md"),
      "---\ndescription: Real agent\n---\nBody.",
    );

    const agents = loadAgentsFromDir(dir, "project");
    assert.equal(agents.length, 1, t);
    assert.equal(agents[0].name, "agent", t + " name");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── formatAgentList ─────────────────────────────────────────────────────────

{
  const t = "formatAgentList returns 'none available' for empty";
  assert.equal(formatAgentList([]), "none available", t);
}

{
  const t = "formatAgentList formats agent entries";
  const agents: AgentConfig[] = [
    {
      name: "explore",
      description: "Read-only explorer",
      body: "",
      source: "project",
      path: "/a",
    },
    {
      name: "worker",
      description: "Fast implementer",
      body: "",
      source: "user",
      path: "/b",
    },
  ];
  const r = formatAgentList(agents);
  assert.match(r, /explore \(project\): Read-only explorer/, t + " explore");
  assert.match(r, /worker \(user\): Fast implementer/, t + " worker");
}

// ─── Integration: discoverAgents with fixture ────────────────────────────────

{
  const t = "discoverAgents merges project and user agents, project overrides";
  const root = mkdtempSync(join(tmpdir(), "task-test-discover-"));
  try {
    const piDir = join(root, ".pi");
    const projDir = join(piDir, "agents");
    const userDir = join(root, "user-agents");
    mkdirSync(projDir, { recursive: true });
    mkdirSync(userDir, { recursive: true });

    // User agent
    writeFileSync(
      join(userDir, "explore.md"),
      "---\ndescription: User explore\n---\nUser body.",
    );
    // Same name in project — should override
    writeFileSync(
      join(projDir, "explore.md"),
      "---\ndescription: Project explore\n---\nProject body.",
    );
    // Only in user
    writeFileSync(
      join(userDir, "scout.md"),
      "---\ndescription: Scout agent\n---\nScout body.",
    );

    // Temporarily override HOME so getGlobalAgentDir picks up our fixture
    const origHome = process.env.HOME;
    process.env.HOME = root;
    // Move user agents to the expected global location
    const globalDir = join(root, ".pi", "agent", "agents");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(
      join(globalDir, "explore.md"),
      "---\ndescription: User explore\n---\nUser body.",
    );
    writeFileSync(
      join(globalDir, "scout.md"),
      "---\ndescription: Scout agent\n---\nScout body.",
    );

    try {
      const { agents } = discoverAgents(projDir); // cwd inside .pi
      const explore = agents.find((a) => a.name === "explore");
      assert.ok(explore, t + " explore exists");
      assert.equal(
        explore!.description,
        "Project explore",
        t + " project overrides user",
      );
      assert.equal(explore!.source, "project", t + " source is project");

      const scout = agents.find((a) => a.name === "scout");
      assert.ok(scout, t + " scout exists");
      assert.equal(scout!.source, "user", t + " scout from user");
    } finally {
      if (origHome !== undefined) process.env.HOME = origHome;
      else delete process.env.HOME;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ─── Task tool hardening contracts ───────────────────────────────────────────

{
  const t =
    "shellQuote preserves embedded single quotes and backticks verbatim";
  // The local splitWindowPane passes the whole shell line through split-window,
  // so the parent must quote agent paths/args with embedded ' and ` such that
  // the spawned shell sees the original characters as one literal argument.
  const command = "cd '/tmp/safe path' && echo $(must-not-run) && echo `nope`";
  assert.equal(
    shellQuote("/tmp/safe path"),
    "'/tmp/safe path'",
    `${t} (plain path)`,
  );
  assert.equal(
    shellQuote("it's tricky"),
    "'it'\"'\"'s tricky'",
    `${t} (escaped quote)`,
  );
  assert.equal(
    shellQuote(command),
    "'cd '\"'\"'/tmp/safe path'\"'\"' && echo $(must-not-run) && echo `nope`'",
    `${t} (full command)`,
  );
}

{
  const t = "formatBackgroundReceipt returns visible task launch details";
  const receipt = formatBackgroundReceipt({
    taskId: "task-123",
    agentType: "explore",
    tmuxSession: "pi-task-task-123",
    artifactDir: "/tmp/.pi/tasks/task-123",
  });
  assert.ok(receipt.includes("Started task task-123"), t + " includes task id");
  assert.ok(receipt.includes("explore"), t + " includes agent type");
  assert.ok(receipt.includes("pi-task-task-123"), t + " includes session");
  assert.ok(
    receipt.includes("/tmp/.pi/tasks/task-123"),
    t + " includes artifact dir",
  );
  assert.ok(
    receipt.includes("completion notification"),
    t + " explains notification",
  );
}

{
  const t =
    "task tool description matches background default and verification policy";
  assert.equal(TASK_BACKGROUND_DEFAULT, true, t + " default is true");
  assert.ok(
    TASK_TOOL_DESCRIPTION.includes("Background is the default"),
    t + " documents background default",
  );
  assert.ok(
    !TASK_TOOL_DESCRIPTION.includes("Foreground is the default"),
    t + " does not claim foreground default",
  );
  assert.ok(
    TASK_TOOL_DESCRIPTION.includes("Do not trust delegated output blindly"),
    t + " requires verification",
  );
}

{
  const t =
    "getSessionTerminalState treats local synthesis (no stopReason) as stopped";
  // pi appends a final assistant message locally after a tool result, with
  // no stopReason and no api field. That is the common "subagent is done"
  // shape and must be treated as "stopped" so the parent can return.
  const root = mkdtempSync(join(tmpdir(), "pi-task-state-local-"));
  try {
    const dir = join(root, "sessions");
    mkdirSync(dir, { recursive: true });
    writeJsonl(dir, "s1.jsonl", [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Done." }],
        },
        // no stopReason, no api
      },
    ]);
    const local = getSessionTerminalState(dir);
    assert.equal(local.state, "stopped", `${t}: local synthesis is stopped`);
    assert.equal(
      local.stopReason,
      null,
      `${t}: local synthesis has no stopReason`,
    );

    // stopReason=length maps to errored so the parent can surface the failure.
    writeJsonl(dir, "s2.jsonl", [
      assistantMessage("length", "context too long"),
    ]);
    const lengthInfo = getSessionTerminalState(dir);
    assert.equal(
      lengthInfo.state,
      "errored",
      `${t}: stopReason=length is errored`,
    );
    assert.equal(
      lengthInfo.stopReason,
      "length",
      `${t}: stopReason=length surfaces the raw value`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const t = "XML instructions preserve the required task result tags";
  for (const tag of ["status", "summary", "findings", "evidence", "files"]) {
    assert.ok(
      TASK_RESULT_XML_INSTRUCTIONS.includes(`<${tag}>`),
      `${t}: has opening ${tag}`,
    );
    assert.ok(
      TASK_RESULT_XML_INSTRUCTIONS.includes(`</${tag}>`),
      `${t}: has closing ${tag}`,
    );
  }
}

// ─── Session terminal state + completion detection contracts ───────────────

function writeJsonl(dir: string, name: string, lines: object[]): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  const body = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  writeFileSync(path, body, "utf-8");
}

function assistantMessage(stopReason: string, text: string): object {
  return {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason,
    },
  };
}

{
  const root = mkdtempSync(join(tmpdir(), "pi-task-state-"));
  try {
    const dir = join(root, "sessions");

    // No directory yet.
    let info = getSessionTerminalState(dir);
    assert.equal(info.state, "unknown", "missing dir is unknown");
    assert.equal(info.stopReason, null, "missing dir has no stopReason");

    // Empty directory.
    mkdirSync(dir, { recursive: true });
    info = getSessionTerminalState(dir);
    assert.equal(info.state, "unknown", "empty dir is unknown");
    assert.equal(info.stopReason, null, "empty dir has no stopReason");

    // No assistant message yet (only setup entries).
    writeJsonl(dir, "2026-06-21T00-00-00.jsonl", [
      { type: "session", id: "x" },
      { type: "session_info", id: "y" },
    ]);
    info = getSessionTerminalState(dir);
    assert.equal(info.state, "unknown", "only setup entries is unknown");
    assert.equal(info.stopReason, null, "setup-only has no stopReason");

    // Assistant mid-turn: toolUse.
    writeJsonl(dir, "2026-06-21T00-00-01.jsonl", [
      assistantMessage("toolUse", "thinking..."),
    ]);
    info = getSessionTerminalState(dir);
    assert.equal(info.state, "running", "toolUse means still running");
    assert.equal(
      info.stopReason,
      "toolUse",
      "toolUse surfaces the raw stopReason",
    );

    // Assistant finished cleanly.
    writeJsonl(dir, "2026-06-21T00-00-02.jsonl", [
      assistantMessage("stop", "Done. <episode>...</episode>"),
    ]);
    info = getSessionTerminalState(dir);
    assert.equal(info.state, "stopped", "stop means finished");
    assert.equal(info.stopReason, "stop", "stop surfaces the raw stopReason");

    // Assistant hit a non-tool error.
    writeJsonl(dir, "2026-06-21T00-00-03.jsonl", [
      assistantMessage("error", "boom"),
    ]);
    info = getSessionTerminalState(dir);
    assert.equal(info.state, "errored", "error means errored");
    assert.equal(
      info.stopReason,
      "error",
      "error surfaces the raw stopReason",
    );

    // Trailing lines after the last assistant turn must not affect state.
    writeJsonl(dir, "2026-06-21T00-00-04.jsonl", [
      assistantMessage("stop", "final"),
      { type: "noise", after: true },
    ]);
    info = getSessionTerminalState(dir);
    assert.equal(
      info.state,
      "stopped",
      "non-message lines after stop do not flip state",
    );
    assert.equal(
      info.stopReason,
      "stop",
      "trailing noise does not change the surfaced stopReason",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const t =
    "checkTaskCompletion returns completed when session stopped even if pane is alive";
  const root = mkdtempSync(join(tmpdir(), "pi-task-completion-"));
  try {
    const sessionDir = join(root, "sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeJsonl(sessionDir, "s1.jsonl", [
      assistantMessage("stop", "<episode>ok</episode>"),
    ]);
    const resultPath = join(root, "RESULT.md"); // intentionally missing
    const snapshot = await checkTaskCompletion({
      resultPath,
      sessionDir,
      paneId: "%99", // pretend a live pane
    });
    assert.equal(snapshot.status, "completed", `${t}: status`);
    assert.equal(
      snapshot.source,
      "session-jsonl",
      `${t}: source is session-jsonl`,
    );
    assert.ok(
      snapshot.content.includes("<episode>ok</episode>"),
      `${t}: content is the assistant text`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const t =
    "checkTaskCompletion returns failed when session errored without RESULT.md";
  const root = mkdtempSync(join(tmpdir(), "pi-task-completion-err-"));
  try {
    const sessionDir = join(root, "sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeJsonl(sessionDir, "s1.jsonl", [
      assistantMessage("error", "rate limit hit"),
    ]);
    const snapshot = await checkTaskCompletion({
      resultPath: join(root, "RESULT.md"),
      sessionDir,
      paneId: "%99",
    });
    assert.equal(snapshot.status, "failed", `${t}: status`);
    assert.ok(
      snapshot.content.includes("rate limit hit"),
      `${t}: content is the assistant text`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const t =
    "checkTaskCompletion diagnostic names the real stopReason when session errored with no text";
  const root = mkdtempSync(join(tmpdir(), "pi-task-completion-err-diagnostic-"));
  try {
    const sessionDir = join(root, "sessions");
    mkdirSync(sessionDir, { recursive: true });
    // stopReason "error" with no text content → readSessionText returns
    // null → fallback diagnostic must name the real stopReason, not the
    // terminal-state name.
    writeJsonl(sessionDir, "s1.jsonl", [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
        },
      },
    ]);
    const snapshot = await checkTaskCompletion({
      resultPath: join(root, "RESULT.md"),
      sessionDir,
      paneId: "%99",
    });
    assert.equal(snapshot.status, "failed", `${t}: status`);
    assert.equal(snapshot.source, "session-jsonl", `${t}: source`);
    assert.ok(
      snapshot.content.includes("stopReason: error"),
      `${t}: diagnostic names the real stopReason`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const t =
    "checkTaskCompletion returns running while pane is alive and session is mid toolUse";
  // Pane aliveness is dependency-injected so this branch is exercisable
  // on every CI, not just machines with a tmux server on PATH.
  const root = mkdtempSync(join(tmpdir(), "pi-task-completion-mid-"));
  try {
    const sessionDir = join(root, "sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeJsonl(sessionDir, "s1.jsonl", [
      assistantMessage("toolUse", "calling read..."),
    ]);
    const snapshot = await checkTaskCompletion({
      resultPath: join(root, "RESULT.md"),
      sessionDir,
      paneId: "%99", // arbitrary: the injected paneExists ignores the id
      paneExists: () => true,
    });
    assert.equal(snapshot.status, "running", `${t}: status`);
    assert.equal(snapshot.source, "pane", `${t}: source`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const t =
    "checkTaskCompletion prefers RESULT.md over session jsonl when both exist";
  const root = mkdtempSync(join(tmpdir(), "pi-task-completion-both-"));
  try {
    const sessionDir = join(root, "sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeJsonl(sessionDir, "s1.jsonl", [
      assistantMessage("stop", "from session"),
    ]);
    const resultPath = join(root, "RESULT.md");
    writeFileSync(resultPath, "from RESULT.md\n", "utf-8");
    const snapshot = await checkTaskCompletion({
      resultPath,
      sessionDir,
      paneId: "%99",
    });
    assert.equal(snapshot.status, "completed", `${t}: status`);
    assert.equal(snapshot.source, "result-file", `${t}: result-file wins`);
    assert.equal(
      snapshot.content,
      "from RESULT.md",
      `${t}: content is RESULT.md`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const t =
    "getLastAssistantTextFromSessionDir reads the same dir the helper fixes pointed at";
  // Regression: the readSessionText path used to be <sessionDir>/sessions/<name>;
  // ensure the helper itself still reads <sessionDir> directly.
  const root = mkdtempSync(join(tmpdir(), "pi-task-read-"));
  try {
    const sessionDir = join(root, "sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeJsonl(sessionDir, "abc.jsonl", [
      assistantMessage("stop", "hello from session"),
    ]);
    const text = getLastAssistantTextFromSessionDir(sessionDir);
    assert.equal(text, "hello from session", t);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const t = "resolveSessionDir joins the sessions segment to the task dir";
  assert.equal(
    resolveSessionDir("/tmp/.pi/tasks/task-123"),
    join("/tmp/.pi/tasks/task-123", "sessions"),
    t,
  );
}

console.log("ALL TASK HELPER TESTS PASSED");
