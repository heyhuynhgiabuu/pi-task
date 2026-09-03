/**
 * Read assistant text from pi JSONL session directories used by task sessions.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
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

/**
 * Whether the subagent has finished producing responses.
 *
 * The reliable completion signal is the last assistant message's stopReason.
 * - "toolUse": the agent called tools and should continue, so it is not done.
 * - "stop" / "endTurn" / "length" / "error" / "aborted": terminal.
 * - no assistant messages or no stopReason yet: not done.
 */
export function hasAgentFinished(
  sessionDir: string,
  sessionName?: string,
  sinceMs?: number,
): boolean {
  if (!existsSync(sessionDir)) return false;

  const files = readdirSync(sessionDir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();

  let lastStopReason: string | undefined;

  for (const file of files) {
    const content = readFileSync(join(sessionDir, file), "utf-8");
    if (!matchesSessionName(content, sessionName)) continue;

    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as {
          type?: string;
          timestamp?: string;
          message?: { role?: string; stopReason?: string };
        };
        if (entry.type !== "message") continue;
        if (sinceMs !== undefined && entry.timestamp) {
          const timestampMs = Date.parse(entry.timestamp);
          if (Number.isFinite(timestampMs) && timestampMs < sinceMs) continue;
        }
        const msg = entry.message;
        if (!msg || msg.role !== "assistant") continue;
        if (typeof msg.stopReason === "string") {
          lastStopReason = msg.stopReason;
        }
      } catch {
        /* skip malformed JSONL rows */
      }
    }
  }

  if (!lastStopReason) return false;
  if (lastStopReason === "toolUse") return false;
  return ["stop", "endTurn", "length", "error", "aborted"].includes(lastStopReason);
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
  if (!existsSync(sessionDir)) return undefined;

  const files = readdirSync(sessionDir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();

  let last: number | undefined;
  for (const file of files) {
    const content = readFileSync(join(sessionDir, file), "utf-8");
    if (!matchesSessionName(content, sessionName)) continue;

    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as { type?: string; timestamp?: string };
        if (entry.type !== "message" || !entry.timestamp) continue;
        const timestampMs = Date.parse(entry.timestamp);
        if (!Number.isFinite(timestampMs)) continue;
        if (sinceMs !== undefined && timestampMs < sinceMs) continue;
        if (last === undefined || timestampMs > last) last = timestampMs;
      } catch {
        /* skip malformed JSONL rows */
      }
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
  if (!existsSync(sessionDir)) return "";

  const files = readdirSync(sessionDir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();

  let last = "";
  for (const file of files) {
    const content = readFileSync(join(sessionDir, file), "utf-8");
    if (!matchesSessionName(content, sessionName)) continue;

    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as {
          type?: string;
          timestamp?: string;
          message?: { role?: string; content?: unknown };
        };
        if (entry.type !== "message") continue;
        if (sinceMs !== undefined && entry.timestamp) {
          const timestampMs = Date.parse(entry.timestamp);
          if (Number.isFinite(timestampMs) && timestampMs < sinceMs) continue;
        }
        const msg = entry.message;
        if (!msg || msg.role !== "assistant") continue;
        const text = extractText(msg.content);
        if (text) last = text;
      } catch {
        /* skip malformed JSONL rows */
      }
    }
  }
  return last;
}
