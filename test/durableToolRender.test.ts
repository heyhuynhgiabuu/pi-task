/**
 * Durable children render their tool calls through pi's own per-tool renderers
 * (src/panel/task-pane.ts). Those renderers need the tool's native render data:
 * `edit` draws its diff from `details.diff` (as pi's own history rendering does
 * when it hands the whole toolResult message to `updateResult`), and `write`
 * draws the file body from `args.content`. The durable projection
 * (src/panel/durable-transcript.ts) must therefore keep `details`, and the pane
 * must forward them — otherwise a completed edit collapses to its header line.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createEditToolDefinition,
  createWriteToolDefinition,
  initTheme,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import type { AgentEvent, SnapshotEvent } from "@earendil-works/pi-durable";
import { DurableTranscript } from "../src/panel/durable-transcript.js";
import { createTaskTranscriptPane } from "../src/panel/task-pane.js";
import type { TranscriptItem } from "../src/panel/transcript.js";

/** Pi's edit diff format: ` 1 context`, `-2 removed`, `+2 added`. */
const EDIT_DIFF = [" 1 keep me", "-2 old line", "+2 new line"].join("\n");
const EDIT_PATCH = [
  "--- a/tools/align.py",
  "+++ b/tools/align.py",
  "@@ -1,2 +1,2 @@",
  " keep me",
  "-old line",
  "+new line",
].join("\n");
const WRITE_CONTENT = "line one\nline two\nline three\n";

const EDIT_ARGS = {
  path: "tools/align.py",
  edits: [{ oldText: "old line", newText: "new line" }],
};
const WRITE_ARGS = { path: "tools/new.py", content: WRITE_CONTENT };

function makeSnapshot(entries: SnapshotEvent["entries"] = [], tools: SnapshotEvent["tools"] = []): SnapshotEvent {
  return {
    type: "snapshot",
    entries,
    tools,
    compactions: [],
    inbox: [],
    agent: {},
    usage: { models: {}, tools: {}, totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costTotal: 0 } },
  } as SnapshotEvent;
}

function entry(id: number, message: unknown) {
  return { id, conversationId: 1, kind: "pi.message", model: [message] } as never;
}

function assistant(content: unknown[]) {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "faux",
    model: "faux-1",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

function editToolResult() {
  return {
    role: "toolResult",
    toolCallId: "call-edit",
    toolName: "edit",
    content: [{ type: "text", text: "Successfully replaced 1 block(s) in tools/align.py." }],
    details: { diff: EDIT_DIFF, patch: EDIT_PATCH, firstChangedLine: 2 },
    isError: false,
    timestamp: 0,
  };
}

function writeToolResult() {
  return {
    role: "toolResult",
    toolCallId: "call-write",
    toolName: "write",
    content: [{ type: "text", text: "Successfully wrote 3 lines to tools/new.py." }],
    details: { bytesWritten: 30 },
    isError: false,
    timestamp: 0,
  };
}

/** One assistant turn calling edit and write, both answered. */
function editAndWriteEntries(): SnapshotEvent["entries"] {
  return [
    entry(1, { role: "user", content: [{ type: "text", text: "Align the script." }] }),
    entry(2, assistant([
      { type: "toolCall", id: "call-edit", name: "edit", arguments: EDIT_ARGS },
      { type: "toolCall", id: "call-write", name: "write", arguments: WRITE_ARGS },
    ])),
    entry(3, editToolResult()),
    entry(4, writeToolResult()),
  ];
}

function toolItem(items: readonly TranscriptItem[], toolCallId: string) {
  const item = items.find(
    (candidate) => candidate.type === "tool" && candidate.toolCallId === toolCallId,
  );
  assert.ok(item && item.type === "tool", `expected a tool item for ${toolCallId}`);
  return item;
}

function renderPane(items: readonly TranscriptItem[]): string {
  initTheme();
  const pane = createTaskTranscriptPane(
    { terminal: { rows: 40 }, requestRender: () => {} } as never,
    { fg: (_style: string, text: string) => text } as never,
    {
      taskId: "t-durable-tools",
      cwd: "/tmp/pi-task-durable",
      sig: () => "stable",
      read: () => [...items],
    },
  );
  try {
    return pane
      .render(100)
      .map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""))
      .join("\n");
  } finally {
    pane.dispose();
  }
}

/** Strip SGR colors and OSC-8 path links; what a terminal would show. */
function stripAnsi(line: string): string {
  return line
    .replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "")
    .replace(/\x1b\[[0-9;]*m/g, "");
}

/** Strip colors, path links, and the pane's border/repaint chrome. */
function transcriptLines(rendered: string): string[] {
  return rendered
    .split("\n")
    .map(stripAnsi)
    .filter((line) => !/^─+$/.test(line.trim()) && !line.includes("]133;"))
    .map((line) => line.trimEnd())
    .filter((line) => line !== "");
}

test("durable snapshot keeps edit diff details and write content for the pane", () => {
  const transcript = new DurableTranscript(makeSnapshot(editAndWriteEntries()));
  const items = transcript.items();

  assert.deepEqual(toolItem(items, "call-edit").details, {
    diff: EDIT_DIFF,
    patch: EDIT_PATCH,
    firstChangedLine: 2,
  });
  assert.deepEqual(toolItem(items, "call-edit").args, EDIT_ARGS);
  assert.equal(toolItem(items, "call-edit").inProgress, false);
  assert.deepEqual(toolItem(items, "call-write").args, WRITE_ARGS);
  assert.equal(
    toolItem(items, "call-write").result,
    "Successfully wrote 3 lines to tools/new.py.",
  );
});

