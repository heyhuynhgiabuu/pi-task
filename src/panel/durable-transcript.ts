import type {
  AgentState,
  ConversationView,
  EntryRecord,
  LiveState,
  ToolSlot,
  UsageState,
} from "@earendil-works/pi-durable";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { ChildHistoryOption } from "../types.js";
import { childRunTokensPerSecond, createChildTpsRun, sumAssistantOutputTokens, type ChildUsageMetadata } from "./child-metadata.js";
import { MAX_TRANSCRIPT_ITEMS, authoritativeDurationMs, type TranscriptItem } from "./transcript.js";

// Persisted pi-durable entry kinds (entries.ts). Keep runtime imports out of
// this always-loaded transcript adapter; the durable peer is optional.
const COMPACTION_ENTRY_KIND = "pi.compaction";
const RESET_ENTRY_KIND = "pi.reset";

type ToolTranscriptItem = Extract<TranscriptItem, { type: "tool" }>;
type AssistantTranscriptItem = Extract<TranscriptItem, { type: "assistant" }>;
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function usageParts(value: unknown): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
} | undefined {
  if (!isRecord(value) || !isRecord(value.cost)) return undefined;
  const fields = [value.input, value.output, value.cacheRead, value.cacheWrite, value.cost.total];
  if (!fields.every((field) => typeof field === "number" && Number.isFinite(field) && field >= 0)) {
    return undefined;
  }
  return {
    input: value.input as number,
    output: value.output as number,
    cacheRead: value.cacheRead as number,
    cacheWrite: value.cacheWrite as number,
    cost: value.cost.total as number,
  };
}

function addUsage(
  total: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number },
  value: unknown,
): void {
  const usage = usageParts(value);
  if (!usage) return;
  total.input += usage.input;
  total.output += usage.output;
  total.cacheRead += usage.cacheRead;
  total.cacheWrite += usage.cacheWrite;
  total.cost += usage.cost;
}

/**
 * Tool-defined render data (pi's `ToolResultMessage.details` / `ToolSlot.details`).
 * Pi's per-tool renderers read it directly — `edit` draws `details.diff` — so it
 * must survive the projection exactly as it was stored.
 */
function toolDetails(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function parseContentBlock(value: unknown): ContentBlock | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === "text" && typeof value.text === "string") {
    return { type: "text", text: value.text };
  }
  if (value.type === "thinking" && typeof value.thinking === "string") {
    return { type: "thinking", thinking: value.thinking };
  }
  if (value.type === "toolCall" && typeof value.id === "string" && value.id) {
    return {
      type: "toolCall",
      id: value.id,
      name: typeof value.name === "string" ? value.name : "tool",
      arguments: isRecord(value.arguments) ? value.arguments : {},
    };
  }
  return undefined;
}

function contentBlocks(content: unknown): ContentBlock[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    const parsed = parseContentBlock(block);
    return parsed ? [parsed] : [];
  });
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  return contentBlocks(content)
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function thinkingContent(content: unknown): string | undefined {
  const text = contentBlocks(content)
    .filter((block): block is Extract<ContentBlock, { type: "thinking" }> => block.type === "thinking")
    .map((block) => block.thinking)
    .join("\n")
    .trim();
  return text || undefined;
}

function timestampOf(message: Message): string {
  return typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
    ? new Date(message.timestamp).toISOString()
    : "";
}

function asAssistant(
  message: Message,
  streaming = false,
): AssistantTranscriptItem | undefined {
  if (message.role !== "assistant") return undefined;
  const thinking = thinkingContent(message.content);
  return {
    type: "assistant",
    text: textContent(message.content),
    ...(thinking ? { thinking } : {}),
    ...(streaming ? { streaming: true } : {}),
    timestamp: timestampOf(message),
  };
}

function toolCall(block: ContentBlock, timestamp: string): ToolTranscriptItem | undefined {
  if (block.type !== "toolCall" || typeof block.id !== "string" || !block.id) {
    return undefined;
  }
  return {
    type: "tool",
    name: typeof block.name === "string" ? block.name : "tool",
    toolCallId: block.id,
    args: isRecord(block.arguments) ? block.arguments : {},
    timestamp,
    inProgress: true,
  };
}

/**
 * The child conversation's own agent state (`pi.agent`): the model, thinking
 * level, and cwd the harness actually runs the child with. Absent fields mean
 * the harness has none configured, so the panel must not invent them.
 */
export interface DurableChildAgent {
  /** `provider/modelId`. */
  model?: string;
  thinkingLevel?: string;
  cwd?: string;
}

