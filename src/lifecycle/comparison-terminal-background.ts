import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  updateRegistry,
  upsertTaskSessionHistory,
} from "../conversation.js";
import { envTurnLimit } from "../helpers.js";
import type { ComparisonCoordinator } from "../comparison.js";
import { sessionViewOf } from "../panel/delivery.js";
import type { DeliveryGuard } from "../panel/delivery.js";
import type { BackgroundTask } from "../types.js";
import type { ComparisonTerminalTask } from "./comparison-terminal-foreground.js";
import type { TerminalBackendKind } from "../subagent/terminalBackend.js";

export interface ComparisonTerminalBackgroundOptions {
  tasks: readonly ComparisonTerminalTask[];
  groupId: string;
  baseId: string;
  agentType: string;
  description: string;
  agentMaxTurns?: number;
  selectedBackend: TerminalBackendKind;
  piDir: string;
  artifactsDir: string;
  cwd: string;
  ctx: ExtensionContext;
  ownerSessionId?: string;
  ownerLeafId?: string | null;
  backgroundTasks: Map<string, BackgroundTask>;
  deliveryGuard: DeliveryGuard;
  comparisonCoordinator: ComparisonCoordinator;
  ensureTaskWidget: () => void;
}

export function executeComparisonTerminalBackground({
  tasks,
  groupId,
  baseId,
  agentType,
  description,
  agentMaxTurns,
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
}: ComparisonTerminalBackgroundOptions) {
  comparisonCoordinator.registerGroup(
    groupId,
    baseId,
    agentType,
    description,
    [tasks[0]!.id, tasks[1]!.id],
    [tasks[0]!.model, tasks[1]!.model],
  );

  const maxTurns = agentMaxTurns ?? envTurnLimit();
  for (const t of tasks) {
    const bg: BackgroundTask = {
      dir: artifactsDir,
      cwd,
      agentType,
      sessionName: t.sessionName,
      backend: selectedBackend,
      paneId: t.paneId,
      handle: t.handle,
      originalPane: t.originalPane,
      description: t.desc,
      startedAt: t.startedAt,
      toolUses: 0,
      turns: 0,
      maxTurns,
      recentCalls: [],
      comparisonGroupId: groupId,
      comparisonModel: t.model,
      comparisonDescription: description,
      comparisonIndex: t.index,
      ownerSessionId,
      ownerLeafId,
    };
    backgroundTasks.set(t.id, bg);
    deliveryGuard.track(t.id, sessionViewOf(ctx));

    upsertTaskSessionHistory(piDir, {
      id: t.id,
      agentType,
      description: t.desc,
      sessionName: t.sessionName,
      startedAt: bg.startedAt,
      paneId: t.paneId,
      handle: t.handle,
      piDir,
      dir: artifactsDir,
      cwd,
      status: "running",
      background: true,
      ownerSessionId,
      ownerLeafId,
      ownerPid: process.pid,
      comparisonGroupId: groupId,
      comparisonModel: t.model,
      comparisonDescription: description,
      comparisonIndex: t.index,
    });
  }

  const comparisonIds = new Set(tasks.map((t) => t.id));
  updateRegistry(piDir, (existingEntries) => [
    ...existingEntries.filter((entry) => !comparisonIds.has(entry.id)),
    ...tasks.map((t) => ({
      id: t.id,
      agentType,
      description: t.desc,
      sessionName: t.sessionName,
      startedAt: t.startedAt,
      paneId: t.paneId,
      handle: t.handle,
      backend: selectedBackend,
      piDir,
      dir: artifactsDir,
      cwd,
      maxTurns,
      ownerSessionId,
      ownerLeafId,
      ownerPid: process.pid,
      comparisonGroupId: groupId,
      comparisonModel: t.model,
      comparisonDescription: description,
      comparisonIndex: t.index,
    })),
  ]);
  ensureTaskWidget();

  return {
    content: [
      {
        type: "text" as const,
        text: `Dual-model evaluation started for agent "${agentType}":
- Model A: \`${tasks[0]!.model}\` (task \`${tasks[0]!.id}\`, pane \`${tasks[0]!.paneId}\`)
- Model B: \`${tasks[1]!.model}\` (task \`${tasks[1]!.id}\`, pane \`${tasks[1]!.paneId}\`)

Both subagents are running in background. Results will be compared and delivered once both complete.`,
      },
    ],
    details: {
      phase: "running" as const,
      compare: true,
      agent_type: agentType,
      description,
      models: [tasks[0]!.model, tasks[1]!.model],
      task_ids: [tasks[0]!.id, tasks[1]!.id],
    },
  };
}
