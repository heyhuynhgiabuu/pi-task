import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  BACKGROUND_POLL_CONCURRENCY,
  WRAP_UP_GRACE_TURNS,
  turnLimitWrapUpPrompt,
} from "../constants.js";
import {
  DurableStateError,
} from "../conversation.js";
import {
  getLastAssistantResultFromSessionDir,
  getLastAssistantTextFromSessionDir,
} from "../session-text.js";
import { getLastClaudeAssistantText } from "../subagent/claudeSession.js";
import type {
  ResourceProbe,
  TaskCompletionSnapshot,
} from "../subagent/waitCompletion.js";
import { taskRuntime, type BackgroundTask } from "../types.js";
import { completeTask, type ComparisonSettledHook } from "./completion.js";
import { persistTurnBudget } from "./turn-budget.js";

export interface BackgroundPollingDeps {
  backgroundTasks: Map<string, BackgroundTask>;
  checkTaskCompletion: (options: {
    sessionDir: string;
    sessionName: string;
    paneId?: string;
    artifactsDir?: string;
    taskId?: string;
    sinceMs?: number;
    resourceExists?: () => ResourceProbe | Promise<ResourceProbe>;
    exitSentinelPath?: string;
    runtime?: "pi" | "claude";
    claudeSessionFile?: string;
  }) => Promise<TaskCompletionSnapshot>;
  resourceExists?: (task: BackgroundTask) => ResourceProbe | Promise<ResourceProbe>;
  closeTask?: (task: BackgroundTask) => void | Promise<void>;
  clearTaskWidgetIfIdle: () => void;
  completeTask: typeof completeTask;
  onComparisonSettled?: ComparisonSettledHook;
  /** Optional per-task delivery guard consulted before delivering a result. */
  deliveryGuard?: (taskId: string) => boolean;
  /** Notified with the completed task so the panel can keep a lingering row. */
  onTaskFinished?: (id: string, task: BackgroundTask) => void;
  /** Resolved wall-clock ceiling in ms; `Infinity` when disabled (issue #28). */
  hardTimeoutMs: number;
  MAX_POLL_ERRORS: number;
  piDir: string;
  pi: ExtensionAPI;
  /**
   * Show a warning the user can actually see. Required, not optional: an optional hook lets the
   * next call site fall back to `console.error`, which the TUI draws over.
   */
  notifyUser: (text: string) => void;
  /**
   * Inject a user message into a running subagent (issue #19 wrap-up).
   * Returns false when the injection fails (dead pane, herdr unavailable);
   * the polling loop then settles the task immediately.
   */
  steerTask?: (task: BackgroundTask, prompt: string) => boolean | Promise<boolean>;
}

