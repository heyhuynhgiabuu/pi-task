/**
 * The durable execution backend: subagent work runs as pi-durable
 * conversations over SQLite (see src/subagent/durable.ts), so a parent crash
 * no longer loses in-flight children the way the SDK backend does.
 *
 * Receipts, history rows, widget rows, and delivery deliberately reuse the
 * SDK machinery (startSdkBackgroundTask, buildTaskEnvelope, completion
 * delivery) — only the child runtime differs.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  type DurableModelsFactory,
  type DurableRuntimeModelRegistry,
  type DurableUsage,
  durableDatabasePath,
  durableRequestId,
  inspectDurableDatabasePath,
  DurableTaskCancelledError,
  inspectDurableTaskAdmission,
  parseDurableThinkingLevel,
  releaseUnadmittedDurableRun,
  resumeDurableTasks,
  runDurableTask,
} from "../subagent/durable.js";
import { gptConfigFastEnabled } from "../fast-mode.js";
import {
  failUnadmittedTaskSessionHistory,
  findTaskSessionHistory,
  readTaskSessionHistory,
  upsertTaskSessionHistory,
} from "../conversation.js";
import type {
  TaskSessionHistoryEntry,
  BackgroundTask,
  CompletionDeliveryOutcome,
} from "../types.js";
import {
  assessTaskResult,
  buildTaskEnvelope,
  formatTaskIdPointer,
  parseResultXml,
  structuredResultPayload,
  taskResultContentText,
  type AgentConfig,
} from "../helpers.js";
import { sessionViewOf, type DeliveryGuard } from "../panel/delivery.js";
import { durableParentOf } from "./ownership.js";
import type { TaskWidgetController } from "./widget.js";
import { DurableTranscript, type DurableChildAgent } from "../panel/durable-transcript.js";
import { isProcessAliveOrUnknown } from "../process.js";
import type { TranscriptItem } from "../panel/transcript.js";
import type { ChildUsageMetadata } from "../panel/child-metadata.js";
import { startSdkBackgroundTask } from "../subagent/sdkBackground.js";
import { ignoreStaleExtensionCtx } from "../stale-ctx.js";
import { completionDeliveryId, sendCompletionNotice } from "./completion.js";

export interface DurableTaskExecutionOptions {
  id: string;
  agent: AgentConfig;
  description: string;
  sessionName: string;
  prompt: string;
  cwd: string;
  ctx: ExtensionContext;
  pi: ExtensionAPI;
  piDir: string;
  artifactsDir: string;
  conversationId?: string;
  toolCallId?: string;
  signal?: AbortSignal;
  /** Mirror the parent's fast mode onto the child's Codex requests. */
  fast?: boolean;
  isBackground: boolean;
  backgroundTasks: Map<string, BackgroundTask>;
  foregroundTasks: Map<string, BackgroundTask>;
  deliveryGuard: DeliveryGuard;
  taskWidget: TaskWidgetController;
  clearTaskWidgetIfIdle: () => void;
  ensureTaskWidget: () => void;
  enqueueDelivery: (
    delivery: () => CompletionDeliveryOutcome | void,
    deliveryId: string,
  ) => void;
  /** Runner injection for lifecycle tests; production uses runDurableTask. */
  runTask?: typeof runDurableTask;
}

export function formatDurableBackgroundReceipt(id: string): string {
  return [
    `Task ${id} is running on the durable backend.`,
    "Its work is committed to durable storage: if this Pi process dies, the next one resumes and delivers the result.",
    "Results are delivered automatically; do not poll.",
  ].join("\n");
}

/**
 * Finish submissions a previous process left running on this repo's durable
 * storage and deliver their results: recovered answers become task-complete
 * messages (guarded by session ownership), failures become failure messages.
 * Best-effort end to end — a history write failure never blocks delivery.
 */
