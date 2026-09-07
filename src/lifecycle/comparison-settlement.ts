import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  findTaskSessionHistory,
  markComparisonGroupDelivered,
  markComparisonGroupPartiallyDelivered,
} from "../conversation.js";
import {
  assessTaskResult,
  type ParsedResult,
  type ComparisonRunResult,
} from "../helpers.js";
import type { ComparisonCoordinator } from "../comparison.js";
import type { TaskWidgetController } from "./widget.js";
import { sessionViewOf } from "../panel/delivery.js";
import type { DeliveryGuard } from "../panel/delivery.js";
import type { BackgroundTask } from "../types.js";

export type ComparisonSettledPhase = "done" | "cancelled" | "timeout" | "failed";

export interface ComparisonSettledHandlerOptions {
  piDir: string;
  pi: ExtensionAPI;
  comparisonCoordinator: ComparisonCoordinator;
  taskWidget: Pick<TaskWidgetController, "getContext">;
  deliveryGuard: DeliveryGuard;
}

export function createComparisonSettledHandler({
  piDir,
  pi,
  comparisonCoordinator,
  taskWidget,
  deliveryGuard,
}: ComparisonSettledHandlerOptions): (
  id: string,
  task: BackgroundTask,
  parsed: ParsedResult,
  phase: ComparisonSettledPhase,
) => boolean {
  return (
    id: string,
    task: BackgroundTask,
    parsed: ParsedResult,
    phase: ComparisonSettledPhase,
  ): boolean => {
    if (task.comparisonPartialDelivered === true) return true;
    if (!task.comparisonGroupId) return false;
    if (findTaskSessionHistory(piDir, id)?.comparisonPartialDelivered === true) {
      return true;
    }
    const assessment = assessTaskResult(parsed);
    const runResult: ComparisonRunResult = {
      model: task.comparisonModel || task.agentType,
      taskId: id,
      status: phase === "done" ? assessment.reportedStatus : "failure",
      rawStatus: phase === "done" ? assessment.rawStatus : phase,
      summary: parsed.summary,
      findings: parsed.findings,
      evidence: parsed.evidence,
      files: parsed.files,
      caveats: parsed.caveats,
      nextSteps: parsed.next_steps,
      toolUses: task.toolUses,
      durationMs: Date.now() - task.startedAt,
    };
    const ctx = taskWidget.getContext();
    const allowed = ctx ? deliveryGuard.allows(sessionViewOf(ctx), id) : true;
    return comparisonCoordinator.recordTaskSettled(
      id,
      runResult,
      pi,
      allowed,
      (taskIds) => markComparisonGroupDelivered(piDir, taskIds),
      (taskId) => {
        const current = taskWidget.getContext();
        return current ? deliveryGuard.allows(sessionViewOf(current), taskId) : true;
      },
      (taskIds) => markComparisonGroupPartiallyDelivered(piDir, taskIds),
    );
  };
}
