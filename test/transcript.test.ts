import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_TRANSCRIPT_ITEMS,
  findTaskSessionFile,
  readTaskSessionFile,
  readTaskTranscript,
  transcriptActivity,
} from "../src/panel/transcript.js";

function fixtureSession(name = "task-abc123"): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-task-transcript-"));
  const file = join(dir, "session.jsonl");
  writeFileSync(
    file,
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "s1",
        timestamp: "2026-08-19T00:00:00.000Z",
      }),
      JSON.stringify({
        type: "session_info",
        id: "i1",
        timestamp: "2026-08-19T00:00:01.000Z",
        name,
      }),
      JSON.stringify({
        type: "model_change",
        id: "m1",
        timestamp: "2026-08-19T00:00:02.000Z",
        provider: "openai",
        modelId: "gpt-5.4",
      }),
      JSON.stringify({
        type: "message",
        id: "u1",
        timestamp: "2026-08-19T00:00:03.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "# Task: verify cleanup\n\nDo the thing." }],
        },
      }),
      JSON.stringify({
        type: "custom_message",
        customType: "active-todos",
        content: "Active TODOs (3 open):\n- [ ] item",
      }),
      JSON.stringify({
        type: "message",
        id: "a1",
        timestamp: "2026-08-19T00:00:04.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Let me check the cleanup path." },
            { type: "text", text: "I will inspect the files." },
            {
              type: "toolCall",
              id: "call_00_aaa",
              name: "bash",
              arguments: { command: "git status" },
            },
          ],
          stopReason: "toolUse",
        },
      }),
      JSON.stringify({
        type: "message",
        id: "t1",
        timestamp: "2026-08-19T00:00:05.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call_00_aaa",
          toolName: "bash",
          content: [{ type: "text", text: "M src/index.ts" }],
          isError: false,
        },
      }),
      JSON.stringify({
        type: "message",
        id: "a2",
        timestamp: "2026-08-19T00:00:06.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Cleanup verified." }],
          stopReason: "stop",
        },
      }),
    ].join("\n"),
    "utf-8",
  );
  return dir;
}

test("readTaskTranscript parses user/assistant/tool rows and pairs tool calls with results", () => {
  const dir = fixtureSession();
  const { items, found } = readTaskTranscript(dir, "task-abc123");
  assert.equal(found, true);
  assert.deepEqual(
    items.map((i) => i.type),
    ["user", "assistant", "tool", "assistant"],
  );

  const [user, assistant, tool, final] = items;
  assert.equal(user.type, "user");
  if (user.type === "user") {
    assert.match(user.text, /verify cleanup/);
    assert.equal(user.text.includes("Active TODOs"), false, "custom messages are skipped");
  }
  if (assistant.type === "assistant") {
    assert.equal(assistant.text, "I will inspect the files.");
    assert.match(assistant.thinking ?? "", /cleanup path/);
  }
  if (tool.type === "tool") {
    assert.equal(tool.name, "bash");
    assert.deepEqual(tool.args, { command: "git status" });
    assert.equal(tool.result, "M src/index.ts");
    assert.equal(tool.isError, false);
    assert.equal(tool.inProgress, false);
  }
  if (final.type === "assistant") {
    assert.equal(final.text, "Cleanup verified.");
  }
});

test("readTaskTranscript keeps a tool result's details for pi's per-tool renderers", () => {
  // pi persists the whole toolResult message, `details` included; the pane hands
  // it to the tool renderer (edit draws its diff from `details.diff`).
  const dir = mkdtempSync(join(tmpdir(), "pi-task-transcript-"));
  writeFileSync(
    join(dir, "s.jsonl"),
    [
      JSON.stringify({
        type: "message",
        timestamp: "2026-08-19T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_00_edit",
              name: "edit",
              arguments: {
                path: "tools/align.py",
                edits: [{ oldText: "old line", newText: "new line" }],
              },
            },
          ],
          stopReason: "toolUse",
        },
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-08-19T00:00:02.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call_00_edit",
          toolName: "edit",
          content: [{ type: "text", text: "Successfully replaced 1 block(s) in tools/align.py." }],
          details: { diff: "-1 old line\n+1 new line", patch: "patch", firstChangedLine: 1 },
          isError: false,
        },
      }),
    ].join("\n"),
    "utf-8",
  );

  const { items } = readTaskTranscript(dir, undefined);
  const tool = items.find((item) => item.type === "tool");
  assert.ok(tool && tool.type === "tool");
  assert.deepEqual(tool.details, {
    diff: "-1 old line\n+1 new line",
    patch: "patch",
    firstChangedLine: 1,
  });
});

