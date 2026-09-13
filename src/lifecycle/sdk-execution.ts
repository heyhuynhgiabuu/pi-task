import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { TASK_TIMEOUT_MS } from "../constants.js";
import { upsertTaskSessionHistory } from "../conversation.js";
import {
  assessTaskResult,
  buildTaskEnvelope,
  completionDeliveryOptions,
  formatTaskIdPointer,
  parseResultXml,
  structuredResultPayload,
  subscribeToolEvents,
  taskResultContentText,
  type AgentConfig,
} from "../helpers.js";
import type { BackgroundTask } from "../types.js";
import { sessionViewOf } from "../panel/delivery.js";
import type { DeliveryGuard } from "../panel/delivery.js";
import { durableParentOf } from "./ownership.js";
import type { TaskWidgetController } from "./widget.js";
import {
  SdkSubagentInterruptedError,
  runSdkSubagent,
} from "../subagent/runSdk.js";
import {
  formatSdkBackgroundReceipt,
  startSdkBackgroundTask,
} from "../subagent/sdkBackground.js";
import { ignoreStaleExtensionCtx } from "../stale-ctx.js";

export interface SdkTaskExecutionOptions {
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
  toolSelection: {
    tools: string[];
    excludeTools: string[];
  };
  skillPaths: string[];
  fast: boolean;
  signal?: AbortSignal;
  isBackground: boolean;
  foregroundTask?: BackgroundTask;
  backgroundTasks: Map<string, BackgroundTask>;
  foregroundTasks: Map<string, BackgroundTask>;
  deliveryGuard: DeliveryGuard;
  taskWidget: Pick<TaskWidgetController, "requestRender" | "noteTaskFinished">;
  ensureTaskWidget: () => void;
  clearTaskWidgetIfIdle: () => void;
  enqueueDelivery: (delivery: () => void) => void;
}

