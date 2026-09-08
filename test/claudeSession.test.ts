/**
 * Unit tests for Claude Code session JSONL parsing (claudeSession.ts).
 *
 * Run: npx tsx --test test/claudeSession.test.ts
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeSessionFilePath,
  claudeSlug,
  claudeToolUseCount,
  claudeTurnCount,
  getLastClaudeMessageTimestamp,
  getLastClaudeAssistantText,
  hasClaudeFinished,
} from "../src/subagent/claudeSession.js";

function makeTranscript(lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-task-claude-"));
  const file = join(dir, "session.jsonl");
  writeFileSync(
    file,
    lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
  );
  return file;
}

function cleanup(file: string) {
  rmSync(file, { recursive: true, force: true });
}

function assistant(
  stopReason: string | null,
  content?: unknown,
): Record<string, unknown> {
  return {
    type: "assistant",
    message: { role: "assistant", stop_reason: stopReason, content },
    timestamp: new Date().toISOString(),
  };
}

{
  const t = "stop_reason end_turn is terminal";
  const file = makeTranscript([assistant("end_turn", [{ type: "text", text: "done" }])]);
  try {
    assert.equal(hasClaudeFinished(file), true, t);
    assert.equal(getLastClaudeAssistantText(file), "done", t);
  } finally {
    cleanup(file);
  }
}

for (const reason of ["stop_sequence", "max_tokens"]) {
  const t = `stop_reason ${reason} is terminal`;
  const file = makeTranscript([assistant(reason, [{ type: "text", text: "ok" }])]);
  try {
    assert.equal(hasClaudeFinished(file), true, t);
  } finally {
    cleanup(file);
  }
}

{
  const t = "stop_reason null (in flight) is not finished";
  const file = makeTranscript([
    assistant(null, [{ type: "text", text: "partial" }]),
  ]);
  try {
    assert.equal(hasClaudeFinished(file), false, t);
  } finally {
    cleanup(file);
  }
}

{
  const t = "stop_reason tool_use (continues) is not finished";
  const file = makeTranscript([
    assistant("tool_use", [
      { type: "tool_use", id: "t1", name: "read", input: {} },
    ]),
  ]);
  try {
    assert.equal(hasClaudeFinished(file), false, t);
    assert.equal(claudeToolUseCount(file), 1, t);
  } finally {
    cleanup(file);
  }
}

{
  const t = "stop_reason pause_turn is not finished";
  const file = makeTranscript([assistant("pause_turn")]);
  try {
    assert.equal(hasClaudeFinished(file), false, t);
  } finally {
    cleanup(file);
  }
}

{
  const t = "missing transcript file is not finished and yields empty text";
  const missing = join(tmpdir(), `pi-task-claude-missing-${Date.now()}.jsonl`);
  assert.equal(hasClaudeFinished(missing), false, t);
  assert.equal(getLastClaudeAssistantText(missing), "", t);
}

{
  const t = "tool_use followed by end_turn is finished (last reason wins)";
  const file = makeTranscript([
    assistant("tool_use", [{ type: "tool_use", id: "t1", name: "bash", input: {} }]),
    assistant("end_turn", [{ type: "text", text: "final answer" }]),
  ]);
  try {
    assert.equal(hasClaudeFinished(file), true, t);
    assert.equal(getLastClaudeAssistantText(file), "final answer", t);
  } finally {
    cleanup(file);
  }
}

{
  const t = "end_turn followed by tool_use is NOT finished (reason regressed mid-stream order)";
  const file = makeTranscript([
    assistant("end_turn"),
    assistant("tool_use"),
  ]);
  try {
    assert.equal(hasClaudeFinished(file), false, t);
  } finally {
    cleanup(file);
  }
}

{
  const t = "camelCase stopReason is recognized (older Claude Code versions)";
  const file = makeTranscript([
    {
      type: "assistant",
      message: {
        role: "assistant",
        stopReason: "end_turn",
        content: [{ type: "text", text: "camel" }],
      },
    },
  ]);
  try {
    assert.equal(hasClaudeFinished(file), true, t);
    assert.equal(getLastClaudeAssistantText(file), "camel", t);
  } finally {
    cleanup(file);
  }
}

{
  const t = "string message content is extracted as assistant text";
  const file = makeTranscript([assistant("end_turn", "plain string content")]);
  try {
    assert.equal(getLastClaudeAssistantText(file), "plain string content", t);
  } finally {
    cleanup(file);
  }
}

{
  const t = "text blocks are joined and non-text blocks ignored";
  const file = makeTranscript([
    assistant("end_turn", [
      { type: "thinking", thinking: "hm" },
      { type: "text", text: "line one" },
      { type: "tool_use", id: "t1", name: "read", input: {} },
      { type: "text", text: "line two" },
    ]),
  ]);
  try {
    assert.equal(getLastClaudeAssistantText(file), "line one\nline two", t);
    assert.equal(claudeToolUseCount(file), 1, t);
  } finally {
    cleanup(file);
  }
}

{
  const t = "empty assistant text falls back to the last non-empty one";
  const file = makeTranscript([
    assistant("end_turn", [{ type: "text", text: "real result" }]),
    assistant("end_turn", [{ type: "text", text: "" }]),
  ]);
  try {
    assert.equal(getLastClaudeAssistantText(file), "real result", t);
  } finally {
    cleanup(file);
  }
}

{
  const t = "malformed JSONL rows are skipped";
  const dir = mkdtempSync(join(tmpdir(), "pi-task-claude-"));
  const file = join(dir, "session.jsonl");
  writeFileSync(
    file,
    "{not json}\n" +
      JSON.stringify(assistant("end_turn", [{ type: "text", text: "survived" }])) +
      "\n",
  );
  try {
    assert.equal(hasClaudeFinished(file), true, t);
    assert.equal(getLastClaudeAssistantText(file), "survived", t);
  } finally {
    cleanup(file);
  }
}

{
  const t = "sinceMs filters older assistant rows";
  const file = makeTranscript([
    { ...assistant("end_turn", [{ type: "text", text: "old" }]), timestamp: "2000-01-01T00:00:00.000Z" },
    { ...assistant("tool_use", [{ type: "text", text: "new but still working" }]), timestamp: new Date().toISOString() },
  ]);
  try {
    assert.equal(hasClaudeFinished(file, Date.now() - 60_000), false, t);
  } finally {
    cleanup(file);
  }
}

{
  const t = "user/system rows are ignored";
  const file = makeTranscript([
    { type: "user", message: { role: "user", content: "hello" } },
    { type: "system", message: { role: "system", content: "hook fired" } },
  ]);
  try {
    assert.equal(hasClaudeFinished(file), false, t);
    assert.equal(getLastClaudeAssistantText(file), "", t);
  } finally {
    cleanup(file);
  }
}

{
  const t = "end_turn followed by null (new in-flight turn) is NOT finished";
  const file = makeTranscript([
    assistant("end_turn"),
    assistant(null),
  ]);
  try {
    assert.equal(hasClaudeFinished(file), false, t);
  } finally {
    cleanup(file);
  }
}

{
  const t = "null (in flight) followed by end_turn IS finished (latest row wins)";
  const file = makeTranscript([
    assistant(null),
    assistant("end_turn", [{ type: "text", text: "actually done" }]),
  ]);
  try {
    assert.equal(hasClaudeFinished(file), true, t);
    assert.equal(getLastClaudeAssistantText(file), "actually done", t);
  } finally {
    cleanup(file);
  }
}

{
  const t = "turns: only assistant rows with an explicit stop_reason count";
  const file = makeTranscript([
    assistant("tool_use"),
    assistant(null),
    assistant("tool_use"),
    assistant("end_turn"),
  ]);
  try {
    assert.equal(claudeTurnCount(file), 3, t);
  } finally {
    cleanup(file);
  }
}

{
  const t = "turns: null/unknown streaming rows and non-assistant rows are excluded";
  const file = makeTranscript([
    assistant(null),
    { type: "user", message: { role: "user", content: "hi" } },
    { type: "assistant" },
  ]);
  try {
    assert.equal(claudeTurnCount(file), 0, t);
  } finally {
    cleanup(file);
  }
}

{
  const t = "turns: sinceMs filters older rows and a missing file yields 0";
  const file = makeTranscript([
    { ...assistant("end_turn"), timestamp: "2000-01-01T00:00:00.000Z" },
    { ...assistant("tool_use"), timestamp: new Date().toISOString() },
  ]);
  const missing = join(tmpdir(), `pi-task-claude-missing-${Date.now()}.jsonl`);
  try {
    assert.equal(claudeTurnCount(file, Date.now() - 60_000), 1, t);
    assert.equal(claudeTurnCount(missing), 0, t);
  } finally {
    cleanup(file);
  }
}

{
  const t = "claudeSlug matches the observed Claude Code projects layout";
  assert.equal(claudeSlug("C:\\Users\\Vu\\Desktop\\pi-vu"), "C--Users-Vu-Desktop-pi-vu", t);
  assert.equal(claudeSlug("C:/Users/Vu/Desktop/pi-vu"), "C--Users-Vu-Desktop-pi-vu", t);
  assert.equal(claudeSlug("/home/dev/my project"), "-home-dev-my-project", t);
}

{
  const t = "claudeSessionFilePath joins home + projects + slug + sessionId.jsonl";
  const home = mkdtempSync(join(tmpdir(), "pi-task-claude-home-"));
  try {
    const expected = join(home, ".claude", "projects", "C--Users-Vu-Desktop-pi-vu", "abc.jsonl");
    assert.equal(
      claudeSessionFilePath("C:\\Users\\Vu\\Desktop\\pi-vu", "abc", home),
      expected,
      t,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

{
  const t = "last Claude assistant timestamp supports restart completion history";
  const file = makeTranscript([
    { ...assistant("tool_use"), timestamp: "2026-09-08T10:00:00.000Z" },
    { ...assistant("end_turn"), timestamp: "2026-09-08T10:00:05.000Z" },
  ]);
  try {
    assert.equal(
      getLastClaudeMessageTimestamp(file),
      Date.parse("2026-09-08T10:00:05.000Z"),
      t,
    );
  } finally {
    cleanup(file);
  }
}

console.log("ALL CLAUDE SESSION TESTS PASSED");