test("readTaskTranscript records the child's own model and thinking level", () => {
  // Pi writes these at session start (and on change); the panel shows them in
  // the child footer instead of guessing a model.
  const dir = mkdtempSync(join(tmpdir(), "pi-task-transcript-meta-"));
  writeFileSync(
    join(dir, "s.jsonl"),
    [
      JSON.stringify({
        type: "model_change",
        provider: "opencode-go",
        modelId: "deepseek-flash",
        timestamp: "2026-08-19T00:00:00.000Z",
      }),
      JSON.stringify({
        type: "thinking_level_change",
        thinkingLevel: "high",
        timestamp: "2026-08-19T00:00:00.000Z",
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-08-19T00:00:01.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "working" }] },
      }),
      JSON.stringify({
        type: "thinking_level_change",
        thinkingLevel: "low",
        timestamp: "2026-08-19T00:00:02.000Z",
      }),
    ].join("\n"),
  );

  const { meta, found } = readTaskTranscript(dir, undefined);
  assert.equal(found, true);
  assert.equal(meta?.model, "opencode-go/deepseek-flash", "the last model_change wins");
  assert.equal(meta?.thinkingLevel, "low", "the last thinking_level_change wins");
});

test("readTaskSessionFile exposes exact session identity, lifetime counts, cache usage, and cost", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-task-transcript-session-info-"));
  const file = join(dir, "child.jsonl");
  const usage = (input: number, output: number, cacheRead: number, cacheWrite: number, cost: number) => ({
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output,
    cost: { input: cost / 2, output: cost / 2, cacheRead: 0, cacheWrite: 0, total: cost },
  });
  writeFileSync(file, [
    JSON.stringify({ type: "session", id: "child-session-id", cwd: "/work/child" }),
    JSON.stringify({ type: "session_info", name: "review child" }),
    JSON.stringify({ type: "model_change", provider: "openai", modelId: "gpt-test" }),
    JSON.stringify({ type: "thinking_level_change", thinkingLevel: "high" }),
    JSON.stringify({ type: "message", message: { role: "user", content: "task" } }),
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "true" } }],
        usage: usage(10, 5, 2, 3, 0.015),
      },
    }),
    JSON.stringify({
      type: "message",
      message: { role: "toolResult", toolCallId: "call-1", content: "done", usage: usage(1, 2, 4, 5, 0.005) },
    }),
  ].join("\n"));

  const { sessionInfo } = readTaskSessionFile(file);
  assert.deepEqual(sessionInfo, {
    sessionId: "child-session-id",
    sessionName: "review child",
    storagePath: file,
    model: "openai/gpt-test",
    thinkingLevel: "high",
    cwd: "/work/child",
    counts: {
      scope: "session",
      userMessages: 1,
      assistantMessages: 1,
      toolCalls: 1,
      toolResults: 1,
      totalMessages: 3,
    },
    tokens: { input: 11, output: 7, cacheRead: 6, cacheWrite: 8, total: 32 },
    cost: 0.02,
  });
});

test("readTaskTranscript reports no metadata for a session that recorded none", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-task-transcript-nometa-"));
  writeFileSync(
    join(dir, "s.jsonl"),
    JSON.stringify({
      type: "message",
      timestamp: "2026-08-19T00:00:01.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "no metadata" }] },
    }),
  );
  const { meta } = readTaskTranscript(dir, undefined);
  assert.equal(meta, undefined, "nothing is invented for a session without metadata");
});

test("readTaskTranscript synthesizes tool rows for unmatched tool results", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-task-transcript-"));
  writeFileSync(
    join(dir, "s.jsonl"),
    JSON.stringify({
      type: "message",
      timestamp: "2026-08-19T00:00:01.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call_00_orphan",
        toolName: "read",
        content: [{ type: "text", text: "file contents" }],
        isError: true,
      },
    }),
    "utf-8",
  );
  const { items } = readTaskTranscript(dir, undefined);
  assert.equal(items.length, 1);
  const tool = items[0];
  if (tool.type === "tool") {
    assert.equal(tool.name, "read");
    assert.equal(tool.result, "file contents");
    assert.equal(tool.isError, true);
    assert.deepEqual(tool.args, {});
  }
});

