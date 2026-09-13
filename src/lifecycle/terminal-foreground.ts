import { TASK_TIMEOUT_MS } from "../constants.js";
import {
  findJsonlSessionByName,
  upsertTaskSessionHistory,
} from "../conversation.js";
import {
  assessTaskResult,
  buildTaskEnvelope,
  countToolUses,
  parseResultXml,
} from "../helpers.js";
import type { BackgroundTask, TerminalHandle } from "../types.js";
import {
  killAgentPane,
  probePaneAsync,
} from "../subagent/tmux.js";
import { claudeToolUseCount, claudeTurnCount } from "../subagent/claudeSession.js";
import type { TerminalBackend, TerminalBackendKind } from "../subagent/terminalBackend.js";
import {
  waitForTaskCompletion,
  type TaskCompletionSnapshot,
} from "../subagent/waitCompletion.js";
import {
  startForegroundProgressPolling,
  type ForegroundProgressPollOptions,
} from "../tool/foregroundProgress.js";

export interface TerminalForegroundExecutionOptions {
  id: string;
  agentType: string;
  description: string;
  sessionName: string;
  sessionDir: string;
  artifactsDir: string;
  taskCwd: string;
  conversationId?: string;
  piDir: string;
  /** Child runtime; "pi" (default) or "claude" (Claude Code CLI). */
  runtime?: "pi" | "claude";
  /** Durable Claude Code session UUID (runtime "claude"). */
  claudeSessionId?: string;
  /** Absolute Claude Code transcript path (runtime "claude"). */
  claudeSessionFile?: string;
  handle: TerminalHandle;
  paneId: string;
  originalPane: string | null;
  startedAt: number;
  ownerSessionId?: string;
  ownerLeafId?: string | null;
  selectedBackend: TerminalBackendKind;
  terminalBackend: TerminalBackend;
  signal?: AbortSignal;
  onUpdate?: ForegroundProgressPollOptions["onUpdate"];
  foregroundTasks: Map<string, BackgroundTask>;
  clearTaskWidgetIfIdle: () => void;
}

export async function executeTerminalForegroundTask({
  id,
  agentType,
  description,
  sessionName,
  sessionDir,
  artifactsDir,
  taskCwd,
  conversationId,
  piDir,
  runtime,
  claudeSessionId,
  claudeSessionFile,
  handle,
  paneId,
  originalPane,
  startedAt,
  ownerSessionId,
  ownerLeafId,
  selectedBackend,
  terminalBackend,
  signal,
  onUpdate,
  foregroundTasks,
  clearTaskWidgetIfIdle,
}: TerminalForegroundExecutionOptions) {
  const claudeRuntime = runtime === "claude";
  const runtimeHistoryFields = {
    runtime,
    ...(claudeRuntime && claudeSessionId !== undefined
      ? { claudeSessionId }
      : {}),
  };
  upsertTaskSessionHistory(piDir, {
    id,
    agentType,
    description,
    sessionName,
    ...runtimeHistoryFields,
    startedAt,
    paneId,
    handle,
    piDir,
    dir: artifactsDir,
    cwd: taskCwd,
    conversationId,
    status: "running",
    background: false,
    ownerSessionId,
    ownerLeafId,
    ownerPid: process.pid,
  });

  const stopProgress = startForegroundProgressPolling({
    taskId: id,
    sessionDir,
    sessionName,
    agentType,
    description,
    startedAt,
    onUpdate: onUpdate ?? (() => {}),
  });

  const onAbort = () => stopProgress();
  signal?.addEventListener("abort", onAbort, { once: true });

  const completion: TaskCompletionSnapshot = await waitForTaskCompletion({
    sessionDir,
    sessionName,
    paneId,
    signal,
    timeoutMs: TASK_TIMEOUT_MS,
    pollMs: 1000,
    sinceMs: startedAt,
    resourceExists: selectedBackend === "herdr"
      ? () => terminalBackend.isAlive(handle as Extract<TerminalHandle, { backend: "herdr" }>)
      : () => probePaneAsync(paneId).then((probe) => probe.state),
    ...(claudeRuntime
      ? { runtime: "claude" as const, claudeSessionFile }
      : {}),
  });
  stopProgress();
  signal?.removeEventListener("abort", onAbort);

  const content = completion.content;
  const parsed = parseResultXml(content);
  const assessment = assessTaskResult(parsed);
  const phase = completion.status === "completed"
    ? "done"
    : completion.status === "cancelled"
      ? "cancelled"
      : "failed";
  const completedSessionRef = findJsonlSessionByName(
    piDir,
    id,
    agentType,
  )?.sessionRef;
  upsertTaskSessionHistory(piDir, {
    id,
    agentType,
    description,
    sessionName,
    ...runtimeHistoryFields,
    startedAt,
    paneId,
    handle,
    piDir,
    dir: artifactsDir,
    cwd: taskCwd,
    conversationId,
    sessionRef: completedSessionRef,
    status: phase,
    reportedStatus: assessment.reportedStatus,
    rawStatus: assessment.rawStatus,
    resultValid: assessment.valid,
    completedAt: Date.now(),
    background: false,
    ownerSessionId,
    ownerLeafId,
  });
  if (phase === "done") {
    if (handle.backend === "herdr") await terminalBackend.close(handle);
    else killAgentPane(paneId, originalPane);
  } else {
    // Always tear down the pane on any terminal status so a cancelled or
    // failed foreground wait cannot leave a dangling terminal resource.
    try {
      if (handle.backend === "herdr") await terminalBackend.close(handle);
      else killAgentPane(paneId, originalPane);
    } catch {
      // ignore
    }
  }
  foregroundTasks.delete(id);
  clearTaskWidgetIfIdle();
  const durationMs = Date.now() - startedAt;
  const { toolUses, turns } = claudeRuntime
    ? {
        toolUses: claudeToolUseCount(claudeSessionFile ?? "", startedAt),
        turns: claudeTurnCount(claudeSessionFile ?? "", startedAt),
      }
    : countToolUses(sessionDir, sessionName);
  const envelope = buildTaskEnvelope(parsed, {
    agent_type: agentType,
    description,
    tool_uses: toolUses,
    duration_ms: durationMs,
    background: false,
    task: { id, resumable: !claudeRuntime },
  });
  return {
    ...envelope,
    details: {
      ...envelope.details,
      phase,
      execution_phase: phase,
      reported_status: assessment.reportedStatus,
      raw_status: assessment.rawStatus,
      result_valid: assessment.valid,
      confidence: parsed.confidence || "",
      turn_count: turns,
      conversation_id: conversationId,
      full_output: parsed.raw.trim() || content.trim(),
    },
  };
}
