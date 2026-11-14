/**
 * Result passing (`results_from`).
 *
 * A parent that fans work out and then fans it back in used to wait for each
 * completion notice and re-paste the answers into the next task's prompt. A
 * fresh task now names the settled task ids it needs, and the results are
 * injected as one prompt section.
 *
 * The persisted copy is what keeps this working across a parent restart: a
 * settled task records its own result text, so a later admission never has to
 * re-parse a session file to answer. Injection is bounded by the same 8k cap
 * the messaging read uses, because prompt cost — not storage — is the limit.
 *
 * This module stays free of durable-state imports: `conversation.ts` writes
 * through it, so it must not import `conversation.ts` back.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { getLastAssistantResultFromSessionDir } from "./session-text.js";
import type { TaskSessionHistoryEntry } from "./types.js";

/** Chars of one result that may enter a child prompt (`READ_LIMIT_CHARS` pattern). */
export const RESULT_INJECTION_LIMIT_CHARS = 8_000;

export interface ResolvedTaskResult {
  taskId: string;
  agentType: string;
  content: string;
}

/** Cap one result at `limit` chars and say how much was dropped. */
export function truncateResultText(
  text: string,
  limit = RESULT_INJECTION_LIMIT_CHARS,
): string {
  return text.length > limit
    ? `${text.slice(0, limit)}\n[truncated: ${text.length - limit} more characters]`
    : text;
}

type ResultSourceEntry = Pick<
  TaskSessionHistoryEntry,
  "id" | "dir" | "sessionName" | "sessionRef" | "startedAt"
>;

/**
 * The child's final assistant message, read from its session file. Only a
 * completed terminal message counts: a provider failure line is not a result
 * a follow-up task can build on.
 */
export function deriveTaskResultText(entry: ResultSourceEntry): string {
  const dirs: string[] = [];
  if (typeof entry.sessionRef === "string" && entry.sessionRef.length > 0) {
    dirs.push(dirname(entry.sessionRef));
  }
  if (typeof entry.dir === "string" && entry.dir.length > 0) {
    dirs.push(join(entry.dir, "sessions", entry.id));
    dirs.push(entry.dir);
  }
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (seen.has(dir) || !existsSync(dir)) continue;
    seen.add(dir);
    const terminal = getLastAssistantResultFromSessionDir(
      dir,
      entry.sessionName,
      entry.startedAt,
    );
    const content = terminal?.status === "completed" ? terminal.content.trim() : "";
    if (content) return content;
  }
  return "";
}

/**
 * `## Result from <task-id> (<agent_type>)` blocks under one label. The header
 * names both the id (so the child can cite it) and the agent type (so it can
 * weigh the source).
 */
export function formatResultInjection(results: readonly ResolvedTaskResult[]): string {
  return [
    "## Results from previous tasks",
    "",
    "These tasks already settled in this session. Use their results as input; do not redo their work.",
    "",
    ...results.flatMap((result) => [
      `## Result from ${result.taskId} (${result.agentType})`,
      "",
      result.content,
      "",
    ]),
  ].join("\n").trimEnd();
}
