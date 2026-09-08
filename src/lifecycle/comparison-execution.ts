import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { buildAgentToolSelection } from "../agent-tools.js";
import {
  formatComparisonReport,
  resolveCompareModels,
  type AgentConfig,
} from "../helpers.js";
import {
  executeSdkComparison,
  type SdkComparisonSibling,
} from "./comparison-sdk-execution.js";
import {
  executeComparisonTerminalBackground,
} from "./comparison-terminal-background.js";
import {
  launchComparisonTerminalTasks,
} from "./comparison-terminal-launch.js";
import {
  executeComparisonTerminalForeground,
  type ComparisonTerminalTask,
} from "./comparison-terminal-foreground.js";
import { ComparisonCoordinator } from "../comparison.js";
import { sessionViewOf } from "../panel/delivery.js";
import type { DeliveryGuard } from "../panel/delivery.js";
import type { BackgroundTask } from "../types.js";
import {
  describeCommandFailure,
  type TerminalBackend,
  type TerminalBackendKind,
} from "../subagent/terminalBackend.js";
import { killAgentPaneStrictAsync } from "../subagent/tmux.js";
import type { ForegroundProgressPollOptions } from "../tool/foregroundProgress.js";
import type { TaskWidgetController } from "./widget.js";
import { durableParentOf } from "./ownership.js";
import { resolveHerdrPiIntegrationExtension } from "../subagent/herdr.js";

export interface ComparisonExecutionOptions {
  agent: AgentConfig;
  description: string;
  prompt: string;
  cwd: string;
  artifactsDir: string;
  piDir: string;
  ctx: ExtensionContext;
  pi: ExtensionAPI;
  parentToolNames: string[];
  taskToolName: string;
  skillPaths: string[];
  fast: boolean;
  selectedBackend: "sdk" | TerminalBackendKind;
  terminalBackend: TerminalBackend;
  taskExtensionPath: string;
  workspaceGroup?: string;
  signal?: AbortSignal;
  onUpdate?: ForegroundProgressPollOptions["onUpdate"];
  isBackground: boolean;
  foregroundTasks: Map<string, BackgroundTask>;
  backgroundTasks: Map<string, BackgroundTask>;
  deliveryGuard: DeliveryGuard;
  comparisonCoordinator: ComparisonCoordinator;
  taskWidget: Pick<
    TaskWidgetController,
    "requestRender" | "getContext" | "noteTaskFinished"
  >;
  clearTaskWidgetIfIdle: () => void;
  ensureTaskWidget: () => void;
  markComparisonGroupPartiallyDelivered: (taskIds: string[]) => void;
}

async function cleanupComparisonResources(
  tasks: readonly ComparisonTerminalTask[],
  terminalBackend: TerminalBackend,
  taskIds: readonly string[],
  backgroundTasks: Map<string, BackgroundTask>,
  foregroundTasks: Map<string, BackgroundTask>,
  deliveryGuard: DeliveryGuard,
  comparisonCoordinator: ComparisonCoordinator,
  groupId: string,
  clearTaskWidgetIfIdle: () => void,
): Promise<void> {
  comparisonCoordinator.discardGroup(groupId);
  for (const taskId of taskIds) {
    backgroundTasks.delete(taskId);
    foregroundTasks.delete(taskId);
    deliveryGuard.forget(taskId);
  }
  for (const task of tasks) {
    try {
      if (task.handle.backend === "herdr") {
        await terminalBackend.close(task.handle);
      } else {
        await killAgentPaneStrictAsync(task.paneId, task.originalPane);
      }
    } catch (error) {
      console.error(
        `[pi-task] comparison task ${task.id} cleanup failed: ${describeCommandFailure(error)}`,
      );
    }
  }
  try {
    clearTaskWidgetIfIdle();
  } catch {
    // Widget refresh is best-effort while unwinding a failed comparison.
  }
}