export async function resumeDurableAfterRestart(deps: {
  pi: ExtensionAPI;
  piDir: string;
  /** Current session id; another session's tasks are left to that session. */
  sessionId?: string;
  /** Test seams, mirroring the controller's open options. */
  databasePath?: string;
  models?: DurableModelsFactory;
  modelRegistry?: DurableRuntimeModelRegistry;
  /** Restore the non-focusing task row before attaching its live transcript. */
  onTaskResumed?: (
    taskId: string,
    history: TaskSessionHistoryEntry | undefined,
    conversationId: string,
  ) => void;
  onTaskProgress?: (
    taskId: string,
    items: readonly TranscriptItem[],
    toolUses: number,
    /** The child conversation's own `pi.agent` state, when it has one. */
    agent?: DurableChildAgent,
    metadata?: ChildUsageMetadata,
  ) => void;
  onTaskWatchError?: (
    taskId: string,
    items: readonly TranscriptItem[],
    toolUses: number,
    error: unknown,
  ) => void;
  onTaskSettled?: (
    taskId: string,
    history: TaskSessionHistoryEntry | undefined,
    status: "done" | "failed" | "cancelled",
  ) => void;
  enqueueDelivery?: (
    deliveryId: string,
    delivery: () => CompletionDeliveryOutcome | void,
  ) => void;
}): Promise<ReadonlySet<string>> {
  const { pi, piDir, sessionId } = deps;
  const durableTaskIds = new Set<string>();
  const databasePath = deps.databasePath ?? durableDatabasePath(piDir);
  const storage = inspectDurableDatabasePath(databasePath);
  if (storage.kind === "missing") return durableTaskIds;
  if (storage.kind === "unreadable") throw storage.error;
  const notify = (
    deliveryId: string,
    content: string,
    details: Record<string, unknown>,
  ) => {
    const deliver = (): CompletionDeliveryOutcome | void =>
      sendCompletionNotice(pi, {
        customType: "task-complete",
        content,
        display: true,
        details: { ...details, completion_delivery_id: deliveryId },
      });
    if (deps.enqueueDelivery) deps.enqueueDelivery(deliveryId, deliver);
    else deliver();
  };
  const owned = (taskId: string): TaskSessionHistoryEntry | "other-session" | undefined => {
    const history = findTaskSessionHistory(piDir, taskId);
    // Another session's task belongs to that session's resume pass.
    if (history?.ownerSessionId !== undefined && history.ownerSessionId !== sessionId) {
      return "other-session";
    }
    return history;
  };

  const resumedTranscripts = new Map<string, DurableTranscript>();
  const resumedHistory = new Map<string, TaskSessionHistoryEntry | undefined>();
  const authorizedTasks = new Set<string>();
  await resumeDurableTasks(
    piDir,
    {
      shouldRecover: (taskId, requestId) => {
        const history = owned(taskId);
        if (history === "other-session") return false;
        if (!history) return true;
        return history.status === "running" &&
          (history.durableRequestId === undefined || history.durableRequestId === requestId);
      },
      requestIdForTask: (taskId) => {
        const history = owned(taskId);
        return history && history !== "other-session"
          ? history.durableRequestId
          : undefined;
      },
      onActive: (taskId, conversationId) => {
        durableTaskIds.add(taskId);
        const history = owned(taskId);
        if (history === "other-session") return false;
        const durableHistory = history && history.backend !== "durable"
          ? { ...history, backend: "durable" as const }
          : history;
        if (durableHistory && durableHistory !== history) {
          try {
            upsertTaskSessionHistory(piDir, durableHistory);
          } catch {
            // In-memory discovery still protects this task from stale-SDK reconciliation.
          }
        }
        resumedHistory.set(taskId, durableHistory);
        authorizedTasks.add(taskId);
        try {
          deps.onTaskResumed?.(taskId, durableHistory, conversationId);
        } catch {
          // A UI restore failure must not prevent the durable submission resuming.
        }
        return true;
      },
      onSnapshot: (taskId, snapshot) => {
        const transcript = new DurableTranscript(snapshot);
        resumedTranscripts.set(taskId, transcript);
        deps.onTaskProgress?.(
          taskId,
          transcript.items(),
          transcript.toolCallCount(),
          transcript.agentState(),
          transcript.usageMetadata(),
        );
      },
      onEvents: (taskId, events) => {
        const transcript = resumedTranscripts.get(taskId);
        if (!transcript) return;
        deps.onTaskProgress?.(
          taskId,
          transcript.apply(events),
          transcript.toolCallCount(),
          transcript.agentState(),
          transcript.usageMetadata(),
        );
      },
      onWatchError: (taskId, error) => {
        if (!authorizedTasks.has(taskId)) return;
        const transcript = resumedTranscripts.get(taskId);
        deps.onTaskWatchError?.(
          taskId,
          transcript?.items() ?? [],
          transcript?.toolCallCount() ?? 0,
          error,
        );
      },
      onSettled: (taskId, status) => {
        if (!authorizedTasks.delete(taskId)) return;
        const history = resumedHistory.get(taskId);
        resumedHistory.delete(taskId);
        resumedTranscripts.delete(taskId);
        try {
          deps.onTaskSettled?.(taskId, history, status);
        } catch {
          // A UI cleanup failure must not alter the recovered result.
        }
      },
      onRecovered: (taskId, output, usage) => {
        const history = owned(taskId);
        if (history === "other-session" || (history && history.status !== "running")) return;
        const parsed = parseResultXml(output);
        const assessment = assessTaskResult(parsed);
        if (history) {
          try {
            upsertTaskSessionHistory(piDir, {
              ...history,
              status: "done",
              reportedStatus: assessment.reportedStatus,
              rawStatus: assessment.rawStatus,
              resultValid: assessment.valid,
              completedAt: Date.now(),
            });
          } catch {
            // History is best-effort; delivery below still runs.
          }
        }
        const summary = taskResultContentText(parsed, assessment) || output.trim();
        notify(
          completionDeliveryId(taskId, history?.startedAt ?? Date.now()),
          `Background task ${taskId} (durable) resumed after restart and finished.\n\n${summary}`,
          {
            usage,
            agent_type: history?.agentType ?? "task",
            description: history?.description ?? "",
            phase: "done",
            execution_phase: "done",
            status: assessment.reportedStatus,
            reported_status: assessment.reportedStatus,
            raw_status: assessment.rawStatus,
            result_valid: assessment.valid,
            result: output,
            summary: parsed.summary,
            findings: parsed.findings,
            evidence: parsed.evidence,
            files: parsed.files,
            caveats: parsed.caveats,
            next_steps: parsed.next_steps,
            background: true,
            backend: "durable",
            task_id: taskId,
            resumed: true,
            structured_result: structuredResultPayload(assessment),
            full_output: parsed.raw.trim() || output.trim(),
          },
        );
      },
      onCancelled: (taskId, reason, usage) => {
        const history = owned(taskId);
        if (history === "other-session" || (history && history.status !== "running")) return;
        if (history) {
          try {
            upsertTaskSessionHistory(piDir, {
              ...history,
              status: "cancelled",
              completedAt: Date.now(),
            });
          } catch {
            // History is best-effort.
          }
        }
        notify(
          completionDeliveryId(taskId, history?.startedAt ?? Date.now()),
          `Background task ${taskId} (durable) was cancelled.\n\n${reason}`,
          {
            agent_type: history?.agentType ?? "task",
            description: history?.description ?? "",
            phase: "cancelled",
            execution_phase: "cancelled",
            status: "unknown",
            reported_status: "unknown",
            result_valid: false,
            background: true,
            backend: "durable",
            task_id: taskId,
            resumed: true,
            error: reason,
            ...(usage ? { usage } : {}),
          },
        );
      },
      onFailed: (taskId, reason, usage) => {
        const history = owned(taskId);
        if (history === "other-session" || (history && history.status !== "running")) return;
        if (history) {
          try {
            upsertTaskSessionHistory(piDir, {
              ...history,
              status: "failed",
              completedAt: Date.now(),
            });
          } catch {
            // History is best-effort.
          }
        }
        notify(
          completionDeliveryId(taskId, history?.startedAt ?? Date.now()),
          `Background task ${taskId} (durable) did not survive the restart.\n\n${reason}`,
          {
            agent_type: history?.agentType ?? "task",
            description: history?.description ?? "",
            phase: "failed",
            status: "unknown",
            result_valid: false,
            background: true,
            backend: "durable",
            task_id: taskId,
            resumed: true,
            error: reason,
            ...(usage ? { usage } : {}),
          },
        );
      },
    },
    {
      databasePath: deps.databasePath,
      models: deps.models,
      modelRegistry: deps.modelRegistry,
      fast: (typeof deps.pi.getFlag === "function" && deps.pi.getFlag("fast") === true) ||
        gptConfigFastEnabled(
          typeof deps.pi.getSettings === "function"
            ? (deps.pi.getSettings() as Record<string, unknown> | undefined)
            : undefined,
        ),
    },
  );
  return durableTaskIds;
}

