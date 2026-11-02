import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationView, EntryRecord, LiveState } from "@earendil-works/pi-durable";
import { DurableTranscript } from "../src/panel/durable-transcript.js";
import { MAX_TRANSCRIPT_ITEMS } from "../src/panel/transcript.js";

/**
 * pi-durable 1.5 replaced the per-commit event stream with conversation views:
 * `DurableTranscript` now folds state. These fixtures build the view a harness
 * would hand over — a window of entries plus the `pi.live` / `pi.agent` /
 * `pi.usage` documents — so each test still asserts the rendered CONTENT.
 */
function makeView(
  entries: readonly EntryRecord[] = [],
  live: LiveState = {},
  agent: Record<string, unknown> = {},
): ConversationView {
  return {
    conversation: { id: 1 } as ConversationView["conversation"],
    entries,
    docs: {
      "pi.agent": agent as never,
      "pi.live": live as never,
      "pi.usage": { models: {}, tools: {} } as never,
    },
  };
}

function entry(id: number, message: unknown): EntryRecord {
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
  const transcript = new DurableTranscript(makeView([
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
    entry(4, assistant([{ type: "text", text: "Done." }])),
  ]));

  const items = transcript.items();
  assert.deepEqual(items.map((item) => item.type), ["user", "assistant", "tool", "assistant"]);
  assert.equal(items[0]?.type === "user" ? items[0].text : "", "Inspect the file.");
  assert.equal(items[1]?.type === "assistant" ? items[1].text : "", "I will read it.");
  assert.equal(items[1]?.type === "assistant" ? items[1].thinking : undefined, "Check first.");
  const tool = items[2];
  assert.equal(tool?.type === "tool" ? tool.result : undefined, "File contents.");
  assert.equal(tool?.type === "tool" ? tool.inProgress : true, false);
  assert.deepEqual(tool?.type === "tool" ? tool.args : undefined, { path: "src/a.ts" });
  assert.equal(transcript.toolCallCount(), 1);
});

test("durable transcript exposes the child's own agent state", () => {
  const transcript = new DurableTranscript(makeView([], {}, {
    model: { provider: "anthropic", modelId: "claude-sonnet-4" },
    thinkingLevel: "high",
    cwd: "/repo",
  }));
  assert.deepEqual(transcript.agentState(), {
    model: "anthropic/claude-sonnet-4",
    thinkingLevel: "high",
    cwd: "/repo",
  });

  // An empty agent state means the harness has none: nothing is invented.
  transcript.apply(makeView([], {}, {}));
  assert.deepEqual(transcript.agentState(), {});
});

test("durable transcript reflects a running tool, partial output, and its final result", () => {
  const transcript = new DurableTranscript(makeView([], {
    tools: [{ callId: "call-bash", name: "bash", status: "running", output: "/repo" }],
  }));

  assert.equal(transcript.toolCallCount(), 1);
  let tool = transcript.items()[0];
  assert.equal(tool?.type, "tool");
  if (tool?.type === "tool") {
    assert.equal(tool.inProgress, true);
    assert.equal(tool.result, "/repo");
  }

  // The call settles into a toolResult entry; the slot leaves pi.live.
  transcript.apply(makeView([
    entry(1, assistant([
      { type: "toolCall", id: "call-bash", name: "bash", arguments: { command: "pwd" } },
    ])),
    entry(2, {
      role: "toolResult",
      toolCallId: "call-bash",
      toolName: "bash",
      content: [{ type: "text", text: "Directory listing." }],
      isError: false,
    }),
  ]));
  tool = transcript.items().find((item) => item.type === "tool");
  assert.equal(tool?.type === "tool" ? tool.inProgress : true, false);
  assert.equal(tool?.type === "tool" ? tool.result : undefined, "Directory listing.");
  assert.deepEqual(tool?.type === "tool" ? tool.args : undefined, { command: "pwd" });
});

test("durable transcript counts live tool calls without execution-start and closes empty results", () => {
  const transcript = new DurableTranscript(makeView([
    entry(1, assistant([
      { type: "toolCall", id: "call-empty", name: "read", arguments: {} },
    ])),
    entry(2, {
      role: "toolResult",
      toolCallId: "call-empty",
      toolName: "read",
      content: [],
      isError: false,
    }),
  ]));

  const tool = transcript.items().find((item) => item.type === "tool");
  assert.equal(transcript.toolCallCount(), 1);
  assert.equal(tool?.type === "tool" ? tool.inProgress : true, false);
  assert.equal(tool?.type === "tool" ? tool.result : undefined, undefined);
});

