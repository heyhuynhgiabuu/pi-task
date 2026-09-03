import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TaskCompletionSnapshot } from "../subagent/waitCompletion.js";
import type { BackgroundTask } from "../types.js";
import { completeTask, type ComparisonSettledHook } from "./completion.js";

export interface BackgroundPollingDeps {
  backgroundTasks: Map<string, BackgroundTask>;
  checkTaskCompletion: (options: {
    sessionDir: string;
    sessionName: string;
    paneId?: string;
    artifactsDir?: string;
    taskId?: string;
        sinceMs?: number;
        resourceExists?: () => boolean | Promise<boolean>;
        exitSentinelPath?: string;
      }) => Promise<TaskCompletionSnapshot>;
      resourceExists?: (task: BackgroundTask) => boolean | Promise<boolean>;
      closeTask?: (task: BackgroundTask) => void | Promise<void>;
  clearTaskWidgetIfIdle: () => void;
  completeTask: typeof completeTask;
  onComparisonSettled?: ComparisonSettledHook;
  /** Optional per-task delivery guard consulted before delivering a result. */
  deliveryGuard?: (taskId: string) => boolean;
  /** Notified with the completed task so the panel can keep a lingering row. */
  onTaskFinished?: (id: string, task: BackgroundTask) => void;
  TASK_TIMEOUT_MS: number;
  MAX_POLL_ERRORS: number;
  piDir: string;
  pi: ExtensionAPI;
}

export function startBackgroundPolling(
  deps: BackgroundPollingDeps,
  pollMs: number,
): () => void {
  let stopped = false;
  let inFlight = false;
  const pollErrors = new Map<string, number>();

  // Terminal settlement shared by the timeout, completed, failed, and
  // poll-error paths: deliver durably, then retire the task from the maps.
  const settle = (
    id: string,
    task: BackgroundTask,
    content: string,
    phase: "done" | "timeout" | "failed",
  ): void => {
    deps.completeTask(
      deps.pi,
      id,
      task,
      content,
      phase,
      deps.piDir,
      undefined,
      deps.deliveryGuard ? () => deps.deliveryGuard!(id) : undefined,
      deps.onComparisonSettled,
    );
    // Settlement is durable from here: retirement must be unconditional. A
    // throwing notification callback must not leave the task in the map —
    // a retried completeTask is an idempotent no-op, so the zombie could
    // never be recovered.
    try {
      deps.onTaskFinished?.(id, task);
    } catch {
      // Panel notification is best-effort.
    }
    deps.backgroundTasks.delete(id);
    try {
      deps.clearTaskWidgetIfIdle();
    } catch {
      // Widget refresh is best-effort.
    }
    pollErrors.delete(id);
  };
  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;

    try {
      for (const [id, task] of deps.backgroundTasks) {
        if (task.backend === "sdk") continue;
        try {
          const elapsed = Date.now() - task.startedAt;
          if (elapsed > deps.TASK_TIMEOUT_MS) {
            if (deps.backgroundTasks.get(id) !== task) continue;
            settle(
              id,
              task,
              `Task timed out after ${Math.round(deps.TASK_TIMEOUT_MS / 1000)}s without producing a result.`,
              "timeout",
            );
            continue;
          }

          const snapshot = await deps.checkTaskCompletion({
            sessionDir: join(task.dir, "sessions", id),
            sessionName: task.sessionName,
            paneId: task.paneId,
            artifactsDir: task.dir,
            taskId: id,
                sinceMs: task.startedAt,
                resourceExists: deps.resourceExists ? () => deps.resourceExists!(task) : undefined,
                exitSentinelPath: task.exitSentinelPath,
              });

          if (stopped) return;

          if (snapshot.status === "completed") {
            if (deps.backgroundTasks.get(id) !== task) continue;
            settle(id, task, snapshot.content, "done");
          } else if (snapshot.status === "failed" || snapshot.status === "timeout") {
            if (deps.backgroundTasks.get(id) !== task) continue;
            settle(
              id,
              task,
              snapshot.content,
              snapshot.status === "timeout" ? "timeout" : "failed",
            );
          }
        } catch (error) {
          if (error instanceof Error && error.name === "HerdrUnavailableError") {
            continue;
          }
          const count = (pollErrors.get(id) ?? 0) + 1;
          pollErrors.set(id, count);
          if (count >= deps.MAX_POLL_ERRORS) {
            if (deps.backgroundTasks.get(id) !== task) continue;
            try {
              settle(
                id,
                task,
                `Background task polling failed: ${error instanceof Error ? error.message : String(error)}`,
                "failed",
              );
            } catch {
              // A durable-write failure while reporting the poll failure must
              // not escape the tick as an unhandled rejection; keep the task
              // so a later tick can retry settlement.
              continue;
            }
          }
        }
      }
    } finally {
      inFlight = false;
    }
  };

  const interval = setInterval(() => {
    // Terminal guard: any escape from tick (including double-faults from the
    // catch-handler above) must never surface as an unhandled rejection in
    // the host Pi process.
    tick().catch(() => {});
  }, pollMs);

  return () => {
    stopped = true;
    clearInterval(interval);
  };
}