export async function executeComparisonTask({
  agent,
  description,
  prompt,
  cwd,
  artifactsDir,
  piDir,
  ctx,
  pi,
  parentToolNames,
  taskToolName,
  skillPaths,
  fast,
  selectedBackend,
  terminalBackend,
  taskExtensionPath,
  workspaceGroup,
  signal,
  onUpdate,
  isBackground,
  foregroundTasks,
  backgroundTasks,
  deliveryGuard,
  comparisonCoordinator,
  taskWidget,
  clearTaskWidgetIfIdle,
  ensureTaskWidget,
  markComparisonGroupPartiallyDelivered,
}: ComparisonExecutionOptions) {
  const compareModels = resolveCompareModels(agent);
  if (!compareModels.ok) {
    return {
      content: [{ type: "text" as const, text: compareModels.reason }],
      details: { phase: "failed" as const, error: "insufficient_models_for_compare" },
      isError: true,
    };
  }
  const [modelA, modelB] = compareModels.models;
  const baseId = `${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`;
  const groupId = `compare-${baseId}`;
  const id0 = `${baseId}-m0`;
  const id1 = `${baseId}-m1`;
  const sessionName0 = `task-${id0}`;
  const sessionName1 = `task-${id1}`;
  const sessionDir0 = join(artifactsDir, "sessions", id0);
  const sessionDir1 = join(artifactsDir, "sessions", id1);
  await mkdir(sessionDir0, { recursive: true });
  await mkdir(sessionDir1, { recursive: true });

  const specA = agent.modelSpecs?.find((s) => s.model === modelA);
  const specB = agent.modelSpecs?.find((s) => s.model === modelB);

  const siblings = [
    {
      id: id0,
      index: 0 as const,
      model: modelA,
      agent: { ...agent, model: modelA, thinking: specA?.thinking ?? agent.thinking },
      desc: description ? `${description} [${modelA}]` : `[${modelA}]`,
      sessionName: sessionName0,
      sessionDir: sessionDir0,
    },
    {
      id: id1,
      index: 1 as const,
      model: modelB,
      agent: { ...agent, model: modelB, thinking: specB?.thinking ?? agent.thinking },
      desc: description ? `${description} [${modelB}]` : `[${modelB}]`,
      sessionName: sessionName1,
      sessionDir: sessionDir1,
    },
  ] as const satisfies readonly [SdkComparisonSibling, SdkComparisonSibling];

  const toolSelection = buildAgentToolSelection({
    tools: agent.tools,
    disallowedTools: agent.disallowedTools,
    parentToolNames,
    taskToolName,
  });

  if (selectedBackend === "sdk") {
    return executeSdkComparison({
      siblings,
      baseId,
      groupId,
      agent,
      description,
      prompt,
      cwd,
      ctx,
      pi,
      piDir,
      artifactsDir,
      skillPaths,
      fast,
      signal,
      isBackground,
      toolSelection,
      foregroundTasks,
      backgroundTasks,
      deliveryGuard,
      comparisonCoordinator,
      taskWidget,
      ensureTaskWidget,
      clearTaskWidgetIfIdle,
      markComparisonGroupPartiallyDelivered,
    });
  }

  // Terminal backend (tmux / HerdR)
  // Resolve ownership before launching so a stale parent context cannot leave
  // a child resource without a cleanup path.
  const owner = durableParentOf(sessionViewOf(ctx));
  const ownerSessionId = owner.ownerSessionId;
  const ownerLeafId = owner.ownerLeafId;
  const herdrRequiredExtension =
    selectedBackend === "herdr"
      ? resolveHerdrPiIntegrationExtension()
      : undefined;
  let terminalTasks: Awaited<ReturnType<typeof launchComparisonTerminalTasks>>;
  try {
    terminalTasks = await launchComparisonTerminalTasks({
      siblings,
      agentName: agent.name,
      selectedBackend,
      terminalBackend,
      prompt,
      cwd,
      parentToolNames,
      taskToolName,
      skillPaths,
      fast,
      taskExtensionPath,
      herdrRequiredExtension,
      workspaceGroup,
      isBackground,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text" as const, text: `Failed to create ${selectedBackend} execution panes for comparison: ${message}` }],
      details: { phase: "failed" as const, error: `${selectedBackend} launch failed`, reason: message },
      isError: true,
    };
  }

  // Ownership (issue #20) is stamped identically on every record this
  // compare run persists (history spawn records and registry entries).
  if (!isBackground) {
    try {
      for (const t of terminalTasks) {
        foregroundTasks.set(t.id, {
          dir: artifactsDir,
          cwd,
          agentType: agent.name,
          sessionName: t.sessionName,
          backend: selectedBackend,
          paneId: t.paneId,
          handle: t.handle,
          originalPane: t.originalPane,
          description: t.desc,
          startedAt: t.startedAt,
          toolUses: 0,
          turns: 0,
          recentCalls: [],
          comparisonGroupId: groupId,
          comparisonModel: t.model,
          comparisonDescription: description,
          comparisonIndex: t.index,
          ownerSessionId,
          ownerLeafId,
        });
      }
      ensureTaskWidget();
      const runs = await executeComparisonTerminalForeground({
        tasks: terminalTasks,
        groupId,
        agentType: agent.name,
        description,
        artifactsDir,
        taskCwd: cwd,
        piDir,
        selectedBackend,
        terminalBackend,
        signal,
        onUpdate,
        ownerSessionId,
        ownerLeafId,
        foregroundTasks,
        requestRender: taskWidget.requestRender,
        clearTaskWidgetIfIdle,
      });

      const report = formatComparisonReport({
        agentType: agent.name,
        description,
        runs,
      });

      return {
        content: [{ type: "text" as const, text: report }],
        details: {
          phase: "done" as const,
          compare: true,
          agent_type: agent.name,
          description,
          models: [modelA, modelB],
          runs,
        },
      };
    } catch (error) {
      await cleanupComparisonResources(
        terminalTasks,
        terminalBackend,
        terminalTasks.map((task) => task.id),
        backgroundTasks,
        foregroundTasks,
        deliveryGuard,
        comparisonCoordinator,
        groupId,
        clearTaskWidgetIfIdle,
      );
      throw error;
    }
  }

  try {
    return await executeComparisonTerminalBackground({
      tasks: terminalTasks,
      groupId,
      baseId,
      agentType: agent.name,
      description,
      agentMaxTurns: agent.maxTurns,
      selectedBackend,
      piDir,
      artifactsDir,
      cwd,
      ctx,
      ownerSessionId,
      ownerLeafId,
      backgroundTasks,
      deliveryGuard,
      comparisonCoordinator,
      ensureTaskWidget,
    });
  } catch (error) {
    await cleanupComparisonResources(
      terminalTasks,
      terminalBackend,
      terminalTasks.map((task) => task.id),
      backgroundTasks,
      foregroundTasks,
      deliveryGuard,
      comparisonCoordinator,
      groupId,
      clearTaskWidgetIfIdle,
    );
    throw error;
  }
}