/**
 * Clear running history only when the exact durable request is known not to
 * have been admitted. A missing store proves no child submission survived;
 * unreadable storage and legacy records without an exact request stay intact.
 */
export async function reconcileUnadmittedDurableTasks(deps: {
  piDir: string;
  sessionId?: string;
  recoveredTaskIds: ReadonlySet<string>;
  activeTaskIds?: ReadonlySet<string>;
  isProcessAlive?: (pid: number) => boolean;
  databasePath?: string;
  models?: DurableModelsFactory;
  modelRegistry?: DurableRuntimeModelRegistry;
}): Promise<string[]> {
  const reconciled: string[] = [];
  const isProcessAlive = deps.isProcessAlive ?? isProcessAliveOrUnknown;
  for (const history of readTaskSessionHistory(deps.piDir)) {
    const ownerProcessAlive = history.ownerPid === undefined
      ? undefined
      : isProcessAlive(history.ownerPid);
    if (
      history.status !== "running" ||
      history.backend !== "durable" ||
      deps.recoveredTaskIds.has(history.id) ||
      deps.activeTaskIds?.has(history.id) ||
      (history.ownerSessionId !== undefined &&
        (deps.sessionId === undefined ||
          deps.sessionId === "" ||
          history.ownerSessionId !== deps.sessionId)) ||
      ownerProcessAlive === true
    ) {
      continue;
    }

    const admission = await inspectDurableTaskAdmission(
      deps.piDir,
      history.id,
      history.durableRequestId,
      {
        databasePath: deps.databasePath,
        models: deps.models,
        modelRegistry: deps.modelRegistry,
      },
    );
    if (admission.kind !== "unadmitted") continue;
    if (admission.reason === "submission-missing") {
      // A reservation can still be between reserve and submit in a live owner.
      // Only a positively dead process makes this admission-only record stale.
      if (
        !history.durableRequestId ||
        history.ownerPid === undefined ||
        ownerProcessAlive !== false
      ) continue;
      const released = await releaseUnadmittedDurableRun(
        deps.piDir,
        history.id,
        history.durableRequestId,
        history.ownerPid,
        {
          databasePath: deps.databasePath,
          models: deps.models,
          modelRegistry: deps.modelRegistry,
        },
      );
      if (!released) continue;
    }

    if (failUnadmittedTaskSessionHistory(
      deps.piDir,
      {
        id: history.id,
        status: history.status,
        durableRequestId: history.durableRequestId,
        ownerPid: history.ownerPid,
      },
      Date.now(),
    )) {
      reconciled.push(history.id);
    }
  }
  return reconciled;
}

