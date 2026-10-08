import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  formatChildMetadata,
  formatChildTokens,
  type ChildUsageMetadata,
} from "../src/panel/child-metadata.js";
import { CompactionEntry, ResetEntry, type SnapshotEvent } from "@earendil-works/pi-durable";
import { DurableTranscript } from "../src/panel/durable-transcript.js";
import { readTaskSessionFile } from "../src/panel/transcript.js";
import { subscribeSdkChildMetadata } from "../src/subagent/sdk-metadata.js";
import { createTaskWidgetController } from "../src/lifecycle/widget.js";
import type { BackgroundTask } from "../src/types.js";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { TaskTranscriptOverlay } from "../src/panel/task-transcript-overlay.js";

const zeroTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

test("child metadata matches Pi footer token, usage, cache-hit, and context formatting", () => {
  assert.deepEqual(
    [999, 1_000, 9_999, 10_000, 999_999, 1_000_000, 9_999_999, 10_000_000].map(formatChildTokens),
    ["999", "1.0k", "10.0k", "10k", "1000k", "1.0M", "10.0M", "10M"],
  );

  const metadata: ChildUsageMetadata = {
    usageTotals: { input: 98_000, output: 6_100, cacheRead: 2_900_000, cacheWrite: 0, cost: 0.544 },
    latestCacheHitRate: 99.5,
    contextUsage: { tokens: 85_680, contextWindow: 272_000 },
    usingSubscription: true,
    autoCompactionEnabled: true,
  };
  const display = formatChildMetadata(metadata);
  assert.equal(
    [...display.usage, display.context].join(" "),
    "↑98k ↓6.1k R2.9M CH99.5% $0.544 (sub) 31.5%/272k (auto)",
  );
  assert.equal(display.contextColor, undefined, "context below 70% has no warning color");
});

