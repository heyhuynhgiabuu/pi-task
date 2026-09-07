import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { upsertTaskSessionHistory } from "./conversation.js";
import {
  formatComparisonReport,
  type ComparisonRunResult,
  completionDeliveryOptions,
} from "./helpers.js";
import { ignoreStaleExtensionCtx } from "./stale-ctx.js";
import type { BackgroundTask, TaskSessionHistoryEntry } from "./types.js";

export const DEFAULT_COMPARISON_JOIN_WINDOW_MS = 30_000;
const DEFAULT_PARTIAL_GROUP_RETENTION_MS = 5 * 60_000;

export interface ComparisonCoordinatorOptions {
  /** Maximum time to wait for the second sibling after the first settles. */
  joinWindowMs?: number;
  /** How long to consume a late sibling after a partial report. */
  partialRetentionMs?: number;
}

export interface ComparisonGroup {
  groupId: string;
  baseId: string;
  agentType: string;
  description: string;
  taskIds: [string, string];
  models: [string, string];
  results: Map<string, ComparisonRunResult>;
  startedAt: number;
  partialDelivered?: boolean;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

type DeliveryGuardCheck = (taskId: string) => boolean;

function positiveDuration(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    (timer as { unref?: () => void }).unref?.();
  }
}

export class ComparisonCoordinator {
  private readonly groups = new Map<string, ComparisonGroup>();
  private readonly taskToGroup = new Map<string, string>();
  private readonly joinWindowMs: number;
  private readonly partialRetentionMs: number;

  constructor(options: ComparisonCoordinatorOptions = {}) {
    this.joinWindowMs = positiveDuration(
      options.joinWindowMs,
      DEFAULT_COMPARISON_JOIN_WINDOW_MS,
    );
    this.partialRetentionMs = positiveDuration(
      options.partialRetentionMs,
      DEFAULT_PARTIAL_GROUP_RETENTION_MS,
    );
  }

  registerGroup(
    groupId: string,
    baseId: string,
    agentType: string,
    description: string,
    taskIds: [string, string],
    models: [string, string],
  ): void {
    this.clearGroup(groupId);
    const group: ComparisonGroup = {
      groupId,
      baseId,
      agentType,
      description,
      taskIds,
      models,
      results: new Map(),
      startedAt: Date.now(),
    };
    this.groups.set(groupId, group);
    this.taskToGroup.set(taskIds[0], groupId);
    this.taskToGroup.set(taskIds[1], groupId);
  }

  isComparisonTask(taskId: string): boolean {
    return this.taskToGroup.has(taskId);
  }

  private clearGroup(groupId: string): void {
    const group = this.groups.get(groupId);
    if (!group) return;
    if (group.deadlineTimer) clearTimeout(group.deadlineTimer);
    if (group.cleanupTimer) clearTimeout(group.cleanupTimer);
    this.groups.delete(groupId);
    this.taskToGroup.delete(group.taskIds[0]);
    this.taskToGroup.delete(group.taskIds[1]);
  }