export function startBackgroundPolling(
  deps: BackgroundPollingDeps,
  pollMs: number,
): () => void {
  let stopped = false;
  let inFlight = false;
  const pollErrors = new Map<string, number>();
  const durableStateReported = new Set<string>();
  // Herdr outages are counted separately from poll failures: an outage keeps the task alive, so
  // sharing `pollErrors` would let an outage end a healthy task.
  const herdrOutages = new Map<string, number>();

  // Terminal settlement for every path that ends a task: deliver durably, then retire it.
  const settle = (
    id: string,
    task: BackgroundTask,
    content: string,
    phase: "done" | "timeout" | "failed",
  ): void => {
    deps.completeTask({
      pi: deps.pi,
      id,
      task,
      content,
      phase,
      piDir: deps.piDir,
      deliveryGuard: deps.deliveryGuard ? () => deps.deliveryGuard!(id) : undefined,
      onComparisonSettled: deps.onComparisonSettled,
    });
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
    durableStateReported.delete(id);
    herdrOutages.delete(id);
  };
  const warn = (text: string): void => {
    // A warning must never change the outcome of the poll that raised it: inside the turn-limit
    // catch a throw from here would skip the steer and send a working task down the error path.
    try {
      deps.notifyUser(`[pi-task] ${text}`);
    } catch {
      // A warning that could not be shown is not a task failure.
    }
  };
  const reportDurableStateBlocked = (id: string, error: unknown): boolean => {
    if (!(error instanceof DurableStateError)) return false;
    // Keep the diagnostic bounded while retaining the task for retry after the
    // unreadable durable file is repaired.
    if (!durableStateReported.has(id)) {
      durableStateReported.add(id);
      warn(`background task ${id} settlement blocked: ${error.message}`);
    }
    return true;
  };
  const pollTask = async (id: string, task: BackgroundTask): Promise<void> => {
    // SDK and durable tasks own their completion/progress stream; neither is
    // settled from the terminal-session artifact layout below.
    if (task.backend === "sdk" || task.backend === "durable") return;
    try {
      const sessionDir = join(task.dir, "sessions", id);
      const elapsed = Date.now() - task.startedAt;
      if (elapsed > deps.hardTimeoutMs) {
        if (deps.backgroundTasks.get(id) !== task) return;
        const terminalResult = getLastAssistantResultFromSessionDir(
          sessionDir,
          task.sessionName,
          task.startedAt,
        );
        const timeoutContent =
          terminalResult?.content ||
          `Task timed out after ${Math.round(deps.hardTimeoutMs / 1000)}s without producing a result.`;
        settle(
          id,
          task,
          timeoutContent,
          terminalResult?.status === "completed" ? "done" :
            terminalResult?.status === "failed" ? "failed" : "timeout",
        );
        return;
      }

      // Turn-based soft limit (issue #19): steer a wrap-up at the limit,
      // allow a bounded grace of further turns, then settle with whatever
      // the subagent produced instead of discarding it. SDK tasks are
      // skipped above (no terminal session to steer). The limit counts the
      // turns of the current request (issue #30: lifetime turns minus the
      // request baseline); the wrap-up anchor and grace window stay in
      // absolute lifetime turns.
      if (task.maxTurns !== undefined) {
        // This worker may have awaited siblings since the tick snapshot; a
        // replaced tracker owns the (possibly renewed) budget now.
        if (deps.backgroundTasks.get(id) !== task) return;
        const readPartial = () =>
          taskRuntime(task) === "claude"
            ? getLastClaudeAssistantText(
                task.claudeSessionFile ?? "",
                task.startedAt,
              )
            : getLastAssistantTextFromSessionDir(
                sessionDir,
                task.sessionName,
                task.startedAt,
              );
        const settleAtLimit = (reason: string) =>
          settle(
            id,
            task,
            `${readPartial() || "No assistant output captured."}\n\nTask reached the ${task.maxTurns}-turn limit${reason}`,
            "timeout",
          );
        if (!task.wrapUp && Math.max(0, task.turns - (task.turnBaseline ?? 0)) >= task.maxTurns) {
          task.wrapUp = { turnsAtStart: task.turns };
          // Persist before steering so a same-run restart does not regrant
          // the grace window. Best-effort: a registry failure must neither
          // skip the steer nor reach the poll-error path (the in-memory flag
          // is already set, so a retry would never steer).
          try {
            persistTurnBudget(deps.piDir, id, { wrapUp: task.wrapUp });
          } catch (error) {
            warn(
              `background task ${id} wrap-up state was not persisted: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          const steered = await (deps.steerTask?.(task, turnLimitWrapUpPrompt(task.maxTurns)) ?? false);
          if (!steered) {
            if (deps.backgroundTasks.get(id) !== task) return;
            settleAtLimit("; wrap-up steering failed.");
            return;
          }
        } else if (
          task.wrapUp &&
          task.turns >= task.wrapUp.turnsAtStart + WRAP_UP_GRACE_TURNS
        ) {
          if (deps.backgroundTasks.get(id) !== task) return;
          settleAtLimit(` and did not wrap up within ${WRAP_UP_GRACE_TURNS} further turns.`);
          return;
        }
      }

      const snapshot = await deps.checkTaskCompletion({
        sessionDir,
        sessionName: task.sessionName,
        paneId: task.paneId,
        artifactsDir: task.dir,
        taskId: id,
        sinceMs: task.startedAt,
        resourceExists: deps.resourceExists ? () => deps.resourceExists!(task) : undefined,
        exitSentinelPath: task.exitSentinelPath,
        ...(taskRuntime(task) === "claude"
          ? { runtime: "claude" as const, claudeSessionFile: task.claudeSessionFile }
          : {}),
      });

      if (stopped || deps.backgroundTasks.get(id) !== task) return;

      // A non-throwing probe means this poll did not fail. Only consecutive
      // probe failures should count toward MAX_POLL_ERRORS.
      pollErrors.delete(id);
      herdrOutages.delete(id);

      if (snapshot.status === "completed") {
        settle(id, task, snapshot.content, "done");
      } else if (snapshot.status === "failed" || snapshot.status === "timeout") {
        settle(
          id,
          task,
          snapshot.content,
          snapshot.status === "timeout" ? "timeout" : "failed",
        );
      }
    } catch (error) {
      if (error instanceof Error && error.name === "HerdrUnavailableError") {
        // An unreachable control is an outage, not a dead child: the pane and the session file are
        // untouched, so settling would close a healthy pane. Two things are still owed.
        //
        // A child that finished before the control went away is recoverable from its session
        // file, but only on a `completed` result: a `failed` row can be intermediate while Pi
        // retries, and the outage cannot tell whether the child is alive. `waitCompletion` draws
        // the same line for the same reason.
        const terminalResult = getLastAssistantResultFromSessionDir(
          join(task.dir, "sessions", id),
          task.sessionName,
          task.startedAt,
        );
        if (terminalResult?.status === "completed") {
          if (deps.backgroundTasks.get(id) !== task) return;
          try {
            settle(id, task, terminalResult.content, "done");
          } catch (settlementError) {
            reportDurableStateBlocked(id, settlementError);
          }
          return;
        }
        // Warn once after MAX_POLL_ERRORS outage polls in a row: enough to be a real outage, not a
        // single dropped read. The count resets on any successful probe.
        if (deps.backgroundTasks.get(id) === task) {
          const count = (herdrOutages.get(id) ?? 0) + 1;
          herdrOutages.set(id, count);
          if (count === deps.MAX_POLL_ERRORS) {
            warn(
              `background task ${id} could not be read: ${error.message}. The Herdr control is unavailable; the task is kept and polling continues.`,
            );
          }
        }
        return;
      }
      if (reportDurableStateBlocked(id, error)) return;
      const count = (pollErrors.get(id) ?? 0) + 1;
      pollErrors.set(id, count);
      if (count >= deps.MAX_POLL_ERRORS) {
        if (deps.backgroundTasks.get(id) !== task) return;
        try {
          settle(
            id,
            task,
            `Background task polling failed: ${error instanceof Error ? error.message : String(error)}`,
            "failed",
          );
        } catch (settlementError) {
          // A durable-write failure while reporting the poll failure must
          // not escape the tick as an unhandled rejection; keep the task
          // so a later tick can retry settlement.
          reportDurableStateBlocked(id, settlementError);
        }
      }
    }
  };

  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;

    try {
      const pendingTasks = Array.from(deps.backgroundTasks.entries())
        .filter(([, task]) => task.backend !== "sdk" && task.backend !== "durable");
      if (pendingTasks.length === 0) return;

      // Poll tasks independently so one slow pane cannot hold up all siblings,
      // but cap backend probes to avoid replacing head-of-line blocking with a
      // burst of unbounded tmux/HerdR work.
      const concurrency = Math.max(1, Math.floor(BACKGROUND_POLL_CONCURRENCY));
      let nextIndex = 0;
      const worker = async (): Promise<void> => {
        while (!stopped) {
          const index = nextIndex++;
          const entry = pendingTasks[index];
          if (!entry) return;
          await pollTask(entry[0], entry[1]);
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(concurrency, pendingTasks.length) },
          () => worker(),
        ),
      );
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
