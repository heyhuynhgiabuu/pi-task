import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { upsertTaskSessionHistory } from "./conversation.js";
import {
  formatComparisonReport,
  type ComparisonRunResult,
  completionDeliveryOptions,
} from "./helpers.js";
import { ignoreStaleExtensionCtx } from "./stale-ctx.js";
import type { BackgroundTask, TaskSessionHistoryEntry } from "./types.js";

export interface ComparisonGroup {
  groupId: string;
  baseId: string;
  agentType: string;
  description: string;
  taskIds: [string, string];
  models: [string, string];
  results: Map<string, ComparisonRunResult>;
}

export class ComparisonCoordinator {
  private groups = new Map<string, ComparisonGroup>();
  private taskToGroup = new Map<string, string>();

  registerGroup(
    groupId: string,
    baseId: string,
    agentType: string,
    description: string,
    taskIds: [string, string],
    models: [string, string],
  ): void {
    const group: ComparisonGroup = {
      groupId,
      baseId,
      agentType,
      description,
      taskIds,
      models,
      results: new Map(),
    };
    this.groups.set(groupId, group);
    this.taskToGroup.set(taskIds[0], groupId);
    this.taskToGroup.set(taskIds[1], groupId);
  }

  isComparisonTask(taskId: string): boolean {
    return this.taskToGroup.has(taskId);
  }

  /** Seed a completed sibling recovered from durable session history. */
  recordTaskSettled(
    taskId: string,
    runResult: ComparisonRunResult,
    pi: ExtensionAPI,
    deliveryGuardAllowed: boolean = true,
    onDelivered?: (taskIds: [string, string]) => void,
  ): boolean {
    const groupId = this.taskToGroup.get(taskId);
    if (!groupId) return false;

    const group = this.groups.get(groupId);
    if (!group) return false;

    group.results.set(taskId, runResult);

    if (group.results.size >= 2) {
      const run0 = group.results.get(group.taskIds[0]);
      const run1 = group.results.get(group.taskIds[1]);

      this.groups.delete(groupId);
      this.taskToGroup.delete(group.taskIds[0]);
      this.taskToGroup.delete(group.taskIds[1]);

      if (run0 && run1 && deliveryGuardAllowed) {
        const report = formatComparisonReport({
          agentType: group.agentType,
          description: group.description,
          runs: [run0, run1],
        });

        const deliveryOptions = completionDeliveryOptions(
          process.env.PI_TASK_COMPLETION_DELIVERY,
        );

        let delivered = false;
        ignoreStaleExtensionCtx(() => {
          pi.sendMessage(
            {
              customType: "task-complete",
              content: report,
              display: true,
              details: {
                compare: true,
                agent_type: group.agentType,
                description: group.description,
                phase: "done",
                execution_phase: "done",
                models: group.models,
                task_ids: group.taskIds,
                runs: [run0, run1],
              },
            },
            deliveryOptions,
          );
          delivered = true;
        });
        if (delivered) onDelivered?.(group.taskIds);
      }
    }

    return true;
  }
}

export interface ComparisonHistoryUpdate {
  id: string;
  task: BackgroundTask;
  status: TaskSessionHistoryEntry["status"];
  background: boolean;
  sessionRef?: string;
  reportedStatus?: ComparisonRunResult["status"];
  rawStatus?: string;
  resultValid?: boolean;
  completedAt?: number;
}

export function persistComparisonTaskHistory(
  piDir: string,
  input: ComparisonHistoryUpdate,
): void {
  const { id, task } = input;
  upsertTaskSessionHistory(piDir, {
    id,
    agentType: task.agentType,
    description: task.description,
    sessionName: task.sessionName,
    startedAt: task.startedAt,
    paneId: task.paneId,
    handle: task.handle,
    piDir,
    dir: task.dir,
    cwd: task.cwd,
    conversationId: task.conversationId,
    sessionRef: input.sessionRef,
    status: input.status,
    reportedStatus: input.reportedStatus,
    rawStatus: input.rawStatus,
    resultValid: input.resultValid,
    completedAt: input.completedAt,
    background: input.background,
    comparisonGroupId: task.comparisonGroupId,
    comparisonModel: task.comparisonModel,
    comparisonDescription: task.comparisonDescription,
    comparisonIndex: task.comparisonIndex,
    comparisonDelivered: task.comparisonDelivered,
  });
}