/** Read-only durable task history hydration; contains no lifecycle controls. */
export interface DurableChildHistoryTranscript {
  option: ChildHistoryOption;
  items: TranscriptItem[];
  agent: DurableChildAgent;
  metadata?: ChildUsageMetadata;
}

/**
 * Projects pi-durable conversation *views* into the task panel's transcript
 * format. pi-durable 1.5 removed the per-commit event stream: a renderer now
 * renders state, so `apply` folds one view revision at a time — new entries by
 * entry ID, then the partial answer and tool slots of `pi.live`.
 *
 * Item objects are reused when their content did not change: the pane caches a
 * component per item in a WeakMap (task-pane.ts), so rebuilding an unchanged
 * item would re-render the pane on every commit.
 */
export class DurableTranscript {
  private transcript: TranscriptItem[] = [];
  private toolIndexes = new Map<string, number>();
  private countedToolCalls = new Set<string>();
  private toolCallTotal = 0;
  private agent: DurableChildAgent = {};
  private usageState: UsageState = { models: {}, tools: {} };
  private latestCacheHitRate: number | undefined;
  private latestTokensPerSecond: number | undefined;
  private tpsRun = createChildTpsRun();
  private tpsRunning = false;
  /** A run already under way at the first view has no observed start, so its rate is never published. */
  private tpsUntimed = false;
  /** Assistant output the current run produced, accumulated as its entries are projected. */
  private tpsRunOutput = 0;
  private contextTokens: number | null = null;
  private compactionInProgress = false;
  private partialAssistantIndex: number | undefined;
  /** Entries already projected; the window appends, so a view only adds its tail. */
  private projectedEntries = new Set<EntryRecord["id"]>();
  /** Whether any view has been folded yet; an empty first view must not be mistaken for no view. */
  private viewed = false;
  /** Failures already rendered as a system item; `pi.live` keeps them after the run ends. */
  private renderedFailures = new Set<string>();

  constructor(
    view: ConversationView,
    private readonly now: () => number = Date.now,
  ) {
    this.apply(view);
  }

  items(): TranscriptItem[] {
    return [...this.transcript];
  }

  toolCallCount(): number {
    return this.toolCallTotal;
  }

  /** The child's own agent state, for the panel's child status/footer. */
  agentState(): DurableChildAgent {
    return { ...this.agent };
  }

  /** Cumulative child usage plus the most recently measured prompt context. */
  usageMetadata(): ChildUsageMetadata {
    const usageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    for (const usage of Object.values(this.usageState.models ?? {})) addUsage(usageTotals, usage);
    for (const usage of Object.values(this.usageState.tools ?? {})) addUsage(usageTotals, usage);
    return {
      ...(this.agent.model === undefined ? {} : { model: this.agent.model }),
      usageTotals,
      ...(this.latestCacheHitRate === undefined
        ? {}
        : { latestCacheHitRate: this.latestCacheHitRate }),
      ...(this.latestTokensPerSecond === undefined ? {} : { latestTokensPerSecond: this.latestTokensPerSecond }),
      contextUsage: { tokens: this.contextTokens },
    };
  }

  /** Fold one conversation-view revision into the transcript. */
  apply(view: ConversationView): TranscriptItem[] {
    const live = (view.docs["pi.live"] ?? {}) as LiveState;
    const firstView = !this.viewed;
    this.viewed = true;
    this.setAgentState(view.docs["pi.agent"] as AgentState | undefined);
    this.usageState = (view.docs["pi.usage"] as UsageState | undefined) ?? { models: {}, tools: {} };
    this.observeCompaction(live);
    // A run's entries and its end can arrive in one folded callback, so the
    // clock opens before the entries are projected and closes after them.
    this.observeRunStart(live, firstView, view.entries);
    for (const entry of view.entries) this.observeEntry(entry);
    // Drop what has left the window, so the set tracks the window and not the
    // whole conversation.
    if (this.projectedEntries.size > 2 * MAX_TRANSCRIPT_ITEMS) {
      this.projectedEntries = new Set(view.entries.map((entry) => entry.id));
    }
    this.observeGeneration(live);
    for (const slot of live.tools ?? []) this.observeToolSlot(slot);
    this.observeFailure(live.runFailure, firstView);
    this.observeRunEnd(live);
    this.trim();
    return this.items();
  }