export async function executeSdkTask({
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
  toolSelection,
  skillPaths,
  fast,
  signal,
  isBackground,
  foregroundTask,
  backgroundTasks,
  foregroundTasks,
  deliveryGuard,
  taskWidget,
  ensureTaskWidget,
  clearTaskWidgetIfIdle,
  enqueueDelivery,
}: SdkTaskExecutionOptions) {
  const runSdkFallback = async (
    task?: BackgroundTask,
    onSession?: (session: any) => () => void,
  ) =>
    runSdkSubagent({
      onSession: task
        ? (session) => subscribeToolEvents(session, task, 10, taskWidget.requestRender)
        : onSession,
      sessionName: task?.sessionName ?? sessionName,
      prompt,
      agent,
      cwd,
      ctx,
      model: agent.model,
      thinkingLevel: agent.thinking,
      tools: toolSelection.tools,
      excludeTools: toolSelection.excludeTools,
      systemPrompt: agent.body,
      skillPaths,
      fast,
      signal: task ? signal : undefined,
      timeoutMs: TASK_TIMEOUT_MS,
    });

  if (isBackground) {
    const backgroundTask: BackgroundTask = {
      dir: artifactsDir,
      cwd,
      agentType: agent.name,
      sessionName,
      backend: "sdk",
      originalPane: null,
      description,
      startedAt: Date.now(),
      toolUses: 0,
      turns: 0,
      conversationId,
      ...durableParentOf(sessionViewOf(ctx)),
      recentCalls: [],
    };
    backgroundTasks.set(id, backgroundTask);
    deliveryGuard.track(id, sessionViewOf(ctx));
    ensureTaskWidget();
    const bgOnSession = (session: any) =>
      subscribeToolEvents(session, backgroundTask, 10, taskWidget.requestRender);

    startSdkBackgroundTask({
      id,
      agentType: agent.name,
      description,
      sessionName,
      startedAt: backgroundTask.startedAt,
      piDir,
      artifactsDir,
      cwd,
      conversationId,
      ...durableParentOf(sessionViewOf(ctx)),
      run: async () => runSdkFallback(undefined, bgOnSession),
      deliver: enqueueDelivery,
      onComplete: (result) => {
        if (!deliveryGuard.allows(sessionViewOf(ctx), id)) return;
        backgroundTask.status = "done";
        const parsed = parseResultXml(result.output);
        const assessment = assessTaskResult(parsed);
        const summary =
          taskResultContentText(parsed, assessment) ||
          "SDK subagent completed without assistant text.";
        ignoreStaleExtensionCtx(() =>
          pi.sendMessage(
            {
              customType: "task-complete",
              content: `Background task ${id} (${agent.name}) done.\n\n${summary}`,
              display: true,
              details: {
                task_id: id,
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
                duration_ms: Date.now() - backgroundTask.startedAt,
                tool_uses: backgroundTask.toolUses,
                turn_count: backgroundTask.turns,
                background: true,
                structured_result: structuredResultPayload(assessment),
                full_output: parsed.raw.trim() || result.output.trim(),
              },
            },
            completionDeliveryOptions(process.env.PI_TASK_COMPLETION_DELIVERY),
          ),
        );
      },
      onFailed: (error) => {
        if (!deliveryGuard.allows(sessionViewOf(ctx), id)) return;
        const interrupted = error instanceof SdkSubagentInterruptedError;
        const phase = interrupted && error.kind === "timeout" ? "timeout" : "failed";
        backgroundTask.status = phase;
        const message = error instanceof Error ? error.message : String(error);
        ignoreStaleExtensionCtx(() =>
          pi.sendMessage(
            {
              customType: "task-complete",
              content: `Background task ${id} (${agent.name}) ${phase}.\n\n${message}`,
              display: true,
              details: {
                task_id: id,
                agent_type: agent.name,
                description,
                phase,
                execution_phase: phase,
                status: "unknown",
                reported_status: "unknown",
                result_valid: false,
                summary: message,
                duration_ms: Date.now() - backgroundTask.startedAt,
                tool_uses: backgroundTask.toolUses,
                turn_count: backgroundTask.turns,
                background: true,
              },
            },
            completionDeliveryOptions(process.env.PI_TASK_COMPLETION_DELIVERY),
          ),
        );
      },
      onSettled: () => {
        taskWidget.noteTaskFinished(id, backgroundTasks.get(id) ?? backgroundTask);
        backgroundTasks.delete(id);
        ignoreStaleExtensionCtx(() => clearTaskWidgetIfIdle());
      },
    });

    return {
      content: [{ type: "text" as const, text: formatSdkBackgroundReceipt(id) }],
      details: {
        phase: "running" as const,
        backend: "sdk" as const,
        background: true,
        task_id: id,
        agent_type: agent.name,
        description,
        conversation_id: conversationId,
      },
    };
  }

  // SDK foreground work has no terminal resource, but it still owns a durable
  // record: the task id and child session file are the recovery path for
  // `/task status` and transcript review.
  const historyBase = {
    id,
    agentType: agent.name,
    description,
    sessionName,
    startedAt: foregroundTask!.startedAt,
    piDir,
    dir: artifactsDir,
    cwd,
    conversationId,
    background: false,
    ...durableParentOf(sessionViewOf(ctx)),
    ownerPid: process.pid,
  };
  const clearForegroundRow = () => {
    foregroundTasks.delete(id);
    clearTaskWidgetIfIdle();
  };
  try {
    upsertTaskSessionHistory(piDir, { ...historyBase, status: "running" });
  } catch (error) {
    // The run's cleanup lives in the finally below, which this throw would
    // skip: a stranded foreground row keeps the widget alive indefinitely.
    clearForegroundRow();
    throw error;
  }

  let output: string;
  let sessionPath: string | undefined;
  try {
    ({ output, sessionPath } = await runSdkFallback(foregroundTask));
  } catch (error) {
    const interrupted = error instanceof SdkSubagentInterruptedError;
    const phase = interrupted && error.kind === "cancelled"
      ? "cancelled"
      : interrupted && error.kind === "timeout"
        ? "timeout"
        : "failed";
    const message = error instanceof Error ? error.message : String(error);
    upsertTaskSessionHistory(piDir, {
      ...historyBase,
      status: phase,
      completedAt: Date.now(),
    });
    return {
      content: [{
        type: "text" as const,
        text: `SDK task ${phase}: ${message}\n\n${formatTaskIdPointer({ id, resumable: false })}`,
      }],
      details: {
        task_id: id,
        background: false,
        phase,
        execution_phase: phase,
        status: "unknown",
        reported_status: "unknown",
        result_valid: false,
        backend: "sdk" as const,
        error: message,
      },
      isError: phase === "failed",
    };
  } finally {
    clearForegroundRow();
  }

  const finalOutput = output || "SDK subagent completed without assistant text.";
  const parsed = parseResultXml(finalOutput);
  const assessment = assessTaskResult(parsed);
  const envelope = buildTaskEnvelope(parsed, {
    agent_type: agent.name,
    description,
    tool_uses: foregroundTask!.toolUses,
    duration_ms: Date.now() - foregroundTask!.startedAt,
    background: false,
    task: { id, resumable: false },
  });
  upsertTaskSessionHistory(piDir, {
    ...historyBase,
    ...(sessionPath !== undefined ? { sessionRef: sessionPath } : {}),
    status: "done",
    reportedStatus: assessment.reportedStatus,
    rawStatus: assessment.rawStatus,
    resultValid: assessment.valid,
    completedAt: Date.now(),
  });
  return {
    content: envelope.content,
    details: {
      ...envelope.details,
      phase: "done" as const,
      execution_phase: "done" as const,
      reported_status: assessment.reportedStatus,
      raw_status: assessment.rawStatus,
      result_valid: assessment.valid,
      backend: "sdk" as const,
      session_path: sessionPath,
      conversation_id: conversationId,
      full_output: parsed.raw.trim() || finalOutput,
    },
  };
}
