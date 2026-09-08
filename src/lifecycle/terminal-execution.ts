import { join } from "node:path";
import type { ExtensionContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  formatBackgroundReceipt,
  envTurnLimit,
} from "../helpers.js";
import { describeCommandFailure } from "../subagent/terminalBackend.js";
import {
  launchTerminalTask,
} from "../subagent/terminal-launch.js";
import { killAgentPaneStrictAsync } from "../subagent/tmux.js";
import type {
  TerminalBackend,
  TerminalBackendKind,
} from "../subagent/terminalBackend.js";
import type { BackgroundTask, TerminalHandle } from "../types.js";
import { sessionViewOf } from "../panel/delivery.js";
import type { DeliveryGuard } from "../panel/delivery.js";
import { durableParentOf } from "./ownership.js";
import { executeTerminalForegroundTask } from "./terminal-foreground.js";
import { registerBackgroundTask } from "./background-registration.js";
import type { ForegroundProgressPollOptions } from "../tool/foregroundProgress.js";

export interface TerminalExecutionOptions {
  id: string;
  agentName: string;
  description: string;
  sessionName: string;
  sessionDir: string;
  artifactsDir: string;
  cwd: string;
  conversationId?: string;
  piDir: string;
  prompt: string;
  piArgs: string[];
  /** Child runtime; "pi" (default) or "claude" (Claude Code CLI). */
  runtime?: "pi" | "claude";
  /** Durable Claude Code session UUID (runtime "claude"). */
  claudeSessionId?: string;
  /** Absolute Claude Code transcript path (runtime "claude"). */
  claudeSessionFile?: string;
  selectedBackend: TerminalBackendKind;
  requestedBackend: string;
  terminalBackend: TerminalBackend;
  workspaceGroup?: string;
  foregroundTask?: BackgroundTask;
  agentMaxTurns?: () => number | undefined;
  signal?: AbortSignal;
  onUpdate?: ForegroundProgressPollOptions["onUpdate"];
  ctx: ExtensionContext;
  pi: ExtensionAPI;
  backgroundTasks: Map<string, BackgroundTask>;
  foregroundTasks: Map<string, BackgroundTask>;
  deliveryGuard: DeliveryGuard;
  clearTaskWidgetIfIdle: () => void;
  ensureTaskWidget: () => void;
}

async function closeLaunchedResource(
  handle: TerminalHandle,
  paneId: string,
  originalPane: string | null,
  terminalBackend: TerminalBackend,
): Promise<void> {
  if (handle.backend === "herdr") {
    await terminalBackend.close(handle);
  } else {
    await killAgentPaneStrictAsync(paneId, originalPane);
  }
}

