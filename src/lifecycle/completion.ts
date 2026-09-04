import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  findJsonlSessionByName,
  readRegistry,
  upsertTaskSessionHistory,
  writeRegistry,
} from "../conversation.js";
import {
  assessTaskResult,
  completionDeliveryOptions,
  parseResultXml,
  structuredResultPayload,
  unrecognizedStatusWarning,
  type ParsedResult,
} from "../helpers.js";
import { createSyncHerdrControl } from "../subagent/herdr.js";
import { killAgentPaneStrict } from "../subagent/tmux.js";
import { ignoreStaleExtensionCtx } from "../stale-ctx.js";
import type { BackgroundTask, RegistryEntry } from "../types.js";

function closeTaskResource(task: BackgroundTask): void {
  if (task.handle?.backend === "herdr") {
    if (
      task.handle.foregroundProcessGroupId === undefined
    ) {
      throw new Error("HerdR cleanup requires persisted agent identity");
    }
    createSyncHerdrControl().close(task.handle);
  } else if (task.paneId) {
    killAgentPaneStrict(task.paneId, task.originalPane);
  }
}

/**
 * Per-process idempotency guard: a task id completes at most once. Without it,
 * a second completeTask call for the same id would re-deliver the task-complete
 * notification and re-close the terminal resource. The only callers (polling,
 * cancel) already guard via the live-map identity check, but this makes the
 * latent double-delivery footgun a no-op for any future caller.
 */
const completedTaskIds = new Set<string>();

export type ComparisonSettledHook = (
  id: string,
  task: BackgroundTask,
  parsed: ParsedResult,
  phase: "done" | "cancelled" | "timeout" | "failed",
) => boolean;