test("durable transcript counts and finalizes a tool call seen only as a done slot", () => {
  const transcript = new DurableTranscript(makeView([], {
    tools: [{ callId: "call-end-only", name: "read", status: "done" }],
  }));

  const tool = transcript.items().find((item) => item.type === "tool");
  assert.equal(transcript.toolCallCount(), 1);
  assert.equal(tool?.type === "tool" ? tool.inProgress : true, false);
});

test("durable transcript renders the streamed partial answer", () => {
  const transcript = new DurableTranscript(makeView([], {
    generation: { attempt: 1, message: assistant([{ type: "text", text: "I am working." }]) },
  }));

  const item = transcript.items()[0];
  assert.equal(item?.type === "assistant" ? item.text : "", "I am working.");
  assert.equal(item?.type === "assistant" ? item.streaming : undefined, true);

  // The settled answer arrives as an entry and replaces the partial in place.
  transcript.apply(makeView([entry(1, assistant([{ type: "text", text: "I am done." }]))]));
  const items = transcript.items();
  assert.equal(items.length, 1, "the partial is replaced, not duplicated");
  assert.equal(items[0]?.type === "assistant" ? items[0].text : "", "I am done.");
  assert.equal(items[0]?.type === "assistant" ? items[0].streaming : undefined, undefined);
});

test("durable transcript does not recount a pending snapshot tool when execution starts", () => {
  const transcript = new DurableTranscript(makeView(
    [
      entry(1, assistant([
        { type: "toolCall", id: "call-awaiting-slot", name: "read", arguments: {} },
      ])),
    ],
    { tools: [{ callId: "call-awaiting-slot", name: "read", status: "pending" }] },
  ));
  assert.equal(transcript.toolCallCount(), 1);

  transcript.apply(makeView([
    entry(1, assistant([
      { type: "toolCall", id: "call-awaiting-slot", name: "read", arguments: {} },
    ])),
  ], { tools: [{ callId: "call-awaiting-slot", name: "read", status: "running" }] }));

  assert.equal(transcript.toolCallCount(), 1);
});

test("durable transcript deduplicates a toolcall entry awaiting its live slot", () => {
  const transcript = new DurableTranscript(makeView([
    entry(1, assistant([
      { type: "toolCall", id: "call-awaiting-slot", name: "read", arguments: {} },
    ])),
  ]));
  assert.equal(transcript.toolCallCount(), 1);

  transcript.apply(makeView([
    entry(1, assistant([
      { type: "toolCall", id: "call-awaiting-slot", name: "read", arguments: {} },
    ])),
  ], { tools: [{ callId: "call-awaiting-slot", name: "read", status: "running" }] }));

  assert.equal(transcript.toolCallCount(), 1);
});

test("durable transcript tracks only unresolved snapshot toolcalls beyond the display window", () => {
  const callIds = Array.from(
    { length: MAX_TRANSCRIPT_ITEMS + 1 },
    (_, index) => `call-${index}`,
  );
  const entries: EntryRecord[] = [];
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
  const transcript = new DurableTranscript(makeView(entries));

  assert.equal(transcript.items().length, MAX_TRANSCRIPT_ITEMS);
  assert.equal(transcript.toolCallCount(), callIds.length);

  // A later revision that re-announces a call already counted stays counted once.
  transcript.apply(makeView(entries, {
    tools: [{ callId: callIds[0]!, name: "read", status: "running" }],
  }));
  assert.equal(transcript.toolCallCount(), callIds.length);
});

test("durable transcript deduplicates a toolcall in the current generation", () => {
  const view = makeView(
    [entry(1, assistant([
      { type: "toolCall", id: "call-generating", name: "read", arguments: {} },
    ]))],
    { generation: { attempt: 1, message: assistant([]) } },
  );
  const transcript = new DurableTranscript(view as never);
  assert.equal(transcript.toolCallCount(), 1);

  transcript.apply(makeView([
    entry(1, assistant([
      { type: "toolCall", id: "call-generating", name: "read", arguments: {} },
    ])),
  ], { tools: [{ callId: "call-generating", name: "read", status: "running" }] }));
  assert.equal(transcript.toolCallCount(), 1);
});

