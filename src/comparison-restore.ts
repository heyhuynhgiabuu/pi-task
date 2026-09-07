import { dirname, join } from "node:path";

import {
  readTaskSessionHistory,
} from "./conversation.js";
import {
  assessTaskResult,
  countToolUses,
  parseResultXml,
  type ComparisonRunResult,
} from "./helpers.js";
import { ComparisonCoordinator } from "./comparison.js";
import { getLastAssistantResultFromSessionDir } from "./session-text.js";
import type { BackgroundTask, TaskSessionHistoryEntry } from "./types.js";

export type ComparisonRestoreDeferReason = "mixed_owner" | "partial_owner";

export interface ComparisonRestoreDiagnostic {
  groupId: string;
  taskIds: [string, string];
  reason: ComparisonRestoreDeferReason;
}

export type ComparisonRestoreObserver = (
  diagnostic: ComparisonRestoreDiagnostic,
) => void;

function comparisonRunFromHistory(
  entry: TaskSessionHistoryEntry,
): ComparisonRunResult | undefined {
  if (entry.status === "running" || !entry.comparisonModel) return undefined;

  const sessionDir = entry.sessionRef
    ? dirname(entry.sessionRef)
    : join(entry.dir, "sessions", entry.id);
  let output = "";
  let sessionFailure: string | undefined;
  try {
    const sessionResult = getLastAssistantResultFromSessionDir(
      sessionDir,
      entry.sessionName,
      entry.startedAt,
    );
    if (sessionResult?.status === "completed") output = sessionResult.content;
    else if (sessionResult?.status === "failed") sessionFailure = sessionResult.content;
  } catch {
    // The durable history record still provides a terminal status if the
    // session file is temporarily unavailable during restoration.
  }

  const parsed = parseResultXml(output);
  const assessment = assessTaskResult(parsed);
  const completedNormally = entry.status === "done" && sessionFailure === undefined;
  const { toolUses } = countToolUses(sessionDir, entry.sessionName);
  return {
    model: entry.comparisonModel,
    taskId: entry.id,
    status: completedNormally
      ? entry.reportedStatus ?? assessment.reportedStatus
      : "failure",
    rawStatus: entry.rawStatus ?? (completedNormally ? assessment.rawStatus : entry.status),
    summary: parsed.summary,
    findings: parsed.findings,
    evidence: parsed.evidence,
    files: parsed.files,
    caveats: parsed.caveats,
    nextSteps: parsed.next_steps,
    toolUses,
    durationMs: Math.max(0, (entry.completedAt ?? entry.startedAt) - entry.startedAt),
    sessionPath: entry.sessionRef,
    error: completedNormally
      ? undefined
      : sessionFailure || parsed.summary || `Task ${entry.status}`,
  };
}

interface RestoredComparisonRecord {
  id: string;
  groupId: string;
  agentType: string;
  description: string;
  model: string;
  index?: 0 | 1;
  task?: BackgroundTask;
  history?: TaskSessionHistoryEntry;
}

