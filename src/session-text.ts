/**
 * Read assistant text from pi JSONL session directories used by task sessions.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: { type?: string }) => b?.type === "text")
    .map((b: { text?: string }) => b.text ?? "")
    .join("\n")
    .trim();
}

export type SessionTerminalResult =
  | { status: "completed"; content: string }
  | { status: "failed"; content: string };

interface AssistantSummary {
  stopReason?: string;
  errorMessage?: string;
  text: string;
  timestampMs?: number;
}

interface SessionFileSummary {
  sessionInfoName?: string;
  hasSessionInfo: boolean;
  messages: AssistantSummary[];
  lastMessageTimestamp?: number;
}

interface CachedSessionFile {
  size: number;
  mtimeMs: number;
  summary: SessionFileSummary;
}

const SESSION_FILE_CACHE_LIMIT = 256;
const sessionFileCache = new Map<string, CachedSessionFile>();

function fileSummary(file: string): SessionFileSummary {
  const stat = statSync(file);
  const cached = sessionFileCache.get(file);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return cached.summary;
  }

  const summary: SessionFileSummary = {
    hasSessionInfo: false,
    messages: [],
  };
  const content = readFileSync(file, "utf-8");
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as {
        type?: string;
        timestamp?: string;
        name?: string;
        session_info?: { name?: string };
        message?: {
          role?: string;
          stopReason?: string;
          errorMessage?: string;
          content?: unknown;
        };
      };
      if (entry.type === "session_info" && !summary.hasSessionInfo) {
        summary.hasSessionInfo = true;
        summary.sessionInfoName = entry.name ?? entry.session_info?.name;
        continue;
      }
      if (entry.type !== "message") continue;
      const timestampMs = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
      if (Number.isFinite(timestampMs)) {
        summary.lastMessageTimestamp = Math.max(
          summary.lastMessageTimestamp ?? timestampMs,
          timestampMs,
        );
      }
      const message = entry.message;
      if (!message || message.role !== "assistant") continue;
      summary.messages.push({
        stopReason: message.stopReason,
        errorMessage: message.errorMessage,
        text: extractText(message.content),
        ...(Number.isFinite(timestampMs) ? { timestampMs } : {}),
      });
    } catch {
      /* skip malformed JSONL rows */
    }
  }

  sessionFileCache.delete(file);
  sessionFileCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, summary });
  while (sessionFileCache.size > SESSION_FILE_CACHE_LIMIT) {
    const oldest = sessionFileCache.keys().next().value;
    if (oldest === undefined) break;
    sessionFileCache.delete(oldest);
  }
  return summary;
}

function matchingFiles(sessionDir: string, sessionName?: string): SessionFileSummary[] {
  if (!existsSync(sessionDir)) return [];
  return readdirSync(sessionDir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .map((file) => fileSummary(join(sessionDir, file)))
    .filter((summary) =>
      !sessionName || (summary.hasSessionInfo && summary.sessionInfoName === sessionName),
    );
}

function isAfter(summaryTimestamp: number | undefined, sinceMs?: number): boolean {
  return sinceMs === undefined ||
    summaryTimestamp === undefined ||
    summaryTimestamp >= sinceMs;
}

/**
 * Read the terminal assistant message, preserving provider failures instead
 * of falling back to text from an earlier successful turn.
 */
export function getLastAssistantResultFromSessionDir(
  sessionDir: string,
  sessionName?: string,
  sinceMs?: number,
): SessionTerminalResult | null {
  let terminal: AssistantSummary | undefined;
  for (const summary of matchingFiles(sessionDir, sessionName)) {
    for (const message of summary.messages) {
      if (!isAfter(message.timestampMs, sinceMs)) continue;
      if (typeof message.stopReason === "string") terminal = message;
    }
  }

  if (!terminal?.stopReason) return null;
  if (!["stop", "endTurn", "length", "error", "aborted"].includes(terminal.stopReason)) {
    // `toolUse` and unknown reasons are intermediate/non-terminal states.
    return null;
  }
  if (terminal.stopReason === "error" || terminal.stopReason === "aborted") {
    const errorMessage =
      typeof terminal.errorMessage === "string" ? terminal.errorMessage.trim() : "";
    return {
      status: "failed",
      content:
        errorMessage ||
        terminal.text ||
        `Subagent ${terminal.stopReason} before producing a result.`,
    };
  }

  if (!terminal.text) {
    return {
      status: "failed",
      content: "Subagent finished without producing a result.",
    };
  }
  return { status: "completed", content: terminal.text };
}

/**
 * Timestamp (ms) of the last message row in matching session files, or
 * undefined when the session has no messages after `sinceMs`. Used to
 * reconstruct a faithful completedAt for tasks restored after a restart.
 */
export function getLastMessageTimestampFromSessionDir(
  sessionDir: string,
  sessionName?: string,
  sinceMs?: number,
): number | undefined {
  let last: number | undefined;
  for (const summary of matchingFiles(sessionDir, sessionName)) {
    if (!isAfter(summary.lastMessageTimestamp, sinceMs)) continue;
    if (last === undefined || (summary.lastMessageTimestamp ?? 0) > last) {
      last = summary.lastMessageTimestamp;
    }
  }
  return last;
}

/**
 * Last non-empty assistant message from matching .jsonl files in sessionDir.
 */
export function getLastAssistantTextFromSessionDir(
  sessionDir: string,
  sessionName?: string,
  sinceMs?: number,
): string {
  let last = "";
  for (const summary of matchingFiles(sessionDir, sessionName)) {
    for (const message of summary.messages) {
      if (!isAfter(message.timestampMs, sinceMs)) continue;
      if (message.text) last = message.text;
    }
  }
  return last;
}