test("readTaskTranscript returns found=false for a missing session dir", () => {
  const { items, found } = readTaskTranscript("/nonexistent/session-dir", "x");
  assert.equal(found, false);
  assert.deepEqual(items, []);
});

test("findTaskSessionFile picks the newest matching file and honors the session name", () => {
  const dir = fixtureSession("task-abc123");
  const other = join(dir, "other.jsonl");
  writeFileSync(
    other,
    JSON.stringify({
      type: "session_info",
      id: "x",
      timestamp: "2026-08-19T00:00:00.000Z",
      name: "task-other",
    }),
    "utf-8",
  );
  assert.equal(findTaskSessionFile(dir, "task-abc123"), join(dir, "session.jsonl"));
  assert.equal(findTaskSessionFile(dir, "task-other"), other);
  assert.equal(findTaskSessionFile(dir, "task-missing"), null);
});

test("readTaskTranscript caps items keeping the latest", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-task-transcript-"));
  const lines: string[] = [];
  for (let i = 0; i < MAX_TRANSCRIPT_ITEMS + 50; i++) {
    lines.push(
      JSON.stringify({
        type: "message",
        id: `u${i}`,
        timestamp: `2026-08-19T00:00:${String(i).padStart(2, "0")}.000Z`,
        message: {
          role: "user",
          content: [{ type: "text", text: `message ${i}` }],
        },
      }),
    );
  }
  writeFileSync(join(dir, "s.jsonl"), lines.join("\n"), "utf-8");
  const { items } = readTaskTranscript(dir, undefined);
  assert.equal(items.length, MAX_TRANSCRIPT_ITEMS);
  const first = items[0];
  if (first.type === "user") {
    assert.equal(first.text, "message 50");
  }
});

test("transcriptActivity summarizes the latest tool call", () => {
  const dir = fixtureSession();
  const { items } = readTaskTranscript(dir, "task-abc123");
  assert.equal(transcriptActivity(items), "$ git status");
  assert.equal(transcriptActivity([]), "");
});
import { appendFileSync } from "node:fs";
import { transcriptSignature } from "../src/panel/transcript.js";

test("transcriptSignature changes when the session file grows and is empty for missing dirs", () => {
  const dir = fixtureSession("task-sig");
  const sig1 = transcriptSignature(dir);
  assert.ok(sig1.length > 0, "sig should be non-empty for an existing file");
  appendFileSync(
    join(dir, "session.jsonl"),
    "\n" + JSON.stringify({
      type: "message",
      timestamp: "2026-08-19T00:01:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "more" }] },
    }),
    "utf-8",
  );
  const sig2 = transcriptSignature(dir);
  assert.notEqual(sig2, sig1, "growing the file must change the signature");
  assert.equal(transcriptSignature("/nonexistent/dir"), "");
});

test("parser strips ANSI from tool results and keeps literal text intact", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-task-transcript-ansi-"));
  try {
    const file = join(dir, "session.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "s1",
          timestamp: "2026-08-19T00:00:00.000Z",
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-08-19T00:00:01.000Z",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "The array literal [1, 2] is fine and so is a literal \\x1b[34m escape." },
            ],
          },
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-08-19T00:00:02.000Z",
          message: {
            role: "toolResult",
            toolCallId: "call-1",
            content: [
              {
                type: "text",
                text: "\x1b[34m fail 0\x1b[39m\n\x1b[32m pass 12\x1b[39m\narrays [34m look like [39m text",
              },
            ],
          },
        }),
      ].join("\n") + "\n",
    );

    const { items, found } = readTaskSessionFile(file);
    assert.equal(found, true);
    const tool = items.find((i) => i.type === "tool");
    assert.ok(tool, "tool item parsed");
    if (tool.type !== "tool") return;
    assert.equal(tool.result?.includes("\x1b"), false, "SGR escapes stripped");
    assert.match(tool.result ?? "", /fail 0/, "text content preserved");
    assert.match(tool.result ?? "", /\[34m look like \[39m text/, "literal bracket text (no ESC) survives");
    const assistant = items.find((i) => i.type === "assistant");
    assert.match(assistant && assistant.type === "assistant" ? assistant.text : "", /\\x1b\[34m escape/, "literal backslash-escape text survives");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
