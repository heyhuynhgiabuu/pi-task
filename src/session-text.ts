/**
 * Read assistant text from pi JSONL session directories (task / harness).
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

/**
 * Last non-empty assistant message across all .jsonl files in sessionDir.
 */
export function getLastAssistantTextFromSessionDir(sessionDir: string): string {
  if (!existsSync(sessionDir)) return "";

  const files = readdirSync(sessionDir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();

  let last = "";
  for (const file of files) {
    const content = readFileSync(join(sessionDir, file), "utf-8");
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as {
          type?: string;
          message?: { role?: string; content?: unknown };
        };
        if (entry.type !== "message") continue;
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

/**
 * Terminal state of the subagent's pi session, derived from the most recent
 * assistant message's `stopReason`.
 *
 * - "stopped"  : the last assistant message exists and is not mid-tool-call.
 *                This covers:
 *                  - API responses with `stopReason: "stop"` (clean turn end)
 *                  - Local synthesis messages (no stopReason, no api field)
 *                    that pi appends after the final tool result of a turn.
 *                The TUI may still be open, waiting for the next user input.
 * - "running"  : the last assistant message has `stopReason: "toolUse"`. The
 *                subagent is mid-turn and waiting for a tool result.
 * - "errored"  : the last assistant message has `stopReason` "error" or
 *                "length" (API failure / context overflow). Other unknown
 *                values are treated as "stopped", not failures.
 * - "unknown"  : no jsonl file, no assistant message yet, or an empty
 *                stopReason.
 */
export type SessionTerminalState =
  | "stopped"
  | "running"
  | "errored"
  | "unknown";

/**
 * Richer return from `getSessionTerminalState`. The `state` mirrors the
 * terminal-state enum; `stopReason` is the raw `stopReason` from the
 * most recent assistant message (or `null` when no assistant message
 * exists, the message has no `stopReason` field — e.g. local synthesis
 * — or the state is "unknown"). Surfacing the actual stopReason lets
 * callers distinguish "error" from "length" without a second jsonl walk.
 */
export interface SessionTerminalStateInfo {
  state: SessionTerminalState;
  stopReason: string | null;
}

export function getSessionTerminalState(
  sessionDir: string,
): SessionTerminalStateInfo {
  if (!existsSync(sessionDir)) return { state: "unknown", stopReason: null };
  const files = readdirSync(sessionDir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
  if (files.length === 0) return { state: "unknown", stopReason: null };

  // Iterate files newest-first; within each file walk lines bottom-up so the
  // first assistant message we hit is the most recent one in the directory.
  for (let i = files.length - 1; i >= 0; i--) {
    const file = files[i];
    const content = readFileSync(join(sessionDir, file), "utf-8");
    const lines = content.split("\n");
    for (let j = lines.length - 1; j >= 0; j--) {
      const line = lines[j].trim();
      if (!line) continue;
      // pi writes stopReason on the message object (message.stopReason),
      // not at the JSONL entry top level.
      let entry: {
        type?: string;
        message?: { role?: string; stopReason?: string };
      };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.type !== "message") continue;
      if (entry.message?.role !== "assistant") continue;
      const stopReason = entry.message?.stopReason;
      if (stopReason === "toolUse") return { state: "running", stopReason };
      // "error" and "length" map to "errored" so the parent can surface
      // the failure; everything else (including the common "stop" and
      // local-synthesis cases) is treated as "stopped".
      if (stopReason === "error" || stopReason === "length") {
        return { state: "errored", stopReason };
      }
      return { state: "stopped", stopReason: stopReason ?? null };
    }
  }
  return { state: "unknown", stopReason: null };
}
