/**
 * Task transcript reader: parse a pi session JSONL into a compact transcript
 * for the panel's live view. Pure module (no extension imports) so the parser
 * is unit-testable. Mirrors the pairing done by pi-subtask's live event
 * stream, but sourced from the durable session file so it works for terminal
 * AND SDK children alike.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ChildSessionInfo } from "../types.js";
import type { ChildUsageMetadata } from "./child-metadata.js";

export const MAX_TRANSCRIPT_ITEMS = 400;

/** CSI escape sequences (SGR colors, cursor moves) emitted by tool output. */
const ANSI_CSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** Terminal output keeps ANSI styling; the transcript renders its own. */
function stripAnsiCodes(text: string): string {
  return text.replace(ANSI_CSI_RE, "");
}

export type TranscriptItem =
  | { type: "user"; text: string; timestamp: string }
  | {
      type: "assistant";
      text: string;
      thinking?: string;
      /**
       * True while this item is the in-flight streamed partial of a live
       * transcript (durable `pi.live` generation). Snapshot reads of a session
       * JSONL only hold committed messages, so they never set it.
       */
      streaming?: boolean;
      timestamp: string;
    }
  | {
      type: "tool";
      name: string;
      toolCallId: string;
      args: Record<string, unknown>;
      /**
       * Tool-defined render data, passed through to pi's per-tool renderers as
       * `details` (edit draws its diff from `details.diff`). Pi persists it on
       * the toolResult message, so the projections must carry it too.
       */
      details?: Record<string, unknown>;
      result?: string;
      isError?: boolean;
      /** True while the corresponding tool slot is still running. */
      inProgress?: boolean;
      timestamp: string;
    }
  | { type: "system"; text: string; timestamp: string };

/**
 * Child identity Pi itself persisted in the session metadata: the model and
 * thinking level the child session started with (or last switched to). Read
 * from the same JSONL pass, so no extra I/O and no new storage contract.
 */
export interface ChildSessionMeta {
  /** `provider/modelId`, as recorded by the session's `model_change`. */
  model?: string;
  /** Level from the session's last `thinking_level_change`. */
  thinkingLevel?: string;
}

export interface TranscriptReadResult {
  items: TranscriptItem[];
  /** True when a matching session file was found (as opposed to empty dir). */
  found: boolean;
  /** Absent when the session recorded neither a model nor a thinking level. */
  meta?: ChildSessionMeta;
  /** Identity and billed usage parsed from this child session file only. */
  sessionInfo?: ChildSessionInfo;
  /** Cumulative usage and latest trustworthy context measured from this child file. */
  childMetadata?: ChildUsageMetadata;
}

interface JsonlEntry {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  cwd?: string;
  name?: string;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  usage?: unknown;
  message?: {
    role?: string;
    content?: unknown;
    toolCallId?: string;
    toolName?: string;
    details?: unknown;
    isError?: boolean;
    stopReason?: string;
    usage?: unknown;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (b: { type?: string }) =>
        b?.type === "text" || b?.type === "toolResult",
    )
    .map((b: { text?: string }) => b.text ?? "")
    .join("\n")
    .trim();
}

function extractThinking(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const thinking = content
    .filter((b: { type?: string }) => b?.type === "thinking")
    .map((b: { thinking?: string; text?: string }) => b.thinking ?? b.text ?? "")
    .join("\n")
    .trim();
  return thinking || undefined;
}

function extractToolCalls(content: unknown): Array<{
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}> {
  if (!Array.isArray(content)) return [];
  return content
    .filter(
      (b: { type?: string }) => b?.type === "toolCall",
    )
    .map((b) => ({
      id: String(b.id ?? ""),
      name: String(b.name ?? "tool"),
      arguments: (b.arguments ?? {}) as Record<string, unknown>,
    }))
    .filter((b) => b.id);
}

function matchesSessionName(content: string, sessionName?: string): boolean {
  if (!sessionName) return true;
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as {
        type?: string;
        name?: string;
        session_info?: { name?: string };
      };
      if (entry.type === "session_info") {
        return (entry.name ?? entry.session_info?.name) === sessionName;
      }
    } catch {
      /* skip malformed JSONL rows */
    }
  }
  return false;
}

