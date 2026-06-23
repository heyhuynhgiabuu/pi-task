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
     * The completion signal is the last assistant message's stopReason.
     * - "stop" / "endTurn": agent delivered its final answer → DONE
     * - "toolUse": agent called tools, will continue → NOT DONE
     * - "length" / "error" / "aborted": problem → treat as DONE (won't continue)
     * - No assistant messages yet → NOT DONE
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
            const msg = entry.message;
            if (!msg || msg.role !== "assistant") continue;
            if (sinceMs !== undefined && entry.timestamp) {
              const timestampMs = Date.parse(entry.timestamp);
              if (Number.isFinite(timestampMs) && timestampMs < sinceMs) continue;
            }
            if (typeof msg.stopReason === "string") {
              lastStopReason = msg.stopReason;
            }
          } catch {
            /* skip malformed JSONL rows */
          }
        }
      }

      // No assistant messages → not done
      if (!lastStopReason) return false;
      // "toolUse" → agent called tools, will continue (not done)
      if (lastStopReason === "toolUse") return false;
      // "stop", "endTurn", "length", "error", "aborted" → done
      return true;
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