test("durable transcript keeps cumulative tool-call totals across later windows", () => {
  const initialEntries = Array.from({ length: 5 }, (_, index) =>
    entry(index, assistant([
      { type: "toolCall", id: `call-${index}`, name: "read", arguments: { index } },
    ])),
  );
  const transcript = new DurableTranscript(makeView(initialEntries));
  assert.equal(transcript.toolCallCount(), 5);

  // A compaction drops the earlier entries from the window; the total is
  // cumulative and must not shrink with it.
  const compactedView = makeView([
    entry(4, assistant([
      { type: "toolCall", id: "call-4", name: "read", arguments: { index: 4 } },
    ])),
  ]);
  transcript.apply(compactedView);
  assert.equal(transcript.toolCallCount(), 5);
});

test("durable transcript keeps cumulative tool-call totals after trimming displayed history", () => {
  const entries = Array.from({ length: 205 }, (_, index) => [
    entry(index * 2, { role: "user", content: [{ type: "text", text: `Task ${index}` }] }),
    entry(index * 2 + 1, assistant([
      { type: "toolCall", id: `call-${index}`, name: "read", arguments: { index } },
    ])),
  ]).flat();
  const transcript = new DurableTranscript(makeView(entries));

  assert.equal(transcript.items().length, MAX_TRANSCRIPT_ITEMS);
  assert.equal(transcript.items().filter((item) => item.type === "tool").length, 200);
  assert.equal(transcript.toolCallCount(), 205);
});

test("durable transcript keeps distinct assistant text and thinking blocks", () => {
  const transcript = new DurableTranscript(makeView([], {
    generation: {
      attempt: 1,
      message: assistant([
        { type: "text", text: "First block updated" },
        { type: "text", text: "Second block" },
        { type: "thinking", thinking: "First thought" },
        { type: "thinking", thinking: "Second thought" },
      ]),
    },
  }));

  const item = transcript.items()[0];
  assert.equal(
    item?.type === "assistant" ? item.text : "",
    "First block updated\nSecond block",
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

test("durable view projects toolResult durationMs, paired and unpaired", () => {
  const transcript = new DurableTranscript(makeView([
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

test("durable view settles a tool through its result entry with durationMs", () => {
  const transcript = new DurableTranscript(makeView(
    [entry(1, toolResultMessage("live", { durationMs: 2000 }))],
    { tools: [{ callId: "live", name: "bash", status: "running", output: "partial" }] },
  ));
  // The live slot's retained output is the running view of a call whose result
  // entry already carries the settled text and timing.
  const items = toolItems(transcript);
  assert.deepEqual(items.map((t) => [t.toolCallId, t.durationMs, t.inProgress]), [
    ["live", 2000, false],
  ]);

  transcript.apply(makeView(
    [entry(1, toolResultMessage("live", { durationMs: 2000 })),
      entry(2, toolResultMessage("msg", { durationMs: 0 }))],
    { tools: [{ callId: "msg", name: "bash", status: "done" }] },
  ));
  assert.deepEqual(toolItems(transcript).map((t) => [t.toolCallId, t.durationMs, t.inProgress]), [
    ["live", 2000, false], ["msg", 0, false],
  ]);
});

test("durable view renders a run that ended without an answer once", () => {
  const run = { taskId: 7, inputs: [3], turns: 0 };
  // Attach while the run is live, then let it end without an answer.
  const transcript = new DurableTranscript(makeView([], { run } as LiveState));
  assert.deepEqual(
    transcript.items().filter((item) => item.type === "system").map((item) => item.text),
    [],
    "a run in flight renders nothing",
  );

  const failure = { taskId: 7, inputs: [3], reason: "model_error" as const, detail: "boom" };
  transcript.apply(makeView([], { runFailure: failure } as LiveState));
  assert.deepEqual(
    transcript.items().filter((item) => item.type === "system").map((item) => item.text),
    ["Task failed: model_error (boom)"],
  );

  // pi.live keeps runFailure until a later run starts; it must not re-render.
  transcript.apply(makeView([], { runFailure: failure } as LiveState));
  assert.equal(transcript.items().filter((item) => item.type === "system").length, 1);

  // History hydration seeds the failure without rendering it: it predates the view.
  const hydrated = new DurableTranscript(makeView([], { runFailure: failure } as LiveState));
  assert.equal(hydrated.items().filter((item) => item.type === "system").length, 0);
});
