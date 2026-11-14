/**
 * Admission-time resolution of `results_from` ids.
 *
 * Resolution happens once, before any backend resource exists, and for every
 * task alike (foreground, background, durable, terminal): a task either gets
 * the results it named in its prompt or it is refused. Resolving later — at a
 * "drain" point — would need a queue pi-task does not have, and would let a
 * child start without the input it was created for.
 *
 * The injected text is part of the prompt, so a durable resume of that child
 * keeps it in context without re-resolving anything.
 */

import {
  findJsonlSessionByName,
  findTaskSessionHistory,
} from "../conversation.js";
import { ownerAllowsResult, type SessionView } from "../panel/delivery.js";
import {
  deriveTaskResultText,
  formatResultInjection,
  truncateResultText,
  type ResolvedTaskResult,
} from "../result-passing.js";
import type { TaskSessionHistoryEntry } from "../types.js";

export interface ResultsFromRejection {
  content: [{ type: "text"; text: string }];
  details: Record<string, unknown>;
  isError: true;
}

export type ResultsFromResolution =
  | { kind: "resolved"; injection: string; results: ResolvedTaskResult[] }
  | { kind: "rejected"; result: ResultsFromRejection };

function reject(
  text: string,
  details: Record<string, unknown>,
): ResultsFromResolution {
  return {
    kind: "rejected",
    result: { content: [{ type: "text", text }], details, isError: true },
  };
}

/**
 * One referenced task's injectable text.
 *
 * A `done` status is required, not just stored text: a cancelled, timed-out or
 * failed child may still hold a complete assistant turn from earlier work, and
 * injecting that would hand a follow-up task the wrong answer. `resultValid`
 * is not required — an unstructured report is still the child's real report.
 */
function resolveOne(
  piDir: string,
  id: string,
  session: SessionView,
): ResolvedTaskResult | ResultsFromResolution {
  // Durable history first: its recorded `resultText` answers without touching
  // a session file, so injection works on a machine where the child's
  // transcript is gone. The session-name lookup is the fallback for records
  // written before this field existed.
  const entry: TaskSessionHistoryEntry | null | undefined =
    findTaskSessionHistory(piDir, id) ?? findJsonlSessionByName(piDir, id);
  if (!entry) {
    return reject(
      `results_from references "${id}", which is not a task in this project. Pass the id from an earlier "Task ID:" line, or start that task first.`,
      { phase: "failed", error: "unknown_results_from", task_id: id },
    );
  }
  if (!ownerAllowsResult(session, entry)) {
    return reject(
      `results_from references "${entry.id}", which belongs to another Pi session or branch. A result may only be injected into the conversation that spawned that task; run the follow-up from there.`,
      { phase: "failed", error: "results_from_foreign_owner", task_id: entry.id },
    );
  }
  if (entry.status !== "done") {
    return reject(
      `results_from references "${entry.id}" (${entry.agentType}), which is ${entry.status} rather than done. Wait for its result before depending on it; a running or unfinished task has no result to inject.`,
      {
        phase: "failed",
        error: "results_from_not_settled",
        task_id: entry.id,
        task_status: entry.status,
      },
    );
  }
  const text = (entry.resultText ?? deriveTaskResultText(entry)).trim();
  if (!text) {
    return reject(
      `results_from references "${entry.id}" (${entry.agentType}), but its result text was not recorded and its session file has no final message. Read the task with the /task panel or /agents, then pass its content in the prompt instead.`,
      { phase: "failed", error: "results_from_empty", task_id: entry.id },
    );
  }
  return { taskId: entry.id, agentType: entry.agentType, content: truncateResultText(text) };
}

/**
 * Every id in `ids`, in the caller's order, as one injectable prompt section.
 * An empty list resolves to an empty injection so callers can stay
 * unconditional.
 */
export function resolveResultsFrom(input: {
  piDir: string;
  ids: readonly string[] | undefined;
  session: SessionView;
  /** The task being started/resumed; naming it would make it its own input. */
  selfTaskId?: string;
}): ResultsFromResolution {
  const ids = [...new Set((input.ids ?? []).map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return { kind: "resolved", injection: "", results: [] };
  const selfTaskId = input.selfTaskId?.trim();
  if (selfTaskId && ids.includes(selfTaskId)) {
    return reject(
      `results_from references this task's own id "${selfTaskId}"; a task cannot consume its own result. Reference the task that produced the result you need instead.`,
      { phase: "failed", error: "results_from_self_reference", task_id: selfTaskId },
    );
  }

  const results: ResolvedTaskResult[] = [];
  for (const id of ids) {
    const resolved = resolveOne(input.piDir, id, input.session);
    if ("kind" in resolved) return resolved;
    results.push(resolved);
  }
  return { kind: "resolved", injection: formatResultInjection(results), results };
}
