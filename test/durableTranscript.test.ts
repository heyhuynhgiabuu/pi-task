import assert from "node:assert/strict";
import { test } from "node:test";
import type { SnapshotEvent } from "@earendil-works/pi-durable";
import { DurableTranscript } from "../src/panel/durable-transcript.js";
import { MAX_TRANSCRIPT_ITEMS } from "../src/panel/transcript.js";

function makeSnapshot(entries: SnapshotEvent["entries"] = []): SnapshotEvent {
  return {
    type: "snapshot",
    entries,
    tools: [],
    compactions: [],
    inbox: [],
    agent: {},
    usage: { models: {}, tools: {}, totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costTotal: 0 } },
  } as SnapshotEvent;
}

function entry(id: number, message: unknown) {
  return {
    id,
    conversationId: 1,
    kind: "pi.message",
    model: [message],
  } as never;
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

test("durable transcript hydrates message history and pairs tool results", () => {
  const transcript = new DurableTranscript(makeSnapshot([
    entry(1, { role: "user", content: [{ type: "text", text: "Inspect the file." }] }),
    entry(2, assistant([
      { type: "thinking", thinking: "Check first." },
      { type: "text", text: "I will read it." },
      { type: "toolCall", id: "call-read", name: "read", arguments: { path: "src/a.ts" } },
    ])),
    entry(3, {
      role: "toolResult",
      toolCallId: "call-read",
      toolName: "read",
      content: [{ type: "text", text: "File contents." }],
      isError: false,
    }),
    entry(4, assistant([{ type: "text", text: "The file is clean." }])),
  ]));

  const items = transcript.items();
  assert.deepEqual(items.map((item) => item.type), ["user", "assistant", "tool", "assistant"]);
  assert.equal(items[0]?.type === "user" ? items[0].text : "", "Inspect the file.");
  assert.equal(items[1]?.type === "assistant" ? items[1].text : "", "I will read it.");
  assert.equal(items[1]?.type === "assistant" ? items[1].thinking : undefined, "Check first.");
  assert.equal(items[2]?.type === "tool" ? items[2].result : undefined, "File contents.");
  assert.equal(items[2]?.type === "tool" ? items[2].inProgress : true, false);
  assert.equal(items[3]?.type === "assistant" ? items[3].text : "", "The file is clean.");
});

test("durable transcript exposes the child's own agent state", () => {
  const snapshot = {
    ...makeSnapshot(),
    agent: {
      model: { provider: "opencode-go", modelId: "deepseek-flash" },
      thinkingLevel: "high",
      cwd: "/tmp/child-cwd",
    },
  } as SnapshotEvent;
  const transcript = new DurableTranscript(snapshot);
  assert.deepEqual(transcript.agentState(), {
    model: "opencode-go/deepseek-flash",
    thinkingLevel: "high",
    cwd: "/tmp/child-cwd",
  });

  // A later agent change replaces the stored state; absent fields are dropped.
  transcript.apply([
    {
      type: "agent_changed",
      agent: { model: { provider: "anthropic", modelId: "claude-sonnet-4" } },
    } as never,
  ]);
  assert.deepEqual(transcript.agentState(), {
    model: "anthropic/claude-sonnet-4",
  });

  // An empty agent state means the harness has none: nothing is invented.
  transcript.apply([{ type: "agent_changed", agent: {} } as never]);
  assert.deepEqual(transcript.agentState(), {});
});

test("durable transcript reflects a running tool, partial output, and its final result", () => {
  const transcript = new DurableTranscript(makeSnapshot());
  transcript.apply([
    { type: "tool_execution_start", toolCallId: "call-bash", toolName: "bash", args: { command: "pwd" } },
    { type: "tool_execution_update", toolCallId: "call-bash", toolName: "bash", output: { set: "/repo" } },
  ]);

  assert.equal(transcript.toolCallCount(), 1);
  let tool = transcript.items()[0];
  assert.equal(tool?.type, "tool");
  if (tool?.type === "tool") {
    assert.equal(tool.inProgress, true);
    assert.equal(tool.result, "/repo");
    assert.deepEqual(tool.args, { command: "pwd" });
  }

  transcript.apply([
    {
      type: "message_end",
      entry: entry(1, {
        role: "toolResult",
        toolCallId: "call-bash",
        toolName: "bash",
        content: [{ type: "text", text: "Directory listing." }],
        isError: false,
      }),
    },
  ]);
  tool = transcript.items()[0];
  assert.equal(tool?.type === "tool" ? tool.inProgress : true, false);
  assert.equal(tool?.type === "tool" ? tool.result : undefined, "Directory listing.");
});

test("durable transcript counts live tool calls without execution-start and closes empty results", () => {
  const transcript = new DurableTranscript(makeSnapshot());
  transcript.apply([
    {
      type: "message_end",
      entry: entry(1, assistant([
        { type: "toolCall", id: "call-empty", name: "read", arguments: {} },
      ])),
    },
    {
      type: "message_end",
      entry: entry(2, {
        role: "toolResult",
        toolCallId: "call-empty",
        toolName: "read",
        content: [],
        isError: false,
      }),
    },
  ]);

  const tool = transcript.items().find((item) => item.type === "tool");
  assert.equal(transcript.toolCallCount(), 1);
  assert.equal(tool?.type === "tool" ? tool.inProgress : true, false);
  assert.equal(tool?.type === "tool" ? tool.result : undefined, undefined);
});

test("durable transcript counts and finalizes a tool call seen only at execution-end", () => {
  const transcript = new DurableTranscript(makeSnapshot());
  transcript.apply([{
    type: "tool_execution_end",
    toolCallId: "call-end-only",
    toolName: "read",
  }]);

  const tool = transcript.items().find((item) => item.type === "tool");
  assert.equal(transcript.toolCallCount(), 1);
  assert.equal(tool?.type === "tool" ? tool.inProgress : true, false);
});

test("durable transcript applies streamed assistant text deltas", () => {
  const transcript = new DurableTranscript(makeSnapshot());
  const message = assistant([]);
  transcript.apply([
    { type: "message_start", message },
    {
      type: "message_update",
      usage: message.usage,
      changes: [
        { type: "text_start", contentIndex: 0, block: { type: "text", text: "I am" } },
        { type: "text_delta", contentIndex: 0, delta: " working." },
      ],
    },
  ]);

  const item = transcript.items()[0];
  assert.equal(item?.type === "assistant" ? item.text : "", "I am working.");
});

test("durable transcript does not recount a pending snapshot tool when execution starts", () => {
  const snapshot = {
    ...makeSnapshot([
      entry(1, assistant([
        { type: "toolCall", id: "call-pending", name: "read", arguments: { path: "README.md" } },
      ])),
    ]),
    tools: [{ callId: "call-pending", name: "read", status: "pending" }],
  } as SnapshotEvent;
  const transcript = new DurableTranscript(snapshot);
  assert.equal(transcript.toolCallCount(), 1);

  transcript.apply([{
    type: "tool_execution_start",
    toolCallId: "call-pending",
    toolName: "read",
    args: { path: "README.md" },
  }]);

  assert.equal(transcript.toolCallCount(), 1);
  assert.equal(transcript.items().filter((item) => item.type === "tool").length, 1);
});

test("durable transcript deduplicates a toolcall entry awaiting its live slot", () => {
  const transcript = new DurableTranscript(makeSnapshot([
    entry(1, assistant([
      { type: "toolCall", id: "call-awaiting-slot", name: "read", arguments: {} },
    ])),
  ]));
  assert.equal(transcript.toolCallCount(), 1);

  transcript.apply([{
    type: "tool_execution_start",
    toolCallId: "call-awaiting-slot",
    toolName: "read",
    args: {},
  }]);

  assert.equal(transcript.toolCallCount(), 1);
});

test("durable transcript tracks only unresolved snapshot toolcalls beyond the display window", () => {
  const callIds = Array.from(
    { length: MAX_TRANSCRIPT_ITEMS + 1 },
    (_, index) => `call-${index}`,
  );
  const entries: SnapshotEvent["entries"] = [];
  callIds.forEach((id, index) => {
    entries.push(entry(index * 2, assistant([
      { type: "toolCall", id, name: "read", arguments: {} },
    ])));
    if (index > 0) {
      entries.push(entry(index * 2 + 1, {
        role: "toolResult",
        toolCallId: id,
        toolName: "read",
        content: [{ type: "text", text: `Result ${index}` }],
        isError: false,
      }));
    }
  });
  const transcript = new DurableTranscript(makeSnapshot(entries));

  assert.equal(transcript.items().length, MAX_TRANSCRIPT_ITEMS);
  assert.equal(transcript.toolCallCount(), callIds.length);

  transcript.apply([{
    type: "tool_execution_start",
    toolCallId: callIds[0]!,
    toolName: "read",
    args: {},
  }]);
  assert.equal(transcript.toolCallCount(), callIds.length);

  transcript.apply([{
    type: "tool_execution_start",
    toolCallId: callIds[1]!,
    toolName: "read",
    args: {},
  }]);
  assert.equal(transcript.toolCallCount(), callIds.length + 1);
});

test("durable transcript deduplicates a toolcall in the current snapshot generation", () => {
  const snapshot = {
    ...makeSnapshot(),
    generation: {
      message: assistant([
        { type: "toolCall", id: "call-generating", name: "read", arguments: {} },
      ]),
    },
  } as SnapshotEvent;
  const transcript = new DurableTranscript(snapshot);
  assert.equal(transcript.toolCallCount(), 1);

  transcript.apply([{
    type: "tool_execution_start",
    toolCallId: "call-generating",
    toolName: "read",
    args: {},
  }]);

  assert.equal(transcript.toolCallCount(), 1);
});

test("durable transcript keeps cumulative tool-call totals across replacement snapshots", () => {
  const initialEntries = Array.from({ length: 5 }, (_, index) =>
    entry(index, assistant([
      { type: "toolCall", id: `call-${index}`, name: "read", arguments: { index } },
    ])),
  );
  const transcript = new DurableTranscript(makeSnapshot(initialEntries));
  assert.equal(transcript.toolCallCount(), 5);

  const compactedSnapshot = makeSnapshot([
    entry(4, assistant([
      { type: "toolCall", id: "call-4", name: "read", arguments: { index: 4 } },
    ])),
  ]);
  transcript.apply([compactedSnapshot]);
  assert.equal(transcript.toolCallCount(), 5);

  transcript.apply([{
    type: "tool_execution_start",
    toolCallId: "call-5",
    toolName: "read",
    args: { index: 5 },
  }]);
  assert.equal(transcript.toolCallCount(), 6);
});

test("durable transcript keeps cumulative tool-call totals after trimming displayed history", () => {
  const entries = Array.from({ length: 205 }, (_, index) => [
    entry(index * 2, { role: "user", content: [{ type: "text", text: `Task ${index}` }] }),
    entry(index * 2 + 1, assistant([
      { type: "toolCall", id: `call-${index}`, name: "read", arguments: { index } },
    ])),
  ]).flat();
  const transcript = new DurableTranscript(makeSnapshot(entries as SnapshotEvent["entries"]));

  assert.equal(transcript.items().length, MAX_TRANSCRIPT_ITEMS);
  assert.equal(transcript.items().filter((item) => item.type === "tool").length, 200);
  assert.equal(transcript.toolCallCount(), 205);
});

test("durable transcript keeps distinct assistant text and thinking blocks during updates", () => {
  const transcript = new DurableTranscript(makeSnapshot());
  const message = assistant([]);
  transcript.apply([
    { type: "message_start", message },
    {
      type: "message_update",
      usage: message.usage,
      changes: [
        { type: "text_start", contentIndex: 0, block: { type: "text", text: "First block" } },
        { type: "text_start", contentIndex: 1, block: { type: "text", text: "Second block" } },
        { type: "text_delta", contentIndex: 0, delta: " updated" },
        { type: "thinking_start", contentIndex: 2, block: { type: "thinking", thinking: "First thought" } },
        { type: "thinking_start", contentIndex: 3, block: { type: "thinking", thinking: "Second thought" } },
        { type: "block", contentIndex: 1, block: { type: "text", text: "Replaced second block" } },
      ],
    },
  ]);

  const item = transcript.items()[0];
  assert.equal(
    item?.type === "assistant" ? item.text : "",
    "First block updated\nReplaced second block",
  );
  assert.equal(
    item?.type === "assistant" ? item.thinking : undefined,
    "First thought\nSecond thought",
  );
});

function toolResultMessage(toolCallId: string, extra: Record<string, unknown> = {}) {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "bash",
    content: [{ type: "text", text: "ok" }],
    isError: false,
    ...extra,
  };
}

