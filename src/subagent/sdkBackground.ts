import {
  DurableStateError,
  readTaskSessionHistory,
  upsertTaskSessionHistory,
} from "../conversation.js";
import { assessTaskResult, parseResultXml } from "../helpers.js";
import { TASK_BACKGROUND_RECEIPT_GUIDANCE } from "../constants.js";
import { isProcessAliveOrUnknown } from "../process.js";
import type {
  CompletionDeliveryOutcome,
  TaskSessionHistoryEntry,
} from "../types.js";

export interface SdkBackgroundResult {
  output: string;
  sessionId?: string;
  sessionPath?: string | null;
}

export interface SdkBackgroundTaskInput<
  TResult extends SdkBackgroundResult = SdkBackgroundResult,
> {
  id: string;
  agentType: string;
  description: string;
  sessionName: string;
  startedAt: number;
  piDir: string;
  artifactsDir: string;
  cwd?: string;
  conversationId?: string;
  ownerSessionId?: string;
  ownerLeafId?: string | null;
  backend?: TaskSessionHistoryEntry["backend"];
  durableRequestId?: string;
  comparisonGroupId?: string;
  comparisonModel?: string;
  comparisonDescription?: string;
  comparisonIndex?: 0 | 1;
  run: () => Promise<TResult>;
  /** Optional debounce hook for parent notifications. */
  deliver?: (delivery: () => CompletionDeliveryOutcome | void) => void;
  onComplete?: (result: TResult) => CompletionDeliveryOutcome | void;
  onFailed?: (error: unknown) => CompletionDeliveryOutcome | void;
  onSettled?: () => void;
  now?: () => number;
}

/** Fields that vary between the launch/success/failure history writes. */
type HistoryExtras = Partial<
  Pick<
    TaskSessionHistoryEntry,
    "sessionRef" | "reportedStatus" | "rawStatus" | "resultValid" | "completedAt"
  >
>;

function reportDurableRecordFailure(error: unknown, phase: string): void {
  if (error instanceof DurableStateError) {
    console.error(`[pi-task] SDK background ${phase} durable record failed: ${error.message}`);
  }
}

export function startSdkBackgroundTask<TResult extends SdkBackgroundResult>(
  input: SdkBackgroundTaskInput<TResult>,
): void {
  const now = input.now ?? Date.now;
  const dispatchNotification = (
    notify: () => CompletionDeliveryOutcome | void,
  ) => {
    try {
      if (input.deliver) input.deliver(notify);
      else notify();
    } catch {
      // Dispatch failures must not rewrite an already-settled task status.
    }
  };

  // Shared durable-record shape; `extra` keys are spread so absent keys keep
  // upsert's merge semantics (no accidental field clobbering).
  const record = (
    status: TaskSessionHistoryEntry["status"],
    extra?: HistoryExtras,
  ) => {
    upsertTaskSessionHistory(input.piDir, {
      id: input.id,
      agentType: input.agentType,
      description: input.description,
      sessionName: input.sessionName,
      startedAt: input.startedAt,
      piDir: input.piDir,
      dir: input.artifactsDir,
      cwd: input.cwd,
      ...(input.conversationId !== undefined
        ? { conversationId: input.conversationId }
        : {}),
      backend: input.backend ?? "sdk",
      ...(input.durableRequestId !== undefined
        ? { durableRequestId: input.durableRequestId }
        : {}),
      ownerSessionId: input.ownerSessionId,
      ownerLeafId: input.ownerLeafId,
      ownerPid: process.pid,
      status,
      background: true,
      comparisonGroupId: input.comparisonGroupId,
      comparisonModel: input.comparisonModel,
      comparisonDescription: input.comparisonDescription,
      comparisonIndex: input.comparisonIndex,
      ...extra,
    });
  };

  try {
    record("running");
  } catch (error) {
    reportDurableRecordFailure(error, "launch");
    // A durable-write failure at launch must not prevent the task from
    // starting; the lifecycle handlers below keep their own guards.
  }

  // Promise.resolve().then defers input.run() so a synchronous throw is
  // routed through the failure path instead of escaping this function.
  // Each step is guarded separately: a failed durable write must not skip
  // the callbacks, and a completed task must never be rewritten as failed
  // because its own notification threw.
  void Promise.resolve()
    .then(() => input.run())
    .then((result) => {
      const assessment = assessTaskResult(parseResultXml(result.output));
      try {
        record("done", {
          sessionRef: result.sessionPath ?? undefined,
          reportedStatus: assessment.reportedStatus,
          rawStatus: assessment.rawStatus,
          resultValid: assessment.valid,
          completedAt: now(),
        });
      } catch (error) {
        reportDurableRecordFailure(error, "completion");
        // See the step-guard note above.
      }
      const notify = () => input.onComplete?.(result);
      dispatchNotification(notify);
    })
    .catch((error: unknown) => {
      const kind =
        error !== null && typeof error === "object"
          ? (error as { kind?: unknown }).kind
          : undefined;
      const status: TaskSessionHistoryEntry["status"] =
        kind === "timeout" ? "timeout" : kind === "cancelled" ? "cancelled" : "failed";
      try {
        record(status, { completedAt: now() });
      } catch (error) {
        reportDurableRecordFailure(error, "failure");
        // Best-effort durable record of the failure.
      }
      const notify = () => input.onFailed?.(error);
      dispatchNotification(notify);
    })
    .finally(() => {
      try {
        input.onSettled?.();
      } catch {
        // Settled callbacks must never reject the lifecycle chain.
      }
    })
    .catch(() => {
      // Terminal guard: no unhandled rejections from the task lifecycle.
    });
}

/**
 * SDK work lives in the host process and cannot be resumed after a restart.
 * Reconcile its running history rows before normal restore/replay so a dead
 * host never leaves an indefinitely-running task behind.
 */
export function reconcileStaleSdkBackgroundTasks(
  piDir: string,
  durableTaskIds: ReadonlySet<string> = new Set(),
  options: {
    sessionId?: string;
    isProcessAlive?: (pid: number) => boolean;
  } = {},
): string[] {
  const staleIds: string[] = [];
  const isProcessAlive = options.isProcessAlive ?? isProcessAliveOrUnknown;
  for (const entry of readTaskSessionHistory(piDir)) {
    if (
      entry.status !== "running" ||
      !entry.background ||
      entry.handle ||
      entry.paneId ||
      durableTaskIds.has(entry.id) ||
      (entry.backend === undefined && entry.comparisonGroupId === undefined) ||
      (entry.backend !== undefined && entry.backend !== "sdk")
    ) {
      continue;
    }
    const foreignOwner =
      entry.ownerSessionId !== undefined &&
      (options.sessionId === undefined ||
        options.sessionId === "" ||
        entry.ownerSessionId !== options.sessionId);
    if (entry.ownerPid !== undefined && isProcessAlive(entry.ownerPid)) continue;
    if (foreignOwner && entry.ownerPid === undefined) continue;
    staleIds.push(entry.id);
    upsertTaskSessionHistory(piDir, {
      ...entry,
      status: "failed",
      reportedStatus: "failure",
      rawStatus: "host-restarted",
      resultValid: false,
      completedAt: Date.now(),
    });
  }
  return staleIds;
}

export function formatSdkBackgroundReceipt(id: string): string {
  return [
    `Task ${id} is running in the background.`,
    "The host process will keep the task alive while the parent Pi process is running and will surface its sub-session when it finishes.",
    TASK_BACKGROUND_RECEIPT_GUIDANCE,
  ].join("\n");
}