  /**
   * A run starts when `pi.live.run` appears; 1.5 keeps `runFailure` after a
   * failed run, so idleness is `run === undefined` and never an empty object.
   */
  private observeRunStart(live: LiveState, firstView: boolean, entries: readonly EntryRecord[]): void {
    if (live.run === undefined || this.tpsRunning) return;
    this.tpsRunning = true;
    this.tpsRunOutput = 0;
    // `pi.live.run.first` names the run's first entry, so a run that committed
    // entries before this view observed it still counts their output. Entries
    // not projected yet are added as `observeEntry` reaches them.
    const runFirst = live.run.first;
    if (runFirst !== undefined) {
      for (const entry of entries) {
        if (entry.id >= runFirst && this.projectedEntries.has(entry.id)) {
          this.tpsRunOutput += sumAssistantOutputTokens(entry.model ?? []);
        }
      }
    }
    // A run already in flight at the first view has no observed start.
    this.tpsUntimed = firstView;
    this.tpsRun = createChildTpsRun();
    if (!firstView) this.tpsRun.start(this.now());
  }

  private observeRunEnd(live: LiveState): void {
    if (live.run !== undefined || !this.tpsRunning) return;
    this.tpsRunning = false;
    const measurement = this.tpsUntimed ? undefined : this.tpsRun.end(this.now());
    this.tpsUntimed = false;
    // A run with no observed start, or one that produced nothing, has no rate.
    const rate = measurement && childRunTokensPerSecond({ ...measurement, output: this.tpsRunOutput });
    if (typeof rate === "number") this.latestTokensPerSecond = rate;
  }

  private observeCompaction(live: LiveState): void {
    const compacting = (live.compactions?.length ?? 0) > 0;
    if (compacting !== this.compactionInProgress) {
      this.compactionInProgress = compacting;
      this.contextTokens = null;
    }
  }

  /** Project an entry not seen before; the window appends and only drops its oldest. */
  private observeEntry(entry: EntryRecord): void {
    if (this.projectedEntries.has(entry.id)) return;
    this.projectedEntries.add(entry.id);
    if (entry.kind === COMPACTION_ENTRY_KIND || entry.kind === RESET_ENTRY_KIND) {
      // A persisted compaction/reset boundary invalidates the measured context.
      this.contextTokens = null;
      return;
    }
    for (const message of entry.model ?? []) {
      this.observeMessageMetadata(message);
      this.appendMessage(message);
    }
    // Only entries projected from here on are new to this run's total.
    if (this.tpsRunning) this.tpsRunOutput += sumAssistantOutputTokens(entry.model ?? []);
  }

  /** The in-flight answer: the generation's committed partial, or nothing once it settles into an entry. */
  private observeGeneration(live: LiveState): void {
    const message = live.generation?.message as unknown as AssistantMessage | undefined;
    if (message === undefined) {
      if (this.partialAssistantIndex !== undefined) {
        this.transcript.splice(this.partialAssistantIndex, 1);
        this.partialAssistantIndex = undefined;
        this.rebuildIndexes();
      }
      return;
    }
    if (!this.compactionInProgress) this.observeAssistantUsage(message.usage);
    this.writePartialAssistant(message);
  }

  private observeToolSlot(slot: ToolSlot): void {
    const details = toolDetails(slot.details);
    this.setTool({
      type: "tool",
      name: slot.name,
      toolCallId: slot.callId,
      args: {},
      ...(slot.output === undefined ? {} : { result: slot.output }),
      ...(details === undefined ? {} : { details }),
      timestamp: "",
      inProgress: slot.status !== "done",
    });
  }

  /**
   * `pi.live` keeps a run that ended without an answer, so render each failure
   * once rather than on every later view. A first view is history: the failure
   * predates it, so it is recorded without being rendered.
   */
  private observeFailure(failure: LiveState["runFailure"], firstView: boolean): void {
    if (failure === undefined) return;
    const key = `${failure.taskId}\u0000${failure.reason}`;
    if (this.renderedFailures.has(key)) return;
    this.renderedFailures.add(key);
    if (firstView) return;
    const detail = failure.detail === undefined ? "" : ` (${failure.detail})`;
    this.transcript.push({ type: "system", text: `Task failed: ${failure.reason}${detail}`, timestamp: "" });
  }

  private setAgentState(state: AgentState | undefined): void {
    const modelId = typeof state?.model?.modelId === "string" ? state.model.modelId : undefined;
    const provider = typeof state?.model?.provider === "string" ? state.model.provider : undefined;
    this.agent = {
      ...(modelId ? { model: provider ? `${provider}/${modelId}` : modelId } : {}),
      ...(typeof state?.thinkingLevel === "string"
        ? { thinkingLevel: state.thinkingLevel }
        : {}),
      ...(typeof state?.cwd === "string" ? { cwd: state.cwd } : {}),
    };
  }

  private observeMessageMetadata(message: Message): void {
    if (message.role === "assistant") {
      this.observeAssistantUsage(message.usage, message.stopReason);
    }
  }