export function restoreComparisonGroups(
  piDir: string,
  backgroundTasks: Map<string, BackgroundTask>,
  coordinator: ComparisonCoordinator,
  currentSessionId?: string,
  onDeferredGroup?: ComparisonRestoreObserver,
): ComparisonRunResult[] {
  const byGroup = new Map<string, Map<string, RestoredComparisonRecord>>();
  const add = (record: RestoredComparisonRecord): void => {
    const siblings = byGroup.get(record.groupId) ?? new Map();
    const existing = siblings.get(record.id);
    if (existing) {
      existing.task ??= record.task;
      existing.history ??= record.history;
    } else {
      siblings.set(record.id, record);
    }
    byGroup.set(record.groupId, siblings);
  };

  for (const [id, task] of backgroundTasks) {
    if (!task.comparisonGroupId || !task.comparisonModel) continue;
    add({
      id,
      groupId: task.comparisonGroupId,
      agentType: task.agentType,
      description: task.comparisonDescription ?? task.description,
      model: task.comparisonModel,
      index: task.comparisonIndex,
      task,
    });
  }

  for (const history of readTaskSessionHistory(piDir)) {
    const backend = history.handle?.backend ?? history.backend;
    const terminal =
      backend === "tmux" ||
      backend === "herdr" ||
      Boolean(history.paneId) ||
      Boolean(history.sessionRef) ||
      Boolean(
        history.background &&
          history.status !== "running" &&
          history.comparisonGroupId &&
          history.comparisonModel,
      );
    if (
      !history.background ||
      !terminal ||
      !history.comparisonGroupId ||
      !history.comparisonModel ||
      (history.status === "running" && !backgroundTasks.has(history.id))
    ) {
      continue;
    }
    add({
      id: history.id,
      groupId: history.comparisonGroupId,
      agentType: history.agentType,
      description: history.comparisonDescription ?? history.description,
      model: history.comparisonModel,
      index: history.comparisonIndex,
      history,
    });
  }

  const pendingRuns: ComparisonRunResult[] = [];
  for (const [groupId, siblings] of byGroup) {
    if (siblings.size !== 2) continue;
    const ordered = [...siblings.values()].sort(
      (a, b) =>
        (a.index ?? Number.MAX_SAFE_INTEGER) -
          (b.index ?? Number.MAX_SAFE_INTEGER) ||
        a.id.localeCompare(b.id),
    );
    const first = ordered[0];
    const second = ordered[1];
    if (!first || !second) continue;

    // A comparison report combines both siblings, so it must never be
    // reconstructed by a session when ownership is split between sessions
    // (including a partially migrated sibling with no owner metadata).
    const ownerSessionIds = ordered.flatMap((record) => {
      const taskOwner = record.task?.ownerSessionId;
      const historyOwner = record.history?.ownerSessionId;
      if (taskOwner !== undefined && historyOwner !== undefined && taskOwner !== historyOwner) {
        return [taskOwner, historyOwner];
      }
      return [historyOwner ?? taskOwner];
    });
    const hasOwnership = ownerSessionIds.some((owner) => owner !== undefined);
    const distinctOwners = new Set(ownerSessionIds.filter((owner): owner is string => owner !== undefined));
    if (
      distinctOwners.size > 1 ||
      (hasOwnership && ownerSessionIds.some((owner) => owner === undefined))
    ) {
      try {
        onDeferredGroup?.({
          groupId,
          taskIds: [first.id, second.id],
          reason: distinctOwners.size > 1 ? "mixed_owner" : "partial_owner",
        });
      } catch {
        // Diagnostics are best-effort and must not block durable replay.
      }
      continue;
    }

    const histories = ordered.map((record) => record.history);
    if (
      ordered.some(
        (record) =>
          record.history?.comparisonPartialDelivered === true ||
          record.task?.comparisonPartialDelivered === true,
      )
    ) {
      continue;
    }
    if (
      histories.every(
        (history) =>
          history &&
          history.status !== "running" &&
          history.comparisonDelivered === true,
      )
    ) {
      continue;
    }

    coordinator.registerGroup(
      groupId,
      groupId,
      first.agentType,
      first.description,
      [first.id, second.id],
      [first.model, second.model],
    );

    for (const record of ordered) {
      if (!record.history || record.history.comparisonDelivered === true) continue;
      // A group owned by another session (issue #20) is not replayed here:
      // its owning process delivers it; this session can still read the
      // results through durable-history lookups.
      if (
        currentSessionId &&
        record.history.ownerSessionId !== undefined &&
        record.history.ownerSessionId !== currentSessionId
      ) {
        continue;
      }
      const run = comparisonRunFromHistory(record.history);
      if (run) pendingRuns.push(run);
    }
  }
  return pendingRuns;
}