test("durable snapshot keeps a running tool's details and output", () => {
  const transcript = new DurableTranscript(makeSnapshot(
    [
      entry(1, assistant([
        { type: "toolCall", id: "call-running", name: "edit", arguments: EDIT_ARGS },
      ])),
    ],
    [{
      callId: "call-running",
      name: "edit",
      status: "running",
      output: "partial",
      details: { diff: EDIT_DIFF },
    }] as SnapshotEvent["tools"],
  ));

  const item = toolItem(transcript.items(), "call-running");
  assert.equal(item.inProgress, true);
  assert.equal(item.result, "partial");
  assert.deepEqual(item.details, { diff: EDIT_DIFF });
});

test("durable live events keep edit diff details through the result entry", () => {
  const transcript = new DurableTranscript(makeSnapshot());
  transcript.apply([
    { type: "tool_execution_start", toolCallId: "call-edit", toolName: "edit", args: EDIT_ARGS },
    { type: "tool_execution_update", toolCallId: "call-edit", toolName: "edit", details: { diff: "preview" } },
  ] as AgentEvent[]);

  assert.deepEqual(toolItem(transcript.items(), "call-edit").details, { diff: "preview" });

  transcript.apply([
    { type: "message_start", message: editToolResult() },
    { type: "message_end", entry: entry(3, editToolResult()) },
  ] as AgentEvent[]);

  const item = toolItem(transcript.items(), "call-edit");
  assert.equal(item.inProgress, false);
  assert.deepEqual(item.details, {
    diff: EDIT_DIFF,
    patch: EDIT_PATCH,
    firstChangedLine: 2,
  });
});

test("task pane renders a durable edit diff and write content through pi's renderers", () => {
  const transcript = new DurableTranscript(makeSnapshot(editAndWriteEntries()));
  const rendered = renderPane(transcript.items());

  assert.match(rendered, /edit/, "the edit header survives");
  assert.match(rendered, /-2 old line/, "the removed line of the diff is drawn");
  assert.match(rendered, /\+2 new line/, "the added line of the diff is drawn");
  assert.doesNotMatch(rendered, /Successfully replaced/, "the diff replaces the raw success text");
  assert.match(rendered, /write/, "the write header survives");
  for (const line of ["line one", "line two", "line three"]) {
    assert.ok(rendered.includes(line), `the written content line "${line}" is drawn`);
  }
  assert.doesNotMatch(rendered, /Successfully wrote/, "a successful write result stays hidden, as in pi");
});

test("task pane still renders a failed edit's error text", () => {
  const transcript = new DurableTranscript(makeSnapshot([
    entry(1, assistant([
      { type: "toolCall", id: "call-edit", name: "edit", arguments: EDIT_ARGS },
    ])),
    entry(2, {
      role: "toolResult",
      toolCallId: "call-edit",
      toolName: "edit",
      content: [{ type: "text", text: "Could not edit file: tools/align.py. Error code: ENOENT." }],
      isError: true,
      timestamp: 0,
    }),
  ]));

  const rendered = renderPane(transcript.items());
  assert.match(rendered, /Could not edit file: tools\/align\.py\. Error code: ENOENT\./);
  assert.doesNotMatch(rendered, /-2 old line/, "no diff is invented for a failed edit");
});

/**
 * The reference for parity is pi's own history rendering: a
 * ToolExecutionComponent built from the call args and fed the whole persisted
 * toolResult message (interactive-mode's `renderSessionItems`). Same renderers,
 * same data — so the projected rows must come out identical.
 */
test("durable edit and write rows match pi's own tool rendering line for line", () => {
  const cwd = "/tmp/pi-task-durable";
  const tui = { terminal: { rows: 40 }, requestRender: () => {} } as never;
  const rows = [
    ["edit", EDIT_ARGS, editToolResult(), createEditToolDefinition(cwd)],
    ["write", WRITE_ARGS, writeToolResult(), createWriteToolDefinition(cwd)],
  ] as const;
  const native: string[] = [];
  for (const [name, args, message, definition] of rows) {
    const component = new ToolExecutionComponent(
      name,
      message.toolCallId,
      args,
      {},
      definition as never,
      tui,
      cwd,
    );
    component.updateResult(message as never);
    native.push(
      ...component.render(100).map(stripAnsi),
    );
  }

  // No user/assistant text in this projection, so the pane's content is exactly
  // the two tool rows.
  const transcript = new DurableTranscript(makeSnapshot(editAndWriteEntries().slice(1)));
  assert.deepEqual(
    transcriptLines(renderPane(transcript.items())),
    native.map((line) => line.trimEnd()).filter((line) => line !== ""),
  );
});

test("task pane draws the edit diff of a live durable tool result", () => {
  const transcript = new DurableTranscript(makeSnapshot());
  transcript.apply([
    { type: "tool_execution_start", toolCallId: "call-edit", toolName: "edit", args: EDIT_ARGS },
    { type: "tool_execution_end", toolCallId: "call-edit", toolName: "edit", entry: entry(3, editToolResult()) },
    { type: "message_start", message: editToolResult() },
    { type: "message_end", entry: entry(3, editToolResult()) },
  ] as AgentEvent[]);

  const rendered = renderPane(transcript.items());
  assert.match(rendered, /-2 old line/);
  assert.match(rendered, /\+2 new line/);
});
