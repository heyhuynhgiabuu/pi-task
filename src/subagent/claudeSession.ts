/**
 * Read assistant state from Claude Code JSONL transcripts.
 *
 * Claude Code persists one JSONL transcript per session at
 * `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl` (the slug is the child
 * cwd with `:`, `\`, `.`, `/`, and whitespace replaced by `-`). Assistant
 * rows carry `message.stop_reason` (snake_case; some versions camelCase):
 * `null` while in flight, `"tool_use"` between turns, and a terminal value
 * (`"end_turn"`, `"stop_sequence"`, `"max_tokens"`) when the child is done.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CLAUDE_TERMINAL_STOP_REASONS = new Set([
  "end_turn",
  "stop_sequence",
  "max_tokens",
]);

export function claudeSlug(cwd: string): string {
  return cwd.replace(/[:\\/.\s]/g, "-");
}

export function claudeProjectDir(cwd: string, home?: string): string {
  const root = home ?? process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  return join(root, ".claude", "projects", claudeSlug(cwd));
}

export function claudeSessionFilePath(
  cwd: string,
  sessionId: string,
  home?: string,
): string {
  return join(claudeProjectDir(cwd, home), `${sessionId}.jsonl`);
}

interface ClaudeEntry {
  type?: string;
  timestamp?: string;
  message?: {
    role?: string;
    stop_reason?: string | null;
    stopReason?: string | null;
    content?: unknown;
  };
}

function claudeStopReason(msg: ClaudeEntry["message"]): string | null {
  if (typeof msg?.stop_reason === "string") return msg.stop_reason;
  if (typeof msg?.stopReason === "string") return msg.stopReason;
  return null;
}

function claudeText(msg: ClaudeEntry["message"]): string {
  const content = msg?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block: { type?: string }) =>
        block && typeof block === "object" && block.type === "text",
    )
    .map((block: { text?: string }) => block.text ?? "")
    .join("\n")
    .trim();
}

function forEachClaudeAssistant(
  filePath: string,
  sinceMs: number | undefined,
  visit: (msg: ClaudeEntry["message"], timestamp?: string) => void,
): void {
  if (!existsSync(filePath)) return;
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return;
  }
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as ClaudeEntry;
      if (entry.type !== "assistant" || !entry.message) continue;
      if (sinceMs !== undefined && entry.timestamp) {
        const timestampMs = Date.parse(entry.timestamp);
        if (Number.isFinite(timestampMs) && timestampMs < sinceMs) continue;
      }
      visit(entry.message, entry.timestamp);
    } catch {
      /* skip malformed JSONL rows */
    }
  }
}

/**
 * Whether the Claude Code child has finished: the last assistant row must
 * carry a terminal stop_reason. Null (in flight) and "tool_use" (continues)
 * mean not done; a missing transcript means not done.
 *
 * The last assistant row is authoritative: a newer row with a null stop
 * reason (a turn still streaming) must override an older terminal reason,
 * so `last` is assigned for every assistant row regardless of nullity.
 */
export function hasClaudeFinished(
  filePath: string,
  sinceMs?: number,
): boolean {
  let sawAssistant = false;
  let last: string | null = null;
  forEachClaudeAssistant(filePath, sinceMs, (msg) => {
    sawAssistant = true;
    last = claudeStopReason(msg);
  });
  return sawAssistant && last !== null && CLAUDE_TERMINAL_STOP_REASONS.has(last);
}

/**
 * Completed assistant turns: assistant rows with an explicit stop_reason
 * ("tool_use" between turns and terminal reasons alike). Null/unknown
 * rows are still streaming and don't count, so a turn increments only
 * when the child actually finished responding. Compatible with the pi
 * turn counting used for max_turns wrap-up (issue #19).
 */
export function claudeTurnCount(
  filePath: string,
  sinceMs?: number,
): number {
  let count = 0;
  forEachClaudeAssistant(filePath, sinceMs, (msg) => {
    const reason = claudeStopReason(msg);
    if (reason !== null) count += 1;
  });
  return count;
}

/** Last non-empty assistant text from the Claude Code transcript. */
export function getLastClaudeAssistantText(
  filePath: string,
  sinceMs?: number,
): string {
  let last = "";
  forEachClaudeAssistant(filePath, sinceMs, (msg) => {
    const text = claudeText(msg);
    if (text) last = text;
  });
  return last;
}

/** Best-effort tool-use count for stats; a missing transcript yields 0. */
export function claudeToolUseCount(filePath: string, sinceMs?: number): number {
  let count = 0;
  forEachClaudeAssistant(filePath, sinceMs, (msg) => {
    const content = msg?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: string }).type === "tool_use"
      ) {
        count += 1;
      }
    }
  });
  return count;
}

/** Timestamp of the latest assistant row in a Claude transcript. */
export function getLastClaudeMessageTimestamp(
  filePath: string,
  sinceMs?: number,
): number | undefined {
  let last: number | undefined;
  forEachClaudeAssistant(filePath, sinceMs, (_msg, timestamp) => {
    if (!timestamp) return;
    const timestampMs = Date.parse(timestamp);
    if (Number.isFinite(timestampMs)) last = timestampMs;
  });
  return last;
}