export async function executeDurableTask({
  id,
  agent,
  description,
  sessionName,
  prompt,
  cwd,
  ctx,
  pi,
  piDir,
  artifactsDir,
  conversationId,
  toolCallId,
  signal,
  fast,
  isBackground,
  backgroundTasks,
  foregroundTasks,
  deliveryGuard,
  taskWidget,
  clearTaskWidgetIfIdle,
  ensureTaskWidget,
  enqueueDelivery,
  runTask: runTaskOverride,
}: DurableTaskExecutionOptions) {
  const startedAt = Date.now();
  const runnerAbortController = new AbortController();
  const forwardForegroundAbort = () => runnerAbortController.abort();
  const model = agent.model;
  const sessionModel = ctx.model
    ? { provider: ctx.model.provider, modelId: ctx.model.id }
    : undefined;
  const owner = durableParentOf(sessionViewOf(ctx));
  const requestId = durableRequestId(id, toolCallId);
  const notify = (
    content: string,
    details: Record<string, unknown>,
  ): CompletionDeliveryOutcome | void =>
    sendCompletionNotice(pi, {
      customType: "task-complete",
      content,
      display: true,
      details: { ...details, completion_delivery_id: completionDeliveryId(id, startedAt) },
    });

  let progressTranscript: DurableTranscript | undefined;
  let terminalUsage: DurableUsage | undefined;
  let progressFailureShown = false;
  const updateTranscript = (items: readonly TranscriptItem[], toolUses: number) => {
    const task = backgroundTasks.get(id) ?? foregroundTasks.get(id);
    if (task) task.toolUses = toolUses;
    taskWidget.setLiveTranscript(
      id,
      items,
      toolUses,
      progressTranscript?.agentState(),
      progressTranscript?.usageMetadata(),
    );
  };
  const showProgressFailure = () => {
    if (progressFailureShown) return;
    progressFailureShown = true;
    updateTranscript(
      [
        ...(progressTranscript?.items() ?? []),
        {
          type: "system",
          text: "Live durable updates are unavailable; the task continues running.",
          timestamp: "",
        },
      ],
      progressTranscript?.toolCallCount() ?? 0,
    );
  };
  const historyBase = {
    id,
    agentType: agent.name,
    description,
    sessionName,
    startedAt,
    piDir,
    dir: artifactsDir,
    cwd,
    conversationId,
    background: isBackground,
    backend: "durable" as const,
    durableRequestId: requestId,
    ...owner,
    ownerPid: process.pid,
  };
  /**
   * Keep the history's exact submission identity on the attempt currently in
   * flight: a crash during a fallback attempt must recover that attempt, not
   * the settled primary it replaced.
   */
  let historyRequestId = requestId;
  const noteAttemptRequestId = (attemptRequestId: string) => {
    historyRequestId = attemptRequestId;
    try {
      upsertTaskSessionHistory(piDir, {
        ...historyBase,
        status: "running",
        durableRequestId: attemptRequestId,
      });
    } catch {
      // Best-effort; the in-flight attempt still settles normally.
    }
  };
  const run = () =>
    (runTaskOverride ?? runDurableTask)({
      piDir,
      taskId: id,
      task: prompt,
      requestId,
      cwd,
      model,
      sessionModel,
      fast,
      thinkingLevel: parseDurableThinkingLevel(agent.thinking),
      modelSpecs: agent.modelSpecs,
      tools: agent.tools,
      disallowedTools: agent.disallowedTools,
      readonly: agent.readonly,
      onTerminalUsage: (usage) => { terminalUsage = usage; },
      onRequestId: noteAttemptRequestId,
      modelRegistry: ctx.modelRegistry,
      signal: runnerAbortController.signal,
      onSnapshot: (snapshot) => {
        progressTranscript = new DurableTranscript(snapshot);
        updateTranscript(progressTranscript.items(), progressTranscript.toolCallCount());
      },
      onEvents: (events) => {
        if (!progressTranscript) return;
        updateTranscript(
          progressTranscript.apply(events),
          progressTranscript.toolCallCount(),
        );
      },
      onWatchError: showProgressFailure,
      onSubmitted: (childConversationId) => {
        const task = backgroundTasks.get(id) ?? foregroundTasks.get(id);
        if (task) task.conversationId = childConversationId;
        historyBase.conversationId = childConversationId;
        try {
          upsertTaskSessionHistory(piDir, {
            ...historyBase,
            status: "running",
            durableRequestId: historyRequestId,
          });
        } catch {
          // Best-effort attribution; a settled completion writes it again.
        }
      },
    }).then((result) => ({ output: result.answer, usage: result.usage }));

  if (isBackground) {
    const backgroundTask: BackgroundTask = {
      dir: artifactsDir,
      cwd,
      agentType: agent.name,
      sessionName,
      backend: "durable",
      durableAbortController: runnerAbortController,
      originalPane: null,
      description,
      startedAt,
      toolUses: 0,
      turns: 0,
      conversationId,
      ...owner,
      recentCalls: [],
    };
    backgroundTasks.set(id, backgroundTask);
    deliveryGuard.track(id, sessionViewOf(ctx));
    ensureTaskWidget();

    startSdkBackgroundTask({
      id,
      agentType: agent.name,
      description,
      sessionName,
      startedAt,
      piDir,
      artifactsDir,
      backend: "durable",
      durableRequestId: requestId,
      cwd,
      conversationId,
      ...owner,
      run,
      deliver: (delivery) =>
        enqueueDelivery(delivery, completionDeliveryId(id, startedAt)),
      onComplete: (result) => {
        if (!deliveryGuard.allows(sessionViewOf(ctx), id)) return "suppressed";
        backgroundTask.status = "done";
        const parsed = parseResultXml(result.output);
        const assessment = assessTaskResult(parsed);
        const summary =
          taskResultContentText(parsed, assessment) ||
          "Durable subagent completed without assistant text.";
        return notify(
          `Background task ${id} (${agent.name}) done.\n\n${summary}`,
          {
            agent_type: agent.name,
            description,
            phase: "done",
            execution_phase: "done",
            status: assessment.reportedStatus,
            reported_status: assessment.reportedStatus,
            raw_status: assessment.rawStatus,
            result_valid: assessment.valid,
            result: result.output,
            summary: parsed.summary,
            findings: parsed.findings,
            evidence: parsed.evidence,
            files: parsed.files,
            caveats: parsed.caveats,
            next_steps: parsed.next_steps,
            confidence: parsed.confidence,
            duration_ms: Date.now() - startedAt,
            background: true,
            backend: "durable",
            task_id: id,
            usage: result.usage,
            structured_result: structuredResultPayload(assessment),
            full_output: parsed.raw.trim() || result.output.trim(),
          },
        );
      },
      onFailed: (error) => {
        if (!deliveryGuard.allows(sessionViewOf(ctx), id)) return "suppressed";
        const cancelled = error instanceof DurableTaskCancelledError;
        const phase = cancelled ? "cancelled" as const : "failed" as const;
        backgroundTask.status = phase;
        const message = error instanceof Error ? error.message : String(error);
        return notify(
          `Background task ${id} (${agent.name}) ${phase}.\n\n${message}`,
          {
            agent_type: agent.name,
            description,
            phase,
            execution_phase: phase,
            status: "unknown",
            reported_status: "unknown",
            result_valid: false,
            summary: message,
            duration_ms: Date.now() - startedAt,
            background: true,
            backend: "durable",
            task_id: id,
            ...(terminalUsage ? { usage: terminalUsage } : {}),
          },
        );
      },
      onSettled: () => {
        backgroundTask.durableAbortController = undefined;
        taskWidget.noteTaskFinished(id, backgroundTasks.get(id) ?? backgroundTask);
        backgroundTasks.delete(id);
        ignoreStaleExtensionCtx(() => clearTaskWidgetIfIdle());
      },
    });

    return {
      content: [{ type: "text" as const, text: formatDurableBackgroundReceipt(id) }],
      details: {
        phase: "running" as const,
        backend: "durable" as const,
        background: true,
        task_id: id,
        agent_type: agent.name,
        description,
        conversation_id: conversationId,
      },
    };
  }

  // Foreground: the tool call waits for the child's answer, like the SDK
  // backend, but the run is durable — a parent crash resumes it instead of
  // losing it, and a later run of the same task id returns the same child.
  upsertTaskSessionHistory(piDir, { ...historyBase, status: "running" });
  const foregroundTask: BackgroundTask = {
    dir: artifactsDir,
    cwd,
    agentType: agent.name,
    sessionName,
    backend: "durable",
    durableAbortController: runnerAbortController,
    originalPane: null,
    description,
    startedAt,
    toolUses: 0,
    turns: 0,
    conversationId,
    ...owner,
    recentCalls: [],
    status: "running",
  };
  foregroundTasks.set(id, foregroundTask);
  ensureTaskWidget();
  taskWidget.openTaskView(id);

  try {
    if (signal) {
      if (signal.aborted) forwardForegroundAbort();
      else signal.addEventListener("abort", forwardForegroundAbort, { once: true });
    }
    const { output, usage } = await run();
    const finalOutput = output || "Durable subagent completed without assistant text.";
    const parsed = parseResultXml(finalOutput);
    const assessment = assessTaskResult(parsed);
    const envelope = buildTaskEnvelope(parsed, {
      agent_type: agent.name,
      description,
      tool_uses: foregroundTask.toolUses,
      duration_ms: Date.now() - startedAt,
      background: false,
      task: { id, resumable: true },
    });
    upsertTaskSessionHistory(piDir, {
      ...historyBase,
      status: "done",
      reportedStatus: assessment.reportedStatus,
      rawStatus: assessment.rawStatus,
      resultValid: assessment.valid,
      completedAt: Date.now(),
    });
    foregroundTask.status = "done";
    foregroundTask.result = finalOutput;
    taskWidget.noteTaskFinished(id, foregroundTask, Date.now());
    return {
      content: envelope.content,
      details: {
        ...envelope.details,
        phase: "done" as const,
        execution_phase: "done" as const,
        reported_status: assessment.reportedStatus,
        raw_status: assessment.rawStatus,
        result_valid: assessment.valid,
        backend: "durable" as const,
        conversation_id: conversationId,
        usage: usage,
        full_output: parsed.raw.trim() || finalOutput,
      },
    };
  } catch (error) {
    const cancelled = error instanceof DurableTaskCancelledError;
    const phase = cancelled ? "cancelled" as const : "failed" as const;
    const message = error instanceof Error ? error.message : String(error);
    upsertTaskSessionHistory(piDir, {
      ...historyBase,
      status: phase,
      completedAt: Date.now(),
    });
    foregroundTask.status = phase;
    foregroundTask.result = message;
    taskWidget.noteTaskFinished(id, foregroundTask, Date.now());
    return {
      content: [{
        type: "text" as const,
        text: `Durable task ${phase}: ${message}\n\n${formatTaskIdPointer({ id, resumable: true })}`,
      }],
      details: {
        task_id: id,
        background: false,
        phase,
        execution_phase: phase,
        status: "unknown",
        reported_status: "unknown",
        result_valid: false,
        backend: "durable" as const,
        error: message,
        ...(terminalUsage ? { usage: terminalUsage } : {}),
      },
      ...(cancelled ? {} : { isError: true }),
    };
  } finally {
    signal?.removeEventListener("abort", forwardForegroundAbort);
    foregroundTask.durableAbortController = undefined;
    taskWidget.closeTaskView(id);
    foregroundTasks.delete(id);
    clearTaskWidgetIfIdle();
  }
}