export async function executeTerminalTask({
  id,
  agentName,
  description,
  sessionName,
  sessionDir,
  artifactsDir,
  cwd,
  conversationId,
  piDir,
  prompt,
  piArgs,
  runtime,
  claudeSessionId,
  claudeSessionFile,
  selectedBackend,
  requestedBackend,
  terminalBackend,
  workspaceGroup,
  foregroundTask,
  agentMaxTurns,
  signal,
  onUpdate,
  ctx,
  pi,
  backgroundTasks,
  foregroundTasks,
  deliveryGuard,
  clearTaskWidgetIfIdle,
  ensureTaskWidget,
}: TerminalExecutionOptions) {
  const claudeRuntime = runtime === "claude";
  const owner = durableParentOf(sessionViewOf(ctx));
  const ownerSessionId = owner.ownerSessionId;
  const ownerLeafId = owner.ownerLeafId;
  let paneId: string;
  let originalPane: string | null;
  let handle: TerminalHandle;
  try {
    const launched = await launchTerminalTask({
      backend: selectedBackend,
      terminalBackend,
      agentArgs: piArgs,
      initialPrompt: prompt,
      cwd,
      sessionDir,
      sessionName,
      // PI_TASK_TOOL_DISABLED only matters for pi children (it disables the
      // pi-task tool inside the subagent's Pi process); opt-in issue #24
      // environment forwarding still applies to every runtime.
      environment: claudeRuntime ? {} : { PI_TASK_TOOL_DISABLED: "1" },
      runtime,
      claudeSessionFile,
      label: `${agentName}-${id.slice(0, 8)}`,
      workspaceGroup,
      remainOnExit: Boolean(foregroundTask),
      selfDestruct: !foregroundTask,
    });
    ({ handle, paneId, originalPane } = launched);
    if (foregroundTask) {
      foregroundTask.backend = selectedBackend;
      foregroundTask.paneId = paneId;
      foregroundTask.handle = handle;
      foregroundTask.originalPane = originalPane;
    }
  } catch (error) {
    foregroundTasks.delete(id);
    clearTaskWidgetIfIdle();
    const reason = describeCommandFailure(error);
    return {
      content: [
        {
          type: "text" as const,
          text: `Failed to create ${selectedBackend} execution pane for the agent: ${reason}`,
        },
      ],
      details: { phase: "failed" as const, error: `${selectedBackend} launch failed`, reason },
      isError: true,
    };
  }

  // ── FOREGROUND MODE: block until result, return directly ────────────
  if (foregroundTask !== undefined) {
    try {
      return await executeTerminalForegroundTask({
        id,
        agentType: agentName,
        description,
        sessionName,
        sessionDir,
        artifactsDir,
        taskCwd: cwd,
        conversationId,
        piDir,
        runtime,
        claudeSessionId,
        claudeSessionFile,
        handle,
        paneId,
        originalPane,
        startedAt: foregroundTask?.startedAt ?? Date.now(),
        ownerSessionId,
        ownerLeafId,
        selectedBackend,
        terminalBackend,
        signal,
        onUpdate,
        foregroundTasks,
        clearTaskWidgetIfIdle,
      });
    } catch (error) {
      foregroundTasks.delete(id);
      deliveryGuard.forget(id);
      try {
        await closeLaunchedResource(handle, paneId, originalPane, terminalBackend);
      } catch (cleanupError) {
        console.error(
          `[pi-task] foreground task ${id} cleanup failed: ${describeCommandFailure(cleanupError)}`,
        );
      }
      try {
        clearTaskWidgetIfIdle();
      } catch {
        // Widget refresh is best-effort while unwinding a failed task.
      }
      throw error;
    }
  }

  // ── BACKGROUND MODE (default): add to tracker, return immediately ─────

  const bgtask: BackgroundTask = {
    dir: artifactsDir,
    cwd,
    agentType: agentName,
    sessionName,
    runtime,
    ...(claudeRuntime ? { claudeSessionId, claudeSessionFile } : {}),
    paneId,
    handle,
    originalPane,
    description,
    startedAt: Date.now(),
    toolUses: 0,
    turns: 0,
    maxTurns: agentMaxTurns?.() ?? envTurnLimit(),
    conversationId,
    ownerSessionId,
    ownerLeafId,
    recentCalls: [],
    backend: selectedBackend,
  };

  try {
    registerBackgroundTask({
      id,
      task: bgtask,
      piDir,
      pi,
      backgroundTasks,
      trackDelivery: () => deliveryGuard.track(id, sessionViewOf(ctx)),
      ensureTaskWidget,
    });
  } catch (error) {
    backgroundTasks.delete(id);
    deliveryGuard.forget(id);
    try {
      await closeLaunchedResource(handle, paneId, originalPane, terminalBackend);
    } catch (cleanupError) {
      console.error(
        `[pi-task] background task ${id} cleanup failed: ${describeCommandFailure(cleanupError)}`,
      );
    }
    try {
      clearTaskWidgetIfIdle();
    } catch {
      // Widget refresh is best-effort while unwinding a failed task.
    }
    throw error;
  }

  // Do not kill a background subagent when the parent session aborts or is
  // replaced. Background tasks are intentionally detached; the registry and
  // polling loop own their lifecycle after the pane is spawned.

  return {
    content: [
      {
        type: "text" as const,
        text: formatBackgroundReceipt({
          taskId: id,
          agentType: agentName,
          sessionPath: claudeRuntime && claudeSessionFile
            ? claudeSessionFile
            : join(sessionDir, `${sessionName}.jsonl`),
          backend: selectedBackend,
          backendReason: requestedBackend === "auto" && selectedBackend !== "herdr"
            ? "HerdR unavailable"
            : undefined,
        }),
      },
    ],
    details: {
      task_id: id,
      agent_type: agentName,
      description,
      tmux_session: sessionName,
      background: true,
    },
  };
}
