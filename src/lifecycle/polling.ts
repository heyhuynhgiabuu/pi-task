import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TaskCompletionSnapshot } from "../subagent/waitCompletion.js";
import type { BackgroundTask } from "../types.js";
import { completeTask } from "./completion.js";

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
      killAgentPane: (paneId: string, originalPane: string | null) => void;
  clearTaskWidgetIfIdle: () => void;
  completeTask: typeof completeTask;
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
            deps.completeTask(
              deps.pi,
              id,
              task,
              `Task timed out after ${Math.round(deps.TASK_TIMEOUT_MS / 1000)}s without producing a result.`,
              "timeout",
              deps.piDir,
            );
            deps.backgroundTasks.delete(id);
            deps.clearTaskWidgetIfIdle();
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
            deps.completeTask(deps.pi, id, task, snapshot.content, "done", deps.piDir);
            deps.backgroundTasks.delete(id);
            deps.clearTaskWidgetIfIdle();
            pollErrors.delete(id);
          } else if (snapshot.status === "failed" || snapshot.status === "timeout") {
            if (deps.backgroundTasks.get(id) !== task) continue;
            deps.completeTask(
              deps.pi,
              id,
              task,
              snapshot.content,
              snapshot.status === "timeout" ? "timeout" : "failed",
              deps.piDir,
            );
            deps.backgroundTasks.delete(id);
            deps.clearTaskWidgetIfIdle();
            pollErrors.delete(id);
          }
        } catch (error) {
          if (error instanceof Error && error.name === "HerdrUnavailableError") {
            continue;
          }
          const count = (pollErrors.get(id) ?? 0) + 1;
          pollErrors.set(id, count);
          if (count >= deps.MAX_POLL_ERRORS) {
            if (deps.backgroundTasks.get(id) !== task) continue;
            deps.completeTask(
              deps.pi,
              id,
              task,
              `Background task polling failed: ${error instanceof Error ? error.message : String(error)}`,
              "failed",
              deps.piDir,
            );
            deps.backgroundTasks.delete(id);
            deps.clearTaskWidgetIfIdle();
            pollErrors.delete(id);
          }
        }
      }
    } finally {
      inFlight = false;
    }
  };

  const interval = setInterval(() => {
    void tick();
  }, pollMs);

  return () => {
    stopped = true;
    clearInterval(interval);
  };
}