function toolItems(transcript: DurableTranscript) {
  return transcript.items().flatMap((item) => (item.type === "tool" ? [item] : []));
}

test("durable snapshot projects toolResult durationMs, paired and unpaired", () => {
  const transcript = new DurableTranscript(makeSnapshot([
    entry(1, assistant([
      { type: "toolCall", id: "paired", name: "bash", arguments: {} },
      { type: "toolCall", id: "zero", name: "bash", arguments: {} },
      { type: "toolCall", id: "bad", name: "bash", arguments: {} },
    ])),
    entry(2, toolResultMessage("paired", { durationMs: 1500 })),
    entry(3, toolResultMessage("zero", { durationMs: 0 })),
    entry(4, toolResultMessage("bad", { durationMs: -1 })),
    entry(5, toolResultMessage("unpaired", { durationMs: 40 })),
    entry(6, toolResultMessage("missing")),
  ]));
  const byId = new Map(toolItems(transcript).map((t) => [t.toolCallId, t.durationMs]));
  assert.deepEqual([...byId], [
    ["paired", 1500], ["zero", 0], ["bad", undefined], ["unpaired", 40], ["missing", undefined],
  ]);
});

test("durable live message_end and tool_execution_end carry durationMs", () => {
  const transcript = new DurableTranscript(makeSnapshot());
  transcript.apply([
    { type: "tool_execution_start", toolCallId: "live", toolName: "bash", args: {} },
    {
      type: "tool_execution_end",
      toolCallId: "live",
      toolName: "bash",
      entry: entry(1, toolResultMessage("live", { durationMs: 2000 })),
    },
    { type: "tool_execution_start", toolCallId: "msg", toolName: "bash", args: {} },
    { type: "message_end", entry: entry(2, toolResultMessage("msg", { durationMs: 0 })) },
    { type: "tool_execution_start", toolCallId: "none", toolName: "bash", args: {} },
    { type: "tool_execution_end", toolCallId: "none", toolName: "bash" },
  ] as never);
  const items = toolItems(transcript);
  assert.deepEqual(items.map((t) => [t.toolCallId, t.durationMs, t.inProgress]), [
    ["live", 2000, false], ["msg", 0, false], ["none", undefined, false],
  ]);
});
