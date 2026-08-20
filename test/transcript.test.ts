import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_TRANSCRIPT_ITEMS,
  findTaskSessionFile,
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
  }
  if (final.type === "assistant") {
    assert.equal(final.text, "Cleanup verified.");
  }
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
