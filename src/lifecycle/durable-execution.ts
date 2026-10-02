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
import { existsSync } from "node:fs";
import { upsertTaskSessionHistory, findTaskSessionHistory } from "../conversation.js";
import type { TaskSessionHistoryEntry } from "../types.js";
import {
  assessTaskResult,
  buildTaskEnvelope,
  completionDeliveryOptions,
  formatTaskIdPointer,
  parseResultXml,
  structuredResultPayload,
  taskResultContentText,
  type AgentConfig,
} from "../helpers.js";
import type { BackgroundTask } from "../types.js";
import { sessionViewOf, type DeliveryGuard } from "../panel/delivery.js";
import { durableParentOf } from "./ownership.js";
import type { TaskWidgetController } from "./widget.js";
import { startSdkBackgroundTask } from "../subagent/sdkBackground.js";
import {
  durableDatabasePath,
  resumeDurableTasks,
  runDurableTask,
} from "../subagent/durable.js";
import { ignoreStaleExtensionCtx } from "../stale-ctx.js";

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
  signal?: AbortSignal;
  isBackground: boolean;
  backgroundTasks: Map<string, BackgroundTask>;
  foregroundTasks: Map<string, BackgroundTask>;
  deliveryGuard: DeliveryGuard;
  taskWidget: TaskWidgetController;
  clearTaskWidgetIfIdle: () => void;
  ensureTaskWidget: () => void;
  enqueueDelivery: (delivery: () => void) => void;
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
  models?: import("../subagent/durable.js").DurableModelsFactory;
}): Promise<void> {
  const { pi, piDir, sessionId } = deps;
  if (!existsSync(durableDatabasePath(piDir))) return;
  const notify = (
    content: string,
    details: Record<string, unknown>,
  ) =>
    ignoreStaleExtensionCtx(() =>
      pi.sendMessage(
        { customType: "task-complete", content, display: true, details },
        completionDeliveryOptions(process.env.PI_TASK_COMPLETION_DELIVERY),
      ),
  );
  const owned = (taskId: string): TaskSessionHistoryEntry | "other-session" | undefined => {
    const history = findTaskSessionHistory(piDir, taskId);
    // Another session's task belongs to that session's resume pass.
    if (history?.ownerSessionId !== undefined && history.ownerSessionId !== sessionId) {
      return "other-session";
    }
    return history;
  };

  await resumeDurableTasks(
    piDir,
    {
      onRecovered: (taskId, output) => {
        const history = owned(taskId);
        if (history === "other-session") return;
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
        void notify(
          `Background task ${taskId} (durable) resumed after restart and finished.\n\n${summary}`,
          {
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
      onFailed: (taskId, reason) => {
        const history = owned(taskId);
        if (history === "other-session") return;
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
        void notify(
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
          },
        );
      },
    },
    {
      databasePath: deps.databasePath,
      models: deps.models,
    },
  );
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
  isBackground,
  backgroundTasks,
  foregroundTasks,
  deliveryGuard,
  taskWidget,
  clearTaskWidgetIfIdle,
  ensureTaskWidget,
  enqueueDelivery,
}: DurableTaskExecutionOptions) {
  const startedAt = Date.now();
  const model = agent.model;
  const owner = durableParentOf(sessionViewOf(ctx));
  const notify = (content: string, details: Record<string, unknown>) =>
    ignoreStaleExtensionCtx(() =>
      pi.sendMessage(
        { customType: "task-complete", content, display: true, details },
        completionDeliveryOptions(process.env.PI_TASK_COMPLETION_DELIVERY),
      ),
  );

  const run = () =>
    runDurableTask({
      piDir,
      taskId: id,
      task: prompt,
      cwd,
      model,
    }).then((result) => ({ output: result.answer }));

  if (isBackground) {
    const backgroundTask: BackgroundTask = {
      dir: artifactsDir,
      cwd,
      agentType: agent.name,
      sessionName,
      backend: "durable",
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
      cwd,
      conversationId,
      ...owner,
      run,
      deliver: enqueueDelivery,
      onComplete: (result) => {
        if (!deliveryGuard.allows(sessionViewOf(ctx), id)) return;
        backgroundTask.status = "done";
        const parsed = parseResultXml(result.output);
        const assessment = assessTaskResult(parsed);
        const summary =
          taskResultContentText(parsed, assessment) ||
          "Durable subagent completed without assistant text.";
        notify(
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
            structured_result: structuredResultPayload(assessment),
            full_output: parsed.raw.trim() || result.output.trim(),
          },
        );
      },
      onFailed: (error) => {
        if (!deliveryGuard.allows(sessionViewOf(ctx), id)) return;
        backgroundTask.status = "failed";
        const message = error instanceof Error ? error.message : String(error);
        notify(
          `Background task ${id} (${agent.name}) failed.\n\n${message}`,
          {
            agent_type: agent.name,
            description,
            phase: "failed",
            execution_phase: "failed",
            status: "unknown",
            reported_status: "unknown",
            result_valid: false,
            summary: message,
            duration_ms: Date.now() - startedAt,
            background: true,
            backend: "durable",
            task_id: id,
          },
        );
      },
      onSettled: () => {
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
    background: false,
    ...owner,
    ownerPid: process.pid,
  };
  upsertTaskSessionHistory(piDir, { ...historyBase, status: "running" });

  try {
    const { output } = await run();
    const finalOutput = output || "Durable subagent completed without assistant text.";
    const parsed = parseResultXml(finalOutput);
    const assessment = assessTaskResult(parsed);
    const envelope = buildTaskEnvelope(parsed, {
      agent_type: agent.name,
      description,
      tool_uses: 0,
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
        full_output: parsed.raw.trim() || finalOutput,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    upsertTaskSessionHistory(piDir, {
      ...historyBase,
      status: "failed",
      completedAt: Date.now(),
    });
    return {
      content: [{
        type: "text" as const,
        text: `Durable task failed: ${message}\n\n${formatTaskIdPointer({ id, resumable: true })}`,
      }],
      details: {
        task_id: id,
        background: false,
        phase: "failed" as const,
        execution_phase: "failed",
        status: "unknown",
        reported_status: "unknown",
        result_valid: false,
        backend: "durable" as const,
        error: message,
      },
      isError: true,
    };
  } finally {
    foregroundTasks.delete(id);
    clearTaskWidgetIfIdle();
  }
}