  private deliverReport(
    group: ComparisonGroup,
    runs: [ComparisonRunResult, ComparisonRunResult],
    pi: ExtensionAPI,
    deliveryGuardAllowed: boolean,
    onDelivered: ((taskIds: [string, string]) => void) | undefined,
    partial: boolean,
  ): boolean {
    if (!deliveryGuardAllowed) return false;
    const report = formatComparisonReport({
      agentType: group.agentType,
      description: group.description,
      runs,
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
            partial,
            agent_type: group.agentType,
            description: group.description,
            phase: partial ? "partial" : "done",
            execution_phase: partial ? "partial" : "done",
            models: group.models,
            task_ids: group.taskIds,
            runs,
          },
        },
        deliveryOptions,
      );
      delivered = true;
    });
    if (delivered && !partial) onDelivered?.(group.taskIds);
    return delivered;
  }

  private expireGroup(
    groupId: string,
    pi: ExtensionAPI,
    deliveryGuardAllowed: boolean,
    onDelivered: ((taskIds: [string, string]) => void) | undefined,
    deliveryGuardCheck: DeliveryGuardCheck | undefined,
    onPartialDelivered: ((taskIds: [string, string]) => void) | undefined,
  ): void {
    const group = this.groups.get(groupId);
    if (!group || group.partialDelivered || group.results.size !== 1) return;
    const settledId = group.taskIds.find((id) => group.results.has(id));
    if (!settledId) return;
    const missingId = group.taskIds.find((id) => id !== settledId);
    if (!missingId) return;
    const deliveryAllowed = deliveryGuardCheck
      ? group.taskIds.every((taskId) => deliveryGuardCheck(taskId))
      : deliveryGuardAllowed;
    if (!deliveryAllowed) {
      group.deadlineTimer = undefined;
      group.cleanupTimer = setTimeout(() => this.clearGroup(groupId), this.partialRetentionMs);
      unrefTimer(group.cleanupTimer);
      return;
    }
    const missingIndex = group.taskIds[0] === missingId ? 0 : 1;
    const missingRun: ComparisonRunResult = {
      model: group.models[missingIndex],
      taskId: missingId,
      status: "failure",
      rawStatus: "comparison_timeout",
      summary: "Comparison sibling did not settle before the join deadline.",
      findings: "",
      evidence: "",
      files: "",
      caveats: "The comparison report contains only the sibling that settled in time.",
      nextSteps: "",
      toolUses: 0,
      durationMs: Date.now() - group.startedAt,
      error: `Comparison sibling ${missingId} did not settle within ${this.joinWindowMs}ms.`,
    };
    group.results.set(missingId, missingRun);
    group.deadlineTimer = undefined;
    const delivered = this.deliverReport(
      group,
      [group.results.get(group.taskIds[0])!, group.results.get(group.taskIds[1])!],
      pi,
      deliveryAllowed,
      onDelivered,
      true,
    );
    if (!delivered) {
      group.results.delete(missingId);
      group.cleanupTimer = setTimeout(() => this.clearGroup(groupId), this.partialRetentionMs);
      unrefTimer(group.cleanupTimer);
      return;
    }
    group.partialDelivered = true;
    try {
      onPartialDelivered?.(group.taskIds);
    } catch {
      // The partial report is already delivered; persistence retries on restart.
    }
    group.cleanupTimer = setTimeout(() => this.clearGroup(groupId), this.partialRetentionMs);
    unrefTimer(group.cleanupTimer);
  }

  private armDeadline(
    group: ComparisonGroup,
    pi: ExtensionAPI,
    deliveryGuardAllowed: boolean,
    onDelivered: ((taskIds: [string, string]) => void) | undefined,
    deliveryGuardCheck: DeliveryGuardCheck | undefined,
    onPartialDelivered: ((taskIds: [string, string]) => void) | undefined,
  ): void {
    if (group.deadlineTimer) return;
    group.deadlineTimer = setTimeout(
      () => this.expireGroup(
        group.groupId,
        pi,
        deliveryGuardAllowed,
        onDelivered,
        deliveryGuardCheck,
        onPartialDelivered,
      ),
      this.joinWindowMs,
    );
    unrefTimer(group.deadlineTimer);
  }

  /** Seed a completed sibling recovered from durable session history. */
  recordTaskSettled(
    taskId: string,
    runResult: ComparisonRunResult,
    pi: ExtensionAPI,
    deliveryGuardAllowed: boolean = true,
    onDelivered?: (taskIds: [string, string]) => void,
    deliveryGuardCheck?: DeliveryGuardCheck,
    onPartialDelivered?: (taskIds: [string, string]) => void,
  ): boolean {
    const groupId = this.taskToGroup.get(taskId);
    if (!groupId) return false;

    const group = this.groups.get(groupId);
    if (!group) return false;

    group.results.set(taskId, runResult);
    if (group.partialDelivered) {
      if (group.results.has(group.taskIds[0]) && group.results.has(group.taskIds[1])) {
        this.clearGroup(groupId);
      }
      return true;
    }

    if (group.results.size >= 2) {
      const run0 = group.results.get(group.taskIds[0]);
      const run1 = group.results.get(group.taskIds[1]);
      this.clearGroup(groupId);
      if (run0 && run1) {
        const deliveryAllowed = deliveryGuardCheck
          ? group.taskIds.every((groupTaskId) => deliveryGuardCheck(groupTaskId))
          : deliveryGuardAllowed;
        this.deliverReport(group, [run0, run1], pi, deliveryAllowed, onDelivered, false);
      }
    } else {
      this.armDeadline(
        group,
        pi,
        deliveryGuardAllowed,
        onDelivered,
        deliveryGuardCheck,
        onPartialDelivered,
      );
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
    ownerSessionId: task.ownerSessionId,
    ownerLeafId: task.ownerLeafId,
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
    ...(task.comparisonPartialDelivered !== undefined
      ? { comparisonPartialDelivered: task.comparisonPartialDelivered }
      : {}),
  });
}
