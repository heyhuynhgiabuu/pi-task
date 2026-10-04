import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { BackgroundTask } from "../types.js";

function blockIfTasksAreTracked(
  ctx: ExtensionContext,
  foregroundTasks: ReadonlyMap<string, BackgroundTask>,
  backgroundTasks: ReadonlyMap<string, BackgroundTask>,
  hasPendingCompletionDelivery: () => boolean,
): { cancel: true } | undefined {
  if (
    foregroundTasks.size === 0 &&
    backgroundTasks.size === 0 &&
    !hasPendingCompletionDelivery()
  ) {
    return undefined;
  }
  ctx.ui.notify(
    "Cannot replace this Pi session while pi-task agents or completion notices are pending. Wait for them to finish or stop them first; use /task list for live steering.",
    "warning",
  );
  return { cancel: true };
}

/** Keep the task runtime intact until session replacement can no longer discard its live handles. */
export function registerTaskSessionReplacementGuard(
  pi: Pick<ExtensionAPI, "on">,
  foregroundTasks: ReadonlyMap<string, BackgroundTask>,
  backgroundTasks: ReadonlyMap<string, BackgroundTask>,
  hasPendingCompletionDelivery: () => boolean = () => false,
): void {
  pi.on("session_before_switch", (_event, ctx) =>
    blockIfTasksAreTracked(
      ctx,
      foregroundTasks,
      backgroundTasks,
      hasPendingCompletionDelivery,
    ),
  );
  pi.on("session_before_fork", (_event, ctx) =>
    blockIfTasksAreTracked(
      ctx,
      foregroundTasks,
      backgroundTasks,
      hasPendingCompletionDelivery,
    ),
  );
}
