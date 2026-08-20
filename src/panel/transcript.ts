/**
 * Task transcript reader: parse a pi session JSONL into a compact transcript
 * for the panel's live view. Pure module (no extension imports) so the parser
 * is unit-testable. Mirrors the pairing done by pi-subtask's live event
 * stream, but sourced from the durable session file so it works for terminal
 * AND SDK children alike.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const MAX_TRANSCRIPT_ITEMS = 400;

export type TranscriptItem =
  | { type: "user"; text: string; timestamp: string }
  | {
      type: "assistant";
      text: string;
      thinking?: string;
      timestamp: string;
    }
  | {
      type: "tool";
      name: string;
      toolCallId: string;
      args: Record<string, unknown>;
      result?: string;
      isError?: boolean;
      timestamp: string;
    }
  | { type: "system"; text: string; timestamp: string };

export interface TranscriptReadResult {
  items: TranscriptItem[];
  /** True when a matching session file was found (as opposed to empty dir). */
  found: boolean;
}

interface JsonlEntry {
  type?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
    stopReason?: string;
  };
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

  const items: TranscriptItem[] = [];
  const pendingTools = new Map<string, TranscriptItem & { type: "tool" }>();

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
    if (entry.type !== "message" || !entry.message) continue;
    const msg = entry.message;
    const timestamp = entry.timestamp ?? "";

    if (msg.role === "user") {
      const text = extractText(msg.content);
      if (text) items.push({ type: "user", text, timestamp });
    } else if (msg.role === "assistant") {
      const text = extractText(msg.content);
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
        };
        pendingTools.set(call.id, item);
        items.push(item);
      }
    } else if (msg.role === "toolResult" && msg.toolCallId) {
      const text = extractText(msg.content);
      const existing = pendingTools.get(msg.toolCallId);
      if (existing) {
        existing.result = text || undefined;
        existing.isError = Boolean(msg.isError);
        pendingTools.delete(msg.toolCallId);
      } else {
        // Tool result without a paired call (older files or resumed sessions):
        // synthesize a row so the work is still visible.
        items.push({
          type: "tool",
          name: msg.toolName ?? "tool",
          toolCallId: msg.toolCallId,
          args: {},
          result: text || undefined,
          isError: Boolean(msg.isError),
          timestamp,
        });
      }
    }
  }

  // Keep the latest items (live view tails the conversation).
  if (items.length > MAX_TRANSCRIPT_ITEMS) {
    items.splice(0, items.length - MAX_TRANSCRIPT_ITEMS);
  }
  return { items, found: true };
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