/** Newest .jsonl file in sessionDir that matches the session name, or null. */
export function findTaskSessionFile(
  sessionDir: string,
  sessionName?: string,
): string | null {
  if (!existsSync(sessionDir)) return null;
  const files = readdirSync(sessionDir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
  for (let i = files.length - 1; i >= 0; i--) {
    const file = join(sessionDir, files[i]!);
    const content = readFileSync(file, "utf-8");
    if (matchesSessionName(content, sessionName)) return file;
  }
  return null;
}

/**
 * Cheap change signature for a session dir: mtime+size of the newest .jsonl
 * (no content read). The pane uses it to re-parse only when the file actually
 * grows, instead of re-reading on every repaint.
 */
export function transcriptSignature(sessionDir: string): string {
  if (!existsSync(sessionDir)) return "";
  const files = readdirSync(sessionDir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
  if (files.length === 0) return "";
  const file = join(sessionDir, files[files.length - 1]!);
  try {
    const st = statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "";
  }
}

/**
 * Read the transcript of a task session. `sessionDir` is the task's session
 * directory (task.dir/sessions/<id> for terminal tasks, or the artifacts dir
 * for SDK children). The newest matching file wins, mirroring the completion
 * polling reader. Items are capped at MAX_TRANSCRIPT_ITEMS keeping the latest.
 */
export function readTaskTranscript(
  sessionDir: string,
  sessionName?: string,
): TranscriptReadResult {
  const file = findTaskSessionFile(sessionDir, sessionName);
  if (!file) return { items: [], found: false };
  return readTaskSessionFile(file);
}

interface SessionUsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

function addSessionUsage(totals: SessionUsageTotals, value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.cost)) return false;
  const fields = [value.input, value.output, value.cacheRead, value.cacheWrite, value.cost.total];
  if (!fields.every((field) => typeof field === "number" && Number.isFinite(field))) return false;
  totals.input += value.input as number;
  totals.output += value.output as number;
  totals.cacheRead += value.cacheRead as number;
  totals.cacheWrite += value.cacheWrite as number;
  totals.cost += value.cost.total as number;
  return true;
}

function promptTokensOf(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const fields = [value.input, value.cacheRead, value.cacheWrite];
  if (!fields.every((field) => typeof field === "number" && Number.isFinite(field) && field >= 0)) {
    return undefined;
  }
  return (value.input as number) + (value.cacheRead as number) + (value.cacheWrite as number);
}

/** Use the final file entry's parent chain to avoid borrowing a compacted abandoned branch. */
function activeSessionBranch(entries: readonly JsonlEntry[]): JsonlEntry[] {
  if (entries.length === 0) return [];
  const hasCompleteTree = entries.every(
    (entry) => typeof entry.id === "string" && Object.prototype.hasOwnProperty.call(entry, "parentId"),
  );
  if (!hasCompleteTree) return [...entries];
  const byId = new Map(entries.map((entry) => [entry.id!, entry]));
  let current = entries.at(-1)!;
  const branch: JsonlEntry[] = [];
  const visited = new Set<string>();
  while (current && typeof current.id === "string" && !visited.has(current.id)) {
    visited.add(current.id);
    branch.unshift(current);
    if (current.parentId === null) return branch;
    if (typeof current.parentId !== "string") return [...entries];
    const parent = byId.get(current.parentId);
    if (!parent) return [...entries];
    current = parent;
  }
  return branch.length > 0 ? branch : [...entries];
}

/**
 * Parse one exact session JSONL. The transcript view uses this for SDK tasks
 * whose live session path is captured when the child session opens — scanning
 * a sessions directory by name can match the parent (whose transcript quotes
 * the task id), and the artifacts dir holds no session at all.
 */