test("child TPS uses only the latest successful assistant response's authoritative duration", () => {
  const message = {
    role: "assistant", content: [{ type: "text", text: "answer" }],
    usage: usage(100, 80, 20, 0, 0.1), stopReason: "stop", durationMs: 2_000,
  };
  const entry = { id: "a1", conversationId: "c1", kind: "pi.assistant", model: [message] };
  const transcript = new DurableTranscript(durableSnapshot([entry] as never, message.usage));
  assert.equal(transcript.usageMetadata().latestTokensPerSecond, 40);
  assert.ok(formatChildMetadata(transcript.usageMetadata()).usage.includes("TPS 40.0"));
  const midGeneration = new DurableTranscript({
    ...durableSnapshot([entry] as never, message.usage),
    generation: { message: { ...message, durationMs: undefined } },
  } as unknown as SnapshotEvent);
  assert.equal(midGeneration.usageMetadata().latestTokensPerSecond, 40, "reattach during generation retains the last completed response's TPS");

  const dir = mkdtempSync(join(tmpdir(), "pi-task-child-tps-"));
  const file = join(dir, "child.jsonl");
  try {
    writeFileSync(file, JSON.stringify({ type: "message", id: "a1", parentId: null, message }) + "\n");
    assert.equal(readTaskSessionFile(file).childMetadata?.latestTokensPerSecond, 40);
    appendFileSync(file, JSON.stringify({
      type: "message", id: "tool", parentId: "a1",
      message: { role: "toolResult", content: "slow tool", durationMs: 60_000 },
    }) + "\n");
    assert.equal(readTaskSessionFile(file).childMetadata?.latestTokensPerSecond, 40, "tool time cannot dilute TPS");
    for (const patch of [{ durationMs: undefined }, { durationMs: 0 }, { durationMs: -1 },
      { durationMs: Number.NaN }, { stopReason: "aborted" }, { stopReason: "error" },
      { usage: { ...message.usage, output: 0 } }]) {
      const next = { ...message, ...patch };
      transcript.apply([{ type: "message_end", entry: { ...entry, model: [next] } } as never]);
      assert.equal(transcript.usageMetadata().latestTokensPerSecond, undefined);
      assert.ok(!formatChildMetadata(transcript.usageMetadata()).usage.some((part) => part.startsWith("TPS")));
    }
    appendFileSync(file, JSON.stringify({
      type: "message", id: "legacy", parentId: "tool", message: { ...message, durationMs: undefined },
    }) + "\n");
    assert.equal(readTaskSessionFile(file).childMetadata?.latestTokensPerSecond, undefined, "never reuse an older rate for an unmeasured response");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("child context colors use Pi's strict 70/90 percent boundaries and unknowns stay unknown", () => {
  const line = (tokens: number | null, contextWindow = 100): ReturnType<typeof formatChildMetadata> =>
    formatChildMetadata({ usageTotals: zeroTotals, contextUsage: { tokens, contextWindow } });

  assert.equal(line(70).context, "70.0%/100");
  assert.equal(line(70).contextColor, undefined, "exactly 70% is uncolored");
  assert.equal(line(71).contextColor, "warning");
  assert.equal(line(90).contextColor, "warning", "exactly 90% is warning, not error");
  assert.equal(line(91).contextColor, "error");
  assert.equal(line(null, 200_000).context, "?/200k", "compaction leaves context unknown until measured");
  assert.equal(line(null, 0).context, "?/?", "unknown model windows are not invented");
  assert.equal(line(0).context, "0.0%/100", "a measured zero is distinct from unknown");
});

function usage(input: number, output: number, cacheRead: number, cacheWrite: number, cost: number) {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

function durableSnapshot(entries: SnapshotEvent["entries"], totals: ReturnType<typeof usage>): SnapshotEvent {
  return {
    type: "snapshot",
    entries,
    tools: [],
    compactions: [],
    inbox: [],
    agent: { model: { provider: "openai", modelId: "child-model" } },
    usage: { models: { "openai/child-model": totals }, tools: {} },
  } as unknown as SnapshotEvent;
}

test("durable child metadata follows UsageState and assistant events; compaction/reset invalidate context only", () => {
  const assistant = (u: ReturnType<typeof usage>, stopReason = "stop") => ({
    role: "assistant",
    content: [{ type: "text", text: "answer" }],
    usage: u,
    stopReason,
  });
  const transcript = new DurableTranscript(durableSnapshot([
    { id: "a1", conversationId: "c1", kind: "pi.assistant", model: [assistant(usage(100, 10, 40, 5, 0.1))] },
  ] as never, usage(100, 10, 40, 5, 0.1)));
  const metadata = () => (transcript as unknown as { usageMetadata(): ChildUsageMetadata }).usageMetadata();

  assert.deepEqual(metadata().usageTotals, { input: 100, output: 10, cacheRead: 40, cacheWrite: 5, cost: 0.1 });
  assert.equal(metadata().latestCacheHitRate, 40 / 145 * 100);
  assert.deepEqual(metadata().contextUsage, { tokens: 145 });

  transcript.apply([{
    type: "message_update",
    usage: usage(200, 10, 100, 0, 0.2),
    changes: [],
  } as never]);
  assert.equal(metadata().latestCacheHitRate, 100 / 300 * 100, "cache-hit is from the latest assistant prompt, not cumulative totals");
  assert.deepEqual(metadata().contextUsage, { tokens: 300 }, "in-flight assistant usage updates current context");

  transcript.apply([{
    type: "usage_changed",
    usage: { models: { "openai/child-model": usage(350, 20, 150, 10, 0.3) }, tools: {} },
  } as never]);
  assert.deepEqual(metadata().usageTotals, { input: 350, output: 20, cacheRead: 150, cacheWrite: 10, cost: 0.3 }, "usage_changed replaces the cumulative ledger instead of double-counting it");

  transcript.apply([{ type: "compaction_start", taskId: "compact-1", reason: "threshold", blocking: true } as never]);
  assert.deepEqual(metadata().contextUsage, { tokens: null }, "context becomes unknown during compaction");
  assert.equal(metadata().usageTotals.cost, 0.3, "compaction does not erase cumulative spend");
  transcript.apply([{ type: "compaction_end", taskId: "compact-1", reason: "threshold" } as never]);
  assert.equal(metadata().contextUsage?.tokens, null, "compaction stays unknown until a new assistant measurement");

  transcript.apply([{
    type: "message_end",
    entry: {
      id: "a2", conversationId: "c1", kind: "pi.assistant",
      model: [assistant(usage(20, 3, 80, 0, 0.05))],
    },
  } as never]);
  assert.deepEqual(metadata().contextUsage, { tokens: 100 }, "post-compaction assistant usage restores measured context");
  assert.equal(metadata().usageTotals.cost, 0.3, "message events do not double-count the authoritative UsageState");

  transcript.apply([{
    type: "snapshot",
    entries: [
      { id: "old", conversationId: "c1", kind: "pi.assistant", model: [assistant(usage(10, 2, 5, 0, 0.02))] },
      { id: "reset", conversationId: "c1", kind: ResetEntry.kind },
    ],
    tools: [], compactions: [], inbox: [], agent: {},
    usage: { models: { "openai/child-model": usage(370, 25, 230, 10, 0.35) }, tools: {} },
  } as unknown as SnapshotEvent]);
  assert.deepEqual(metadata().contextUsage, { tokens: null }, "reset snapshots do not reuse pre-reset context");
  assert.equal(metadata().usageTotals.cost, 0.35, "reset preserves the new child's cumulative ledger");

  transcript.apply([{
    type: "snapshot",
    entries: [
      { id: "old", conversationId: "c1", kind: "pi.assistant", model: [assistant(usage(10, 2, 5, 0, 0.02))] },
      { id: "compact", conversationId: "c1", kind: CompactionEntry.kind },
    ],
    tools: [], compactions: [], inbox: [], agent: {},
    usage: { models: { "openai/child-model": usage(390, 27, 235, 10, 0.4) }, tools: {} },
  } as unknown as SnapshotEvent]);
  assert.equal(metadata().contextUsage?.tokens, null, "a persisted compaction boundary invalidates previous context");
});

test("cached Pi JSONL metadata uses cumulative session usage and invalidates context at compaction", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-task-child-metadata-jsonl-"));
  const file = join(dir, "child.jsonl");
  const assistant = (id: string, parentId: string, u: ReturnType<typeof usage>) => ({
    type: "message",
    id,
    parentId,
    message: { role: "assistant", content: [{ type: "text", text: id }], usage: u, stopReason: "stop" },
  });
  try {
    writeFileSync(file, [
      JSON.stringify({ type: "session", id: "child-session" }),
      JSON.stringify({ type: "model_change", id: "model", parentId: null, provider: "openai", modelId: "child" }),
      JSON.stringify(assistant("a1", "model", usage(1_000, 20, 500, 10, 0.2))),
      JSON.stringify(assistant("a2", "a1", usage(10, 2, 90, 0, 0.05))),
      JSON.stringify({
        type: "message", id: "tool-result", parentId: "a2",
        message: { role: "toolResult", toolCallId: "call", content: "ok", usage: usage(1, 2, 3, 4, 0.01) },
      }),
    ].join("\n") + "\n");

    const first = readTaskSessionFile(file) as ReturnType<typeof readTaskSessionFile> & { childMetadata?: ChildUsageMetadata };
    assert.deepEqual(first.childMetadata?.usageTotals, {
      input: 1_011, output: 24, cacheRead: 593, cacheWrite: 14, cost: 0.26,
    });
    assert.equal(first.childMetadata?.latestCacheHitRate, 90, "CH is from the last assistant usage, not lifetime cache totals");
    assert.deepEqual(first.childMetadata?.contextUsage, { tokens: 100 }, "current context counts prompt tokens, not generated output");

    appendFileSync(file, `${JSON.stringify({
      type: "compaction", id: "compact", parentId: "tool-result", usage: usage(30, 0, 0, 0, 0.03),
    })}\n`);
    const compacted = readTaskSessionFile(file) as typeof first;
    assert.deepEqual(compacted.childMetadata?.contextUsage, { tokens: null }, "pre-compaction context is not presented as current");
    assert.ok(Math.abs((compacted.childMetadata?.usageTotals.cost ?? 0) - 0.29) < 1e-9, "compaction cost remains in cumulative usage");

    appendFileSync(file, `${JSON.stringify(assistant("a3", "compact", usage(20, 4, 80, 0, 0.04)))}\n`);
    const resumed = readTaskSessionFile(file) as typeof first;
    assert.deepEqual(resumed.childMetadata?.contextUsage, { tokens: 100 }, "a post-compaction assistant response restores measured context");
    assert.equal(resumed.childMetadata?.latestCacheHitRate, 80);
    assert.ok(Math.abs((resumed.childMetadata?.usageTotals.cost ?? 0) - 0.33) < 1e-9);

    appendFileSync(file, `${JSON.stringify({ type: "context_edit", id: "edit", parentId: "a3" })}\n`);
    const edited = readTaskSessionFile(file) as typeof first;
    assert.deepEqual(edited.childMetadata?.contextUsage, { tokens: null }, "context edits invalidate the prior prompt measurement");
    appendFileSync(file, `${JSON.stringify(assistant("a4", "edit", usage(40, 2, 60, 0, 0.02)))}\n`);
    const measuredAgain = readTaskSessionFile(file) as typeof first;
    assert.deepEqual(measuredAgain.childMetadata?.contextUsage, { tokens: 100 }, "a later assistant response restores measured context");
    appendFileSync(file, `${JSON.stringify({ type: "reset", id: "reset", parentId: "a4" })}\n`);
    const reset = readTaskSessionFile(file) as typeof first;
    assert.deepEqual(reset.childMetadata?.contextUsage, { tokens: null }, "reset invalidates the current context again");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("overlay puts live child metadata between status and editor, updates live, and survives narrow resize", () => {
  let rows = 9;
  let metadata: ChildUsageMetadata = {
    usageTotals: { input: 1_000, output: 20, cacheRead: 900, cacheWrite: 0, cost: 0.02 },
    latestCacheHitRate: 98,
    contextUsage: { tokens: 1_900, contextWindow: 10_000 },
  };
  const pane = { render: () => ["child transcript"], scrollBy() {}, invalidate() {}, dispose() {} };
  const editor = {
    handleInput() {},
    render: () => [
      "editor top",
      "editor line 1",
      `cursor ${CURSOR_MARKER}`,
      "editor line 3",
      "editor bottom",
    ],
    getText: () => "",
    setText() {},
  };
  const host = {
    taskId: "child-only",
    onSteer() {},
    onClose() {},
    requestRender() {},
    context: () => ({
      taskId: "child-only", agentType: "reviewer", description: "inspect child",
      status: "running", phaseLabel: "Running review", elapsedMs: 1_000, toolUses: 2,
      backend: "sdk", cwd: "/tmp/child", model: "child-provider/child-model",
    }),
    childMetadata: () => metadata,
  };
  const overlay = new TaskTranscriptOverlay({
    pane,
    host,
    theme: null,
    editor,
    terminalRows: () => rows,
  } as never);
  const strip = (lines: string[]) => lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
  try {
    const first = strip(overlay.render(160));
    const statusIndex = first.findIndex((line) => line.includes("reviewer — inspect child"));
    const metadataIndex = first.findIndex((line) => line.includes("↑1.0k"));
    const editorIndex = first.findIndex((line) => line.includes("cursor"));
    const identityIndex = first.findIndex((line) => line.includes("#child-only"));
    assert.ok(statusIndex >= 0 && metadataIndex === statusIndex, `status and metadata share one row: ${first.join("\n")}`);
    assert.match(first[statusIndex]!, /reviewer — inspect child .* · ↑1\.0k/);
    assert.ok(editorIndex > metadataIndex, `metadata stays above the input: ${first.join("\n")}`);
    assert.ok(identityIndex > editorIndex, `identity footer stays below the input: ${first.join("\n")}`);
    assert.match(first[metadataIndex]!, /19\.0%\/10k/);
    assert.doesNotMatch(first.join("\n"), /parent-provider|parent-model/, "parent identity and stats never leak into the child line");

    metadata = {
      ...metadata,
      usageTotals: { ...metadata.usageTotals, input: 2_000, cost: 0.07 },
      contextUsage: { tokens: null, contextWindow: 10_000 },
    };
    overlay.invalidate();
    const updated = strip(overlay.render(160));
    assert.match(updated.join("\n"), /↑2.0k .* \$0.070 \?\/10k/, "live metadata changes repaint without a file reread");

    rows = 5;
    const narrow = strip(overlay.render(18));
    assert.equal(narrow.length, rows, "short resize still fills the terminal height");
    assert.ok(narrow.some((line) => line.includes("↑2.0k")), "short view retains the child metadata row");
    assert.ok(narrow.some((line) => line.includes("child transcript")), "the short view retains one transcript row when the chrome fits");
    assert.ok(narrow.some((line) => line.includes(CURSOR_MARKER)), "the editor cursor remains visible");
    assert.ok(narrow.every((line) => visibleWidth(line) <= 18), "narrow rows do not exceed terminal width");

    const historicalPane = { render: () => ["persisted child history"], scrollBy() {}, invalidate() {}, dispose() {} };
    overlay.openChildHistoryTranscript(historicalPane, {
      taskId: "child-history", agentType: "reviewer", description: "old child",
      sessionName: "old-session", status: "done", startedAt: 1,
    }, metadata);
    const historical = strip(overlay.render(72));
    const historicalTitle = historical.findIndex((line) => line.includes("Historical child transcript"));
    const historicalMetadata = historical.findIndex((line) => line.includes("↑2.0k"));
    assert.ok(historicalTitle >= 0 && historicalMetadata === historicalTitle, "historical title and metadata share one row");
    assert.match(historical[historicalMetadata]!, /\?\/10k/, "historical unknown context is not reconstructed or borrowed");
  } finally {
    overlay.dispose();
  }
});

test("SDK child metadata uses the child's runtime, refreshes per message, and invalidates on compaction", () => {
  let listener: ((event: any) => void) | undefined;
  let statsReads = 0;
  let context = { tokens: 18, contextWindow: 100, percent: 18 };
  let stats = {
    tokens: { input: 10, output: 2, cacheRead: 5, cacheWrite: 1 },
    cost: 0.01,
  };
  const session = {
    model: { provider: "kimi-coding", id: "sdk-child-model", contextWindow: 100 },
    modelRuntime: { isUsingSubscription: () => false },
    autoCompactionEnabled: false,
    isCompacting: false,
    getSessionStats() { statsReads++; return stats; },
    getContextUsage: () => context,
    subscribe(callback: (event: any) => void) { listener = callback; return () => { listener = undefined; }; },
  };
  const seen: ChildUsageMetadata[] = [];
  const unsubscribe = subscribeSdkChildMetadata(session as never, (metadata) => seen.push(metadata));

  assert.equal(seen.at(-1)?.model, "kimi-coding/sdk-child-model");
  assert.deepEqual(seen.at(-1)?.usageTotals, { input: 10, output: 2, cacheRead: 5, cacheWrite: 1, cost: 0.01 });
  assert.equal(seen.at(-1)?.usingSubscription, false, "a child runtime's explicit non-subscription signal is honored even for a known provider");
  assert.equal(seen.at(-1)?.autoCompactionEnabled, false, "disabled is not confused with unknown or enabled");

  listener?.({ type: "message_update", message: { role: "assistant", usage: usage(20, 1, 80, 0, 0.02) } });
  assert.equal(seen.at(-1)?.latestCacheHitRate, 80);
  assert.deepEqual(seen.at(-1)?.contextUsage, { tokens: 100, contextWindow: 100 }, "streamed prompt usage refreshes current child context");
  assert.equal(statsReads, 1, "partial renders do not trigger a full session stats scan");

  listener?.({ type: "compaction_start", reason: "threshold" });
  assert.deepEqual(seen.at(-1)?.contextUsage, { tokens: null, contextWindow: 100 });
  context = { tokens: null, contextWindow: 100, percent: null };
  listener?.({ type: "compaction_end", reason: "threshold", result: undefined, aborted: false, willRetry: false });
  assert.deepEqual(seen.at(-1)?.contextUsage, { tokens: null, contextWindow: 100 });

  context = { tokens: 100, contextWindow: 100, percent: 100 };
  stats = { tokens: { input: 30, output: 3, cacheRead: 100, cacheWrite: 0 }, cost: 0.04 };
  listener?.({ type: "message_end", message: { role: "assistant", usage: usage(30, 3, 100, 0, 0.04), stopReason: "stop", durationMs: 1_500 } });
  assert.equal(seen.at(-1)?.latestTokensPerSecond, 2, "SDK TPS measures only the completed response");
  assert.deepEqual(seen.at(-1)?.contextUsage, { tokens: 100, contextWindow: 100 }, "post-compaction response remeasures context");
  assert.equal(seen.at(-1)?.usageTotals.input, 30);
  assert.equal(statsReads, 2, "a completed message refreshes cumulative child session stats");

  listener?.({ type: "entry_appended", entry: { type: "context_edit" } });
  assert.deepEqual(seen.at(-1)?.contextUsage, { tokens: null, contextWindow: 100 }, "a child context edit cannot reuse the old measurement");

  unsubscribe();
  listener?.({ type: "message_update", message: { role: "assistant", usage: usage(1, 0, 0, 0, 0) } });
  assert.equal(seen.length, 6, "unsubscription stops metadata updates");
});

test("widget metadata stays attached to child A, resolves only A's model window, and live updates remain isolated", () => {
  initTheme();
  const makeTask = (id: string, cwd: string): BackgroundTask => ({
    agentType: "reviewer", sessionName: id, originalPane: null, description: id,
    startedAt: Date.now(), toolUses: 0, turns: 0, recentCalls: [], dir: "/tmp/artifacts",
    cwd, backend: "durable", status: "running",
  });
  let overlayFactory: ((tui: any, theme: any, keybindings: any, done: (result?: unknown) => void) => any) | undefined;
  const modelWindows = new Map([
    ["provider-a/child-a", 10_000],
    ["provider-b/child-b", 20_000],
  ]);
  const context: any = {
    mode: "tui",
    hasUI: true,
    cwd: "/work/parent",
    model: { provider: "parent-provider", id: "parent-model", contextWindow: 999_000 },
    modelRegistry: {
      find(provider: string, id: string) {
        const contextWindow = modelWindows.get(`${provider}/${id}`);
        return contextWindow ? { provider, id, contextWindow } : undefined;
      },
    },
    ui: {
      setWidget() {},
      getEditorComponent: () => undefined,
      setEditorComponent() {},
      notify() {},
      custom(factory: typeof overlayFactory) {
        overlayFactory = factory;
        return new Promise(() => {});
      },
    },
  };
  const taskA = makeTask("child-a", "/work/child-a");
  const taskB = makeTask("child-b", "/work/child-b");
  const controller = createTaskWidgetController(
    new Map([["child-a", taskA], ["child-b", taskB]]),
    new Map(),
  );
  controller.ensureTaskWidget(context);
  const metadataA: ChildUsageMetadata = {
    model: "provider-a/child-a",
    latestTokensPerSecond: 40,
    usageTotals: { input: 1_000, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
    contextUsage: { tokens: 5_000 },
  };
  const metadataB: ChildUsageMetadata = {
    model: "provider-b/child-b",
    usageTotals: { input: 18_000, output: 2_000, cacheRead: 900, cacheWrite: 0, cost: 0.5 },
    contextUsage: { tokens: 18_000 },
  };
  controller.setLiveTranscript("child-a", [], 0, { model: "provider-a/child-a" }, metadataA);
  controller.setLiveTranscript("child-b", [], 0, { model: "provider-b/child-b" }, metadataB);
  controller.openTaskView("child-a");
  assert.ok(overlayFactory, "controller opened the child transcript overlay");
  const overlay = overlayFactory!(
    { terminal: { rows: 12, columns: 90 }, requestRender() {} },
    { fg: (_token: string, text: string) => text, bg: (_token: string, text: string) => text },
    {},
    () => {},
  );
  const strip = () => overlay.render(90).join("\n").replace(/\x1b\[[0-9;]*m/g, "");

  try {
    const first = strip();
    assert.match(first, /↑1\.0k .*TPS 40\.0 .*50\.0%\/10k/, "child A forwards its own TPS and exact model context window");
    assert.doesNotMatch(first, /18k|20\.0k|90\.0%\/20k|999k/, "neither child B nor the parent session leaks into A's line");

    controller.setLiveTranscript(
      "child-b", [], 0, { model: "provider-b/child-b" }, {
        ...metadataB,
        usageTotals: { ...metadataB.usageTotals, input: 88_000 },
      },
    );
    assert.match(strip(), /↑1\.0k .*50\.0%\/10k/, "updates from child B do not change the viewed child A");

    controller.setLiveTranscript(
      "child-a", [], 0, { model: "provider-a/child-a" }, {
        ...metadataA,
        usageTotals: { ...metadataA.usageTotals, input: 2_000, cost: 0.02 },
        contextUsage: { tokens: null },
      },
    );
    assert.match(strip(), /↑2\.0k .*\$0\.020 .*\?\/10k/, "child A's new metadata appears without scanning parent or sibling state");
  } finally {
    controller.dispose();
  }
});

test("Pi child JSONL stats are signature-cached between renders and refresh when the child file grows", () => {
  initTheme();
  const dir = mkdtempSync(join(tmpdir(), "pi-task-child-metadata-panel-jsonl-"));
  const file = join(dir, "child.jsonl");
  const modelRef = { type: "model_change", id: "model", parentId: null, provider: "provider-child", modelId: "child-model" };
  const assistantEntry = (id: string, parentId: string, u: ReturnType<typeof usage>) => ({
    type: "message", id, parentId,
    message: { role: "assistant", content: [{ type: "text", text: id }], usage: u, stopReason: "stop" },
  });
  const task: BackgroundTask = {
    agentType: "reviewer", sessionName: "jsonl-child", originalPane: null, description: "jsonl child",
    startedAt: Date.now(), toolUses: 0, turns: 0, recentCalls: [], dir,
    cwd: "/work/jsonl-child", backend: "sdk", status: "running", sessionPath: file,
  };
  let overlayFactory: ((tui: any, theme: any, keybindings: any, done: (result?: unknown) => void) => any) | undefined;
  const context: any = {
    mode: "tui", hasUI: true, cwd: "/work/parent",
    model: { provider: "parent-provider", id: "parent-model", contextWindow: 999_000 },
    modelRegistry: { find: () => ({ contextWindow: 10_000 }) },
    ui: {
      setWidget() {}, getEditorComponent: () => undefined, setEditorComponent() {}, notify() {},
      custom(factory: typeof overlayFactory) { overlayFactory = factory; return new Promise(() => {}); },
    },
  };
  writeFileSync(file, [
    JSON.stringify({ type: "session", id: "jsonl-child-session", cwd: task.cwd }),
    JSON.stringify({ type: "session_info", name: task.sessionName }),
    JSON.stringify(modelRef),
    JSON.stringify(assistantEntry("a1", "model", usage(1_000, 10, 900, 0, 0.1))),
    JSON.stringify(assistantEntry("a2", "a1", usage(100, 5, 900, 0, 0.2))),
  ].join("\n") + "\n");
  const controller = createTaskWidgetController(new Map(), new Map([["jsonl-child", task]]));
  controller.ensureTaskWidget(context);
  controller.openTaskView("jsonl-child");
  const overlay = overlayFactory!(
    { terminal: { rows: 12, columns: 90 }, requestRender() {} },
    { fg: (_token: string, text: string) => text, bg: (_token: string, text: string) => text },
    {},
    () => {},
  );
  const strip = () => overlay.render(90).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  try {
    const initial = strip();
    assert.match(initial, /↑1\.1k .*CH90\.0% \$0\.300 10\.0%\/10k/, "live stats come from this child's exact JSONL and latest assistant");
    assert.doesNotMatch(initial, /999k|parent-model/, "the parent model is not a context-window fallback");
    strip(); // unchanged signature: cached parse result is reused

    appendFileSync(file, `${JSON.stringify(assistantEntry("a3", "a2", usage(200, 5, 800, 0, 0.3)))}\n`);
    const grown = strip();
    assert.match(grown, /↑1\.3k .*CH80\.0% \$0\.600 10\.0%\/10k/, "a child JSONL signature change refreshes cumulative/latest stats");
  } finally {
    controller.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("subscription and auto badges require explicit child signals and zero usage stays quiet", () => {
  const unknown = formatChildMetadata({ usageTotals: zeroTotals, contextUsage: { tokens: null, contextWindow: 200_000 } });
  assert.deepEqual(unknown.usage, [], "zero totals do not invent token or cost statistics");
  assert.equal(unknown.context, "?/200k");

  const proven = formatChildMetadata({
    usageTotals: zeroTotals,
    contextUsage: { tokens: null, contextWindow: 200_000 },
    usingSubscription: true,
    autoCompactionEnabled: true,
  });
  assert.deepEqual(proven.usage, ["$0.000 (sub)"]);
  assert.equal(proven.context, "?/200k (auto)");
});