  private observeAssistantUsage(value: unknown, stopReason?: string): void {
    if (this.compactionInProgress) return;
    const usage = usageParts(value);
    if (!usage) return;
    const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
    this.latestCacheHitRate = promptTokens > 0
      ? (usage.cacheRead / promptTokens) * 100
      : undefined;
    if (promptTokens > 0 && stopReason !== "aborted" && stopReason !== "error") {
      this.contextTokens = promptTokens;
    }
  }

  private appendMessage(message: Message): void {
    const timestamp = timestampOf(message);
    if (message.role === "user") {
      const text = textContent(message.content);
      if (text) this.transcript.push({ type: "user", text, timestamp });
      return;
    }
    if (message.role === "assistant") {
      const assistant = asAssistant(message)!;
      if (assistant.text || assistant.thinking) {
        if (this.partialAssistantIndex !== undefined) {
          // The settled answer supersedes the streamed partial in place.
          this.transcript[this.partialAssistantIndex] = assistant;
          this.partialAssistantIndex = undefined;
        } else {
          this.transcript.push(assistant);
        }
      } else if (this.partialAssistantIndex !== undefined) {
        this.transcript.splice(this.partialAssistantIndex, 1);
        this.partialAssistantIndex = undefined;
        this.rebuildIndexes();
      }
      for (const block of contentBlocks(message.content)) {
        const item = toolCall(block, timestamp);
        if (item) this.setTool(item);
      }
      return;
    }
    if (message.role === "toolResult") {
      const details = toolDetails(message.details);
      const durationMs = authoritativeDurationMs(message.durationMs);
      this.setTool({
        type: "tool",
        name: message.toolName || "tool",
        toolCallId: message.toolCallId,
        args: {},
        ...(details === undefined ? {} : { details }),
        ...(durationMs === undefined ? {} : { durationMs }),
        result: textContent(message.content) || undefined,
        isError: Boolean(message.isError),
        timestamp,
        inProgress: false,
      });
    }
  }

  private writePartialAssistant(message: AssistantMessage): void {
    const assistant = asAssistant(message, true);
    if (!assistant) return;
    if (this.partialAssistantIndex === undefined) {
      this.partialAssistantIndex = this.transcript.length;
      this.transcript.push(assistant);
    } else {
      this.transcript[this.partialAssistantIndex] = assistant;
    }
    for (const block of contentBlocks(message.content)) {
      const item = toolCall(block, assistant.timestamp);
      if (item) this.setTool(item);
    }
  }

  /**
   * Insert or update the item of one tool call. The live slot carries running
   * output and details; the settled toolResult entry carries the final result,
   * so a later slot projection never erases what the entry established.
   */
  private setTool(item: ToolTranscriptItem): void {
    if (!this.countedToolCalls.has(item.toolCallId)) {
      this.countedToolCalls.add(item.toolCallId);
      this.toolCallTotal++;
    }
    const index = this.toolIndexes.get(item.toolCallId);
    if (index === undefined) {
      this.toolIndexes.set(item.toolCallId, this.transcript.length);
      this.transcript.push(item);
      return;
    }
    const current = this.transcript[index];
    if (current?.type !== "tool") return;
    const merged: ToolTranscriptItem = {
      ...current,
      ...item,
      args: Object.keys(item.args).length > 0 ? item.args : current.args,
      details: item.details ?? current.details,
      durationMs: item.durationMs ?? current.durationMs,
      result: item.result ?? current.result,
      isError: item.isError ?? current.isError,
      // A settled call never returns to running.
      inProgress: current.inProgress === false ? false : item.inProgress,
    };
    if (sameTool(current, merged)) return;
    this.transcript[index] = merged;
  }

  private trim(): void {
    if (this.transcript.length <= MAX_TRANSCRIPT_ITEMS) return;
    const removed = this.transcript.length - MAX_TRANSCRIPT_ITEMS;
    this.transcript.splice(0, removed);
    if (this.partialAssistantIndex !== undefined) {
      this.partialAssistantIndex -= removed;
      if (this.partialAssistantIndex < 0) this.partialAssistantIndex = undefined;
    }
    this.rebuildIndexes();
  }

  private rebuildIndexes(): void {
    this.toolIndexes.clear();
    this.transcript.forEach((item, index) => {
      if (item.type === "tool" && item.toolCallId) {
        this.toolIndexes.set(item.toolCallId, index);
      }
    });
  }
}

/** Whether two projections of one tool call render identically, so the item object can be kept. */
function sameTool(left: ToolTranscriptItem, right: ToolTranscriptItem): boolean {
  return left.name === right.name
    && left.inProgress === right.inProgress
    && left.result === right.result
    && left.isError === right.isError
    && left.durationMs === right.durationMs
    && left.timestamp === right.timestamp
    && left.details === right.details
    && left.args === right.args;
}