export function readTaskSessionFile(file: string): TranscriptReadResult {
  if (!existsSync(file)) return { items: [], found: false };

  const items: TranscriptItem[] = [];
  const pendingTools = new Map<string, TranscriptItem & { type: "tool" }>();
  const meta: ChildSessionMeta = {};
  const usage: SessionUsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let hasUsage = false;
  let sessionId: string | undefined;
  let sessionName: string | undefined;
  let cwd: string | undefined;
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let toolResults = 0;
  let totalMessages = 0;
  let latestCacheHitRate: number | undefined;
  const contextEntries: JsonlEntry[] = [];

  const content = readFileSync(file, "utf-8");
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let entry: JsonlEntry;
    try {
      entry = JSON.parse(line) as JsonlEntry;
    } catch {
      continue;
    }
    if (entry.type === "session") {
      if (typeof entry.id === "string" && entry.id) sessionId = entry.id;
      if (typeof entry.cwd === "string" && entry.cwd) cwd = entry.cwd;
      continue;
    }
    contextEntries.push(entry);
    if (entry.type === "session_info") {
      if (typeof entry.name === "string" && entry.name) sessionName = entry.name;
      continue;
    }
    if (entry.type === "usage" || entry.type === "branch_summary" || entry.type === "compaction") {
      hasUsage = addSessionUsage(usage, entry.usage) || hasUsage;
      if (entry.type !== "usage") continue;
    }
    if (entry.type === "model_change") {
      const modelId = entry.modelId?.trim();
      if (modelId) {
        const provider = entry.provider?.trim();
        meta.model = provider ? `${provider}/${modelId}` : modelId;
      }
      continue;
    }
    if (entry.type === "thinking_level_change") {
      const level = entry.thinkingLevel?.trim();
      if (level) meta.thinkingLevel = level;
      continue;
    }
    if (entry.type !== "message" || !entry.message) continue;
    const msg = entry.message;
    const timestamp = entry.timestamp ?? "";
    totalMessages++;
    hasUsage = addSessionUsage(usage, msg.usage) || hasUsage;
    if (msg.role === "user") userMessages++;
    else if (msg.role === "assistant") {
      assistantMessages++;
      toolCalls += extractToolCalls(msg.content).length;
      const promptTokens = promptTokensOf(msg.usage);
      latestCacheHitRate = promptTokens !== undefined && promptTokens > 0 && isRecord(msg.usage)
        ? ((msg.usage.cacheRead as number) / promptTokens) * 100
        : undefined;
    } else if (msg.role === "toolResult") toolResults++;

    if (msg.role === "user") {
      const text = stripAnsiCodes(extractText(msg.content));
      if (text) items.push({ type: "user", text, timestamp });
    } else if (msg.role === "assistant") {
      const text = stripAnsiCodes(extractText(msg.content));
      const thinking = extractThinking(msg.content);
      if (text || thinking) {
        items.push({
          type: "assistant",
          text,
          ...(thinking ? { thinking } : {}),
          timestamp,
        });
      }
      for (const call of extractToolCalls(msg.content)) {
        const item: TranscriptItem & { type: "tool" } = {
          type: "tool",
          name: call.name,
          toolCallId: call.id,
          args: call.arguments,
          timestamp,
          inProgress: true,
        };
        pendingTools.set(call.id, item);
        items.push(item);
      }
    } else if (msg.role === "toolResult" && msg.toolCallId) {
      const text = stripAnsiCodes(extractText(msg.content));
      const details = isRecord(msg.details) ? msg.details : undefined;
      const existing = pendingTools.get(msg.toolCallId);
      if (existing) {
        existing.result = text || undefined;
        if (details) existing.details = details;
        existing.isError = Boolean(msg.isError);
        existing.inProgress = false;
        pendingTools.delete(msg.toolCallId);
      } else {
        // Tool result without a paired call (older files or resumed sessions):
        // synthesize a row so the work is still visible.
        items.push({
          type: "tool",
          name: msg.toolName ?? "tool",
          toolCallId: msg.toolCallId,
          args: {},
          ...(details ? { details } : {}),
          result: text || undefined,
          isError: Boolean(msg.isError),
          timestamp,
          inProgress: false,
        });
      }
    }
  }

  // The latest assistant usage on the active branch is only a valid current
  // context measurement after the most recent compaction/reset/context edit.
  let contextTokens: number | null = null;
  for (const current of activeSessionBranch(contextEntries)) {
    if (current.type === "compaction" || current.type === "reset" || current.type === "context_edit") {
      contextTokens = null;
      continue;
    }
    if (current.type !== "message" || current.message?.role !== "assistant") continue;
    if (current.message.stopReason === "aborted" || current.message.stopReason === "error") continue;
    const promptTokens = promptTokensOf(current.message.usage);
    if (promptTokens !== undefined && promptTokens > 0) contextTokens = promptTokens;
  }

  // Keep the latest items (live view tails the conversation).
  if (items.length > MAX_TRANSCRIPT_ITEMS) {
    items.splice(0, items.length - MAX_TRANSCRIPT_ITEMS);
  }
  return {
    items,
    found: true,
    ...(meta.model === undefined && meta.thinkingLevel === undefined ? {} : { meta }),
    sessionInfo: {
      ...(sessionId ? { sessionId } : {}),
      ...(sessionName ? { sessionName } : {}),
      storagePath: file,
      ...(meta.model ? { model: meta.model } : {}),
      ...(meta.thinkingLevel ? { thinkingLevel: meta.thinkingLevel } : {}),
      ...(cwd ? { cwd } : {}),
      counts: {
        scope: "session",
        userMessages,
        assistantMessages,
        toolCalls,
        toolResults,
        totalMessages,
      },
      ...(hasUsage
        ? {
            tokens: {
              input: usage.input,
              output: usage.output,
              cacheRead: usage.cacheRead,
              cacheWrite: usage.cacheWrite,
              total: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
            },
            cost: usage.cost,
          }
        : {}),
    },
    childMetadata: {
      ...(meta.model === undefined ? {} : { model: meta.model }),
      usageTotals: { ...usage },
      ...(latestCacheHitRate === undefined ? {} : { latestCacheHitRate }),
      contextUsage: { tokens: contextTokens },
    },
  };
}

/** Cheap change signature for one exact session file: mtime + size. */
export function sessionFileSignature(file: string): string {
  try {
    const stats = statSync(file);
    return `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return "";
  }
}

/** One-line activity summary from the last tool row, if any. */
export function transcriptActivity(items: readonly TranscriptItem[]): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.type !== "tool") continue;
    const args = item.args;
    if (item.name === "bash") {
      const command = String(args.command ?? "");
      return `$ ${command.slice(0, 50)}`;
    }
    const file = String(
      args.file_path ?? args.path ?? args.file ?? "",
    );
    if (file) return `${item.name} ${file.split("/").pop()}`;
    return item.name;
  }
  return "";
}