export function completeTask(
  pi: ExtensionAPI,
  id: string,
  task: BackgroundTask,
  content: string,
  phase: "done" | "cancelled" | "timeout" | "failed",
  piDir: string,
  resourceCloser: (task: BackgroundTask) => void = closeTaskResource,
  deliveryGuard?: () => boolean,
  onComparisonSettled?: ComparisonSettledHook,
  writeRegistryFn: (piDir: string, entries: RegistryEntry[]) => void = writeRegistry,
): { cleanupSucceeded: boolean } {
  if (completedTaskIds.has(id)) {
    // Already fully processed in this process: never re-deliver or re-close.
    return { cleanupSucceeded: true };
  }
  const parsed = parseResultXml(content);
  const assessment = assessTaskResult(parsed);
  const durationMs = Date.now() - task.startedAt;
  // Record the terminal phase on the live task so panel rows (and the
  // finished-linger) render the correct status/icon instead of defaulting
  // failed/timeout/cancelled to a green "done".
  task.status = phase;
  const completedSessionRef = findJsonlSessionByName(
    piDir,
    task.sessionName,
    task.agentType,
  )?.sessionRef;

  const allEntries = readRegistry(piDir);
  const priorEntry = allEntries.find((entry) => entry.id === id);
  const entries = allEntries.filter((entry) => entry.id !== id);
  const cleanupEntry: RegistryEntry = {
    id,
    agentType: task.agentType,
    description: task.description,
    sessionName: task.sessionName,
    startedAt: task.startedAt,
    handle: task.handle,
    paneId: task.paneId,
    piDir,
    dir: task.dir,
    cwd: task.cwd,
    conversationId: task.conversationId,
    sessionRef: completedSessionRef,
    cleanupPending: true,
    cleanupPhase: phase,
    comparisonGroupId: task.comparisonGroupId,
    comparisonModel: task.comparisonModel,
    comparisonDescription: task.comparisonDescription,
    comparisonIndex: task.comparisonIndex,
    comparisonDelivered: task.comparisonDelivered,
    ...(priorEntry?.ownerSessionId !== undefined
      ? { ownerSessionId: priorEntry.ownerSessionId }
      : {}),
    ...(priorEntry?.ownerPid !== undefined ? { ownerPid: priorEntry.ownerPid } : {}),
  };
  // Keep a terminal cleanup receipt durable across a crash between the
  // state write and backend close. Restore retries it and removes it only
  // after close succeeds. This write runs BEFORE the history upsert: if the
  // registry is unreadable, no terminal phase is recorded at all, so a
  // poll-error retry can never rewrite a recorded done/timeout as failed.
  writeRegistryFn(piDir, [...entries, cleanupEntry]);

  upsertTaskSessionHistory(piDir, {
    id,
    agentType: task.agentType,
    description: task.description,
    sessionName: task.sessionName,
    startedAt: task.startedAt,
    paneId: task.paneId,
    handle: task.handle,
    piDir,
    dir: task.dir,
    cwd: task.cwd,
    conversationId: task.conversationId,
    sessionRef: completedSessionRef,
    status: phase,
    reportedStatus: assessment.reportedStatus,
    rawStatus: assessment.rawStatus,
    resultValid: assessment.valid,
    completedAt: Date.now(),
    background: true,
    comparisonGroupId: task.comparisonGroupId,
    comparisonModel: task.comparisonModel,
    comparisonDescription: task.comparisonDescription,
    comparisonIndex: task.comparisonIndex,
    comparisonDelivered: task.comparisonDelivered,
    ...(priorEntry?.ownerSessionId !== undefined
      ? { ownerSessionId: priorEntry.ownerSessionId }
      : {}),
    ...(priorEntry?.ownerPid !== undefined ? { ownerPid: priorEntry.ownerPid } : {}),
  });

  let cleanupSucceeded = true;
  try {
    resourceCloser(task);
  } catch {
    cleanupSucceeded = false;
  }
  // Terminal state is durable and the resource is closed (or its close is
  // recorded as pending): mark settled BEFORE the best-effort removal write
  // so a failed removal can never trigger a retry that re-closes a resource
  // (herdr close is not idempotent).
  completedTaskIds.add(id);
  if (cleanupSucceeded) {
    try {
      writeRegistryFn(piDir, entries);
    } catch {
      // The cleanupPending receipt written above stays durable and restore
      // retries cleanup (missing panes are tolerated and clear the receipt).
    }
  }

  const summaryText = parsed.summary?.trim()
    ? parsed.summary.trim()
    : content.replace(/\s+/g, " ").trim().slice(0, 240);
  const warning = unrecognizedStatusWarning(assessment);

  if (onComparisonSettled && onComparisonSettled(id, task, parsed, phase)) {
    return { cleanupSucceeded };
  }

  // pi-subtask delivery-guard pattern: skip the in-conversation result
  // when the conversation that spawned the task is no longer the one we
  // are in. The result stays durable in task-session history and the
  // child session file either way.
  if (deliveryGuard && !deliveryGuard()) {
    return { cleanupSucceeded };
  }

  ignoreStaleExtensionCtx(() =>
    pi.sendMessage(
      {
        customType: "task-complete",
        content: `Background task ${id} (${task.agentType}) ${phase}.\n\n${warning ? warning + "\n\n" : ""}${summaryText}`,
        display: true,
        details: {
          task_id: id,
          agent_type: task.agentType,
          description: task.description,
          phase,
          execution_phase: phase,
          status: assessment.reportedStatus,
          reported_status: assessment.reportedStatus,
          raw_status: assessment.rawStatus,
          result_valid: assessment.valid,
          result: content,
          summary: parsed.summary,
          findings: parsed.findings,
          evidence: parsed.evidence,
          files: parsed.files,
          caveats: parsed.caveats,
          next_steps: parsed.next_steps,
          confidence: parsed.confidence,
          duration_ms: durationMs,
          tool_uses: task.toolUses,
          turn_count: task.turns,
          background: true,
          structured_result: structuredResultPayload(assessment),
          full_output: parsed.raw.trim() || content.trim(),
        },
      },
      completionDeliveryOptions(process.env.PI_TASK_COMPLETION_DELIVERY),
    ),
  );

  return { cleanupSucceeded };
}