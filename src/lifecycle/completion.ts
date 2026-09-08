import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  findJsonlSessionByName,
  readRegistry,
  updateRegistry,
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
 * Per-process idempotency guard: one execution completes at most once. A task
 * id may be intentionally reused by `resume`, so the execution start time is
 * part of the key rather than treating the durable id as globally unique.
 */
const completedTaskKeys = new Set<string>();

function completionKey(id: string, task: BackgroundTask): string {
  return `${id}\u0000${task.startedAt}`;
}

export interface CompletionDeliveryQueue {
  enqueue(delivery: () => void): void;
  dispose(): void;
}

/**
 * Debounce completion notifications so several tasks settling in one polling
 * window do not each independently interrupt the parent session.
 */
export function createCompletionDeliveryQueue(windowMs = 200): CompletionDeliveryQueue {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Array<() => void> = [];
  const flush = () => {
    timer = undefined;
    const deliveries = pending;
    pending = [];
    for (const delivery of deliveries) {
      try {
        delivery();
      } catch {
        // A stale parent context or one failed send must not block siblings.
      }
    }
  };
  return {
    enqueue(delivery) {
      pending.push(delivery);
      if (timer === undefined) timer = setTimeout(flush, windowMs);
    },
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pending = [];
    },
  };
}

export type CompletionPhase = "done" | "cancelled" | "timeout" | "failed";

export type ComparisonSettledHook = (
  id: string,
  task: BackgroundTask,
  parsed: ParsedResult,
  phase: CompletionPhase,
) => boolean;

export interface CompleteTaskOptions {
  pi: ExtensionAPI;
  id: string;
  task: BackgroundTask;
  content: string;
  phase: CompletionPhase;
  piDir: string;
  resourceCloser?: (task: BackgroundTask) => void;
  deliveryGuard?: () => boolean;
  onComparisonSettled?: ComparisonSettledHook;
  writeRegistryFn?: (piDir: string, entries: RegistryEntry[]) => void;
  deliveryQueue?: CompletionDeliveryQueue;
}

export function completeTask({
  pi,
  id,
  task,
  content,
  phase,
  piDir,
  resourceCloser = closeTaskResource,
  deliveryGuard,
  onComparisonSettled,
  writeRegistryFn = writeRegistry,
  deliveryQueue,
}: CompleteTaskOptions): { cleanupSucceeded: boolean } {
  const key = completionKey(id, task);
  if (completedTaskKeys.has(key)) {
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
  // Discover by task id, never session name: probe roots are id-scoped, so
  // a session-name collision cannot stamp another task's transcript here.
  const completedSessionRef = findJsonlSessionByName(
    piDir,
    id,
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
    runtime: task.runtime,
    ...(task.claudeSessionId !== undefined
      ? { claudeSessionId: task.claudeSessionId }
      : {}),
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
    ...(task.comparisonPartialDelivered !== undefined ||
    priorEntry?.comparisonPartialDelivered !== undefined
      ? {
          comparisonPartialDelivered:
            task.comparisonPartialDelivered ?? priorEntry?.comparisonPartialDelivered,
        }
      : {}),
    ...(task.ownerSessionId !== undefined || priorEntry?.ownerSessionId !== undefined
      ? { ownerSessionId: task.ownerSessionId ?? priorEntry?.ownerSessionId }
      : {}),
    ...(task.ownerLeafId !== undefined || priorEntry?.ownerLeafId !== undefined
      ? {
          ownerLeafId:
            task.ownerLeafId !== undefined ? task.ownerLeafId : priorEntry?.ownerLeafId,
        }
      : {}),
    ...(priorEntry?.ownerPid !== undefined ? { ownerPid: priorEntry.ownerPid } : {}),
  };
  // Keep a terminal cleanup receipt durable across a crash between the
  // state write and backend close. Restore retries it and removes it only
  // after close succeeds. This write runs BEFORE the history upsert: if the
  // registry is unreadable, no terminal phase is recorded at all, so a
  // poll-error retry can never rewrite a recorded done/timeout as failed.
  if (writeRegistryFn === writeRegistry) {
    updateRegistry(piDir, (currentEntries) => {
      const currentEntry = currentEntries.find((entry) => entry.id === id);
      const ownerSessionId = currentEntry?.ownerSessionId ?? priorEntry?.ownerSessionId;
      const ownerLeafId =
        currentEntry?.ownerLeafId !== undefined
          ? currentEntry.ownerLeafId
          : priorEntry?.ownerLeafId;
      const ownerPid = currentEntry?.ownerPid ?? priorEntry?.ownerPid;
      return [
        ...currentEntries.filter((entry) => entry.id !== id),
        {
          ...cleanupEntry,
          ...(ownerSessionId !== undefined ? { ownerSessionId } : {}),
          ...(ownerLeafId !== undefined ? { ownerLeafId } : {}),
          ...(ownerPid !== undefined ? { ownerPid } : {}),
        },
      ];
    });
  } else {
    writeRegistryFn(piDir, [...entries, cleanupEntry]);
  }

  upsertTaskSessionHistory(piDir, {
    id,
    agentType: task.agentType,
    description: task.description,
    sessionName: task.sessionName,
    runtime: task.runtime,
    ...(task.claudeSessionId !== undefined
      ? { claudeSessionId: task.claudeSessionId }
      : {}),
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
    ...(task.comparisonPartialDelivered !== undefined ||
    priorEntry?.comparisonPartialDelivered !== undefined
      ? {
          comparisonPartialDelivered:
            task.comparisonPartialDelivered ?? priorEntry?.comparisonPartialDelivered,
        }
      : {}),
    ...(task.ownerSessionId !== undefined || priorEntry?.ownerSessionId !== undefined
      ? { ownerSessionId: task.ownerSessionId ?? priorEntry?.ownerSessionId }
      : {}),
    ...(task.ownerLeafId !== undefined || priorEntry?.ownerLeafId !== undefined
      ? {
          ownerLeafId:
            task.ownerLeafId !== undefined ? task.ownerLeafId : priorEntry?.ownerLeafId,
        }
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
  completedTaskKeys.add(key);
  if (cleanupSucceeded) {
    try {
      if (writeRegistryFn === writeRegistry) {
        updateRegistry(piDir, (currentEntries) =>
          currentEntries.filter((entry) => entry.id !== id),
        );
      } else {
        writeRegistryFn(piDir, entries);
      }
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

  const deliver = () => ignoreStaleExtensionCtx(() =>
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
  if (deliveryQueue) deliveryQueue.enqueue(deliver);
  else deliver();

  return { cleanupSucceeded };
}
