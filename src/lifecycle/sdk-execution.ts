import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { TASK_TIMEOUT_MS } from "../constants.js";
import {
  assessTaskResult,
  buildTaskEnvelope,
  completionDeliveryOptions,
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

  try {
    const { output, sessionPath } = await runSdkFallback(foregroundTask);
    const finalOutput = output || "SDK subagent completed without assistant text.";
    const parsed = parseResultXml(finalOutput);
    const assessment = assessTaskResult(parsed);
    const envelope = buildTaskEnvelope(parsed, {
      agent_type: agent.name,
      description,
      tool_uses: foregroundTask!.toolUses,
      duration_ms: Date.now() - foregroundTask!.startedAt,
      background: false,
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
  } catch (error) {
    const interrupted = error instanceof SdkSubagentInterruptedError;
    const phase = interrupted && error.kind === "cancelled"
      ? "cancelled"
      : interrupted && error.kind === "timeout"
        ? "timeout"
        : "failed";
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text" as const, text: `SDK task ${phase}: ${message}` }],
      details: {
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
    foregroundTasks.delete(id);
    clearTaskWidgetIfIdle();
  }
}
