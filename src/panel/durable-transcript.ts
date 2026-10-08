import type {
  AgentEvent,
  EntryRecord,
  SnapshotEvent,
  UsageState,
} from "@earendil-works/pi-durable";
import type { Message } from "@earendil-works/pi-ai";
import type { ChildHistoryOption } from "../types.js";
import { assistantTokensPerSecond, type ChildUsageMetadata } from "./child-metadata.js";
import { MAX_TRANSCRIPT_ITEMS, authoritativeDurationMs, type TranscriptItem } from "./transcript.js";

// Persisted pi-durable entry kinds (entries.ts, 1.0.4). Keep runtime imports
// out of this always-loaded transcript adapter; the durable peer is optional.
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

function indexedContentBlocks(content: unknown): [number, ContentBlock][] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block, index) => {
    const parsed = parseContentBlock(block);
    return parsed ? [[index, parsed] as [number, ContentBlock]] : [];
  });
}

function contentBlocks(content: unknown): ContentBlock[] {
  return indexedContentBlocks(content).map(([, block]) => block);
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

/** pi-ai >= the duration release types `durationMs`; 1.0.4 typings lack it, so read it as data. */
function messageDuration(message: Message): number | undefined {
  return authoritativeDurationMs((message as { durationMs?: unknown }).durationMs);
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

function toolOutput(current: string, output: NonNullable<Extract<AgentEvent, { type: "tool_execution_update" }>["output"]>): string {
  if ("set" in output) return output.set;
  const retained = output.trimStart
    ? current.slice(Math.min(output.trimStart, current.length))
    : current;
  return retained + (output.append ?? "");
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
 * Projects pi-durable snapshots and committed event batches into the task
 * panel's transcript format. Partial assistant text and running tool output
 * are replaced immutably so the pane can refresh its cached components.
 */
export class DurableTranscript {
  private transcript: TranscriptItem[] = [];
  private toolIndexes = new Map<string, number>();
  private snapshotToolCalls = new Set<string>();
  // Keep snapshot history separate: a completed call can still have a later live start event.
  private snapshotHistoryToolCalls = new Set<string>();
  private countedToolCalls = new Set<string>();
  private toolCallTotal = 0;
  private agent: DurableChildAgent = {};
  private usageState: UsageState = { models: {}, tools: {} };
  private latestCacheHitRate: number | undefined;
  private latestTokensPerSecond: number | undefined;
  private contextTokens: number | null = null;
  private compactionInProgress = false;
  private partialAssistantIndex: number | undefined;
  private partialTextBlocks = new Map<number, string>();
  private partialThinkingBlocks = new Map<number, string>();

  constructor(snapshot: SnapshotEvent) {
    this.replaceSnapshot(snapshot);
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

  apply(events: readonly AgentEvent[]): TranscriptItem[] {
    for (const event of events) {
      switch (event.type) {
        case "snapshot":
          this.replaceSnapshot(event);
          break;
        case "usage_changed":
          this.usageState = event.usage;
          break;
        case "compaction_start":
          this.compactionInProgress = true;
          this.contextTokens = null;
          break;
        case "compaction_end":
          this.compactionInProgress = false;
          this.contextTokens = null;
          break;
        case "entry_appended":
          this.observeEntryMetadata(event.entry);
          break;
        case "agent_changed":
          this.setAgentState(event.agent);
          break;
        case "message_start":
          if (event.message.role === "assistant") this.writePartialAssistant(event.message, true);
          break;
        case "message_update":
          if (!this.compactionInProgress) this.observeAssistantUsage(event.usage);
          this.applyMessageChanges(event.changes);
          break;
        case "message_end":
          for (const message of event.entry.model ?? []) {
            this.observeMessageMetadata(message);
            this.appendMessage(message, true);
          }
          break;
        case "tool_execution_start":
          this.observeToolCall(event.toolCallId);
          this.upsertTool({
            type: "tool",
            name: event.toolName,
            toolCallId: event.toolCallId,
            args: event.args,
            timestamp: "",
            inProgress: true,
          });
          break;
        case "tool_execution_update":
          this.observeToolCall(event.toolCallId);
          this.updateTool(event.toolCallId, (item) => ({
            ...item,
            ...(event.output === undefined
              ? {}
              : { result: toolOutput(item.result ?? "", event.output) }),
            ...(event.details === undefined
              ? {}
              : { details: toolDetails(event.details) }),
            inProgress: true,
          }), event.toolName);
          break;
        case "tool_execution_end":
          this.observeToolCall(event.toolCallId);
          {
            // Live end carries the committed toolResult (absent on fault/orphan).
            const durationMs = this.endEventDuration(event);
            this.updateTool(event.toolCallId, (item) => ({
              ...item,
              ...(durationMs === undefined ? {} : { durationMs }),
              inProgress: false,
            }), event.toolName);
          }
          break;
        case "task_failed":
          this.append({
            type: "system",
            text: `Task failed: ${event.message}`,
            timestamp: "",
          });
          break;
        default:
          break;
      }
    }
    this.trim();
    return this.items();
  }

  private endEventDuration(
    event: Extract<AgentEvent, { type: "tool_execution_end" }>,
  ): number | undefined {
    for (const message of event.entry?.model ?? []) {
      if (message.role === "toolResult" && message.toolCallId === event.toolCallId) {
        return messageDuration(message);
      }
    }
    return undefined;
  }

  private setAgentState(state: SnapshotEvent["agent"] | undefined): void {
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

  private replaceSnapshot(snapshot: SnapshotEvent): void {
    this.setAgentState(snapshot.agent);
    this.usageState = snapshot.usage ?? { models: {}, tools: {} };
    this.latestCacheHitRate = undefined;
    this.latestTokensPerSecond = undefined;
    this.contextTokens = null;
    this.compactionInProgress = false;
    this.transcript = [];
    this.toolIndexes.clear();
    this.snapshotToolCalls.clear();
    this.clearPartialAssistant();
    for (const entry of snapshot.entries) {
      this.observeEntryMetadata(entry);
      for (const message of entry.model ?? []) {
        this.rememberSnapshotToolCalls(message);
        this.observeMessageMetadata(message);
        this.appendMessage(message);
      }
    }
    if (snapshot.generation?.message) {
      const message = snapshot.generation.message as Message;
      this.rememberSnapshotToolCalls(message);
      // An in-flight snapshot has no final response timing yet.
      if (message.role === "assistant") this.observeAssistantUsage(message.usage);
      this.writePartialAssistant(message);
    }
    for (const slot of snapshot.tools) {
      if (slot.status === "done") continue;
      this.snapshotToolCalls.add(slot.callId);
      const details = toolDetails(slot.details);
      this.updateTool(
        slot.callId,
        (item) => ({
          ...item,
          name: slot.name,
          ...(slot.output === undefined ? {} : { result: slot.output }),
          ...(details === undefined ? {} : { details }),
          inProgress: true,
        }),
        slot.name,
      );
    }
    for (const toolCallId of this.toolIndexes.keys()) {
      if (this.snapshotHistoryToolCalls.has(toolCallId)) continue;
      this.snapshotHistoryToolCalls.add(toolCallId);
      if (!this.countedToolCalls.has(toolCallId)) this.toolCallTotal++;
    }
    this.trim();
  }

  private observeEntryMetadata(entry: EntryRecord): void {
    if (entry.kind === COMPACTION_ENTRY_KIND || entry.kind === RESET_ENTRY_KIND) {
      this.contextTokens = null;
      return;
    }
    for (const message of entry.model ?? []) this.observeMessageMetadata(message);
  }

  private observeMessageMetadata(message: Message): void {
    if (message.role === "assistant") {
      this.observeAssistantUsage(message.usage, message.stopReason);
      if (!this.compactionInProgress) this.latestTokensPerSecond = assistantTokensPerSecond(message);
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

  private rememberSnapshotToolCalls(message: Message): void {
    if (message.role !== "assistant") return;
    for (const block of contentBlocks(message.content)) {
      if (block.type === "toolCall") this.snapshotToolCalls.add(block.id);
    }
  }

  private appendMessage(message: Message, countLiveTools = false): void {
    const timestamp = timestampOf(message);
    if (message.role === "user") {
      const text = textContent(message.content);
      if (text) this.append({ type: "user", text, timestamp });
      return;
    }
    if (message.role === "assistant") {
      const assistant = asAssistant(message)!;
      if (assistant.text || assistant.thinking) {
        if (this.partialAssistantIndex !== undefined) {
          this.transcript[this.partialAssistantIndex] = assistant;
          this.clearPartialAssistant();
        } else {
          this.append(assistant);
        }
      } else if (this.partialAssistantIndex !== undefined) {
        this.transcript.splice(this.partialAssistantIndex, 1);
        this.clearPartialAssistant();
        this.rebuildIndexes();
      }
      for (const block of contentBlocks(message.content)) {
        const item = toolCall(block, timestamp);
        if (item) {
          if (countLiveTools) this.observeToolCall(item.toolCallId);
          this.upsertTool(item);
        }
      }
      return;
    }
    if (message.role === "toolResult") {
      if (countLiveTools) this.observeToolCall(message.toolCallId);
      this.snapshotToolCalls.delete(message.toolCallId);
      const result = textContent(message.content);
      const details = toolDetails(message.details);
      const durationMs = messageDuration(message);
      const existingIndex = this.toolIndexes.get(message.toolCallId);
      if (existingIndex === undefined) {
        this.upsertTool({
          type: "tool",
          name: message.toolName || "tool",
          toolCallId: message.toolCallId,
          args: {},
          ...(details === undefined ? {} : { details }),
          ...(durationMs === undefined ? {} : { durationMs }),
          result: result || undefined,
          isError: Boolean(message.isError),
          timestamp,
          inProgress: false,
        });
      } else {
        const existing = this.transcript[existingIndex];
        if (existing?.type === "tool") {
          this.transcript[existingIndex] = {
            ...existing,
            name: message.toolName || existing.name,
            ...(details === undefined ? {} : { details }),
            ...(durationMs === undefined ? {} : { durationMs }),
            result: result || undefined,
            isError: Boolean(message.isError),
            inProgress: false,
            timestamp,
          };
        }
      }
    }
  }

  private writePartialAssistant(message: Message, countLiveTools = false): void {
    const assistant = asAssistant(message, true);
    if (!assistant) return;
    this.partialTextBlocks.clear();
    this.partialThinkingBlocks.clear();
    for (const [index, block] of indexedContentBlocks(message.content)) {
      if (block.type === "text") this.partialTextBlocks.set(index, block.text);
      else if (block.type === "thinking") this.partialThinkingBlocks.set(index, block.thinking);
    }
    if (this.partialAssistantIndex === undefined) {
      this.partialAssistantIndex = this.transcript.length;
      this.append(assistant);
    } else {
      this.transcript[this.partialAssistantIndex] = assistant;
    }
    this.syncPartialAssistant();
    for (const block of contentBlocks(message.content)) {
      const item = toolCall(block, assistant.timestamp);
      if (item) {
        if (countLiveTools) this.observeToolCall(item.toolCallId);
        this.upsertTool(item);
      }
    }
  }

  private applyMessageChanges(
    changes: Extract<AgentEvent, { type: "message_update" }>["changes"],
  ): void {
    for (const change of changes) {
      if (change.type === "message") {
        this.writePartialAssistant(change.message, true);
        continue;
      }
      if (change.type === "text_delta") {
        this.partialTextBlocks.set(
          change.contentIndex,
          (this.partialTextBlocks.get(change.contentIndex) ?? "") + change.delta,
        );
        this.syncPartialAssistant();
        continue;
      }
      if (change.type === "thinking_delta") {
        this.partialThinkingBlocks.set(
          change.contentIndex,
          (this.partialThinkingBlocks.get(change.contentIndex) ?? "") + change.delta,
        );
        this.syncPartialAssistant();
        continue;
      }
      if (!("block" in change)) continue;
      const block = parseContentBlock(change.block);
      if (!block) continue;
      if (change.type === "text_start" && block.type === "text") {
        this.partialTextBlocks.set(change.contentIndex, block.text);
        this.syncPartialAssistant();
      } else if (change.type === "thinking_start" && block.type === "thinking") {
        this.partialThinkingBlocks.set(change.contentIndex, block.thinking);
        this.syncPartialAssistant();
      } else if (
        (change.type === "toolcall_start" || change.type === "block") &&
        block.type === "toolCall"
      ) {
        const item = toolCall(block, "");
        if (item) {
          this.observeToolCall(item.toolCallId);
          this.upsertTool(item);
        }
      } else if (change.type === "block" && block.type === "text") {
        this.partialTextBlocks.set(change.contentIndex, block.text);
        this.syncPartialAssistant();
      } else if (change.type === "block" && block.type === "thinking") {
        this.partialThinkingBlocks.set(change.contentIndex, block.thinking);
        this.syncPartialAssistant();
      }
    }
  }

  private observeToolCall(toolCallId: string): void {
    if (this.countedToolCalls.has(toolCallId)) return;
    this.countedToolCalls.add(toolCallId);
    if (!this.snapshotToolCalls.delete(toolCallId)) this.toolCallTotal++;
  }

  private syncPartialAssistant(): void {
    const text = [...this.partialTextBlocks.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, value]) => value)
      .join("\n");
    const thinking = [...this.partialThinkingBlocks.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, value]) => value)
      .join("\n");
    if (this.partialAssistantIndex === undefined) {
      this.partialAssistantIndex = this.transcript.length;
      this.append({ type: "assistant", text, streaming: true, timestamp: "", ...(thinking ? { thinking } : {}) });
      return;
    }
    const current = this.transcript[this.partialAssistantIndex];
    if (current?.type === "assistant") {
      const { thinking: _oldThinking, ...withoutThinking } = current;
      this.transcript[this.partialAssistantIndex] = {
        ...withoutThinking,
        text,
        ...(thinking ? { thinking } : {}),
      };
    }
  }

  private clearPartialAssistant(): void {
    this.partialAssistantIndex = undefined;
    this.partialTextBlocks.clear();
    this.partialThinkingBlocks.clear();
  }

  private upsertTool(item: ToolTranscriptItem): void {
    const existingIndex = this.toolIndexes.get(item.toolCallId);
    if (existingIndex === undefined) {
      this.toolIndexes.set(item.toolCallId, this.transcript.length);
      this.append(item);
      return;
    }
    const existing = this.transcript[existingIndex];
    if (existing?.type === "tool") {
      this.transcript[existingIndex] = { ...existing, ...item };
    }
  }

  private updateTool(
    toolCallId: string,
    update: (item: ToolTranscriptItem) => ToolTranscriptItem,
    name: string,
  ): void {
    const index = this.toolIndexes.get(toolCallId);
    if (index === undefined) {
      const created: ToolTranscriptItem = {
        type: "tool",
        name,
        toolCallId,
        args: {},
        timestamp: "",
        inProgress: true,
      };
      this.upsertTool(update(created));
      return;
    }
    const item = this.transcript[index];
    if (item?.type === "tool") this.transcript[index] = update(item);
  }

  private append(item: TranscriptItem): void {
    this.transcript.push(item);
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
