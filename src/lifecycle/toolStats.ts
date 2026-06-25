import { join } from "node:path";
import { readRecentToolCalls } from "../helpers.js";
import type { BackgroundTask } from "../types.js";

export function startToolStatsPolling(
  foregroundTasks: Map<string, BackgroundTask>,
  backgroundTasks: Map<string, BackgroundTask>,
  intervalMs: number,
): NodeJS.Timeout {
  return setInterval(() => {
    const trackedTasks = [
      ...foregroundTasks.entries(),
      ...backgroundTasks.entries(),
    ] as Array<[string, BackgroundTask]>;

    for (const [id, task] of trackedTasks) {
      const sessionDir = join(task.dir, "sessions", id);
      const { toolUses, turns, recent } = readRecentToolCalls(
        sessionDir,
        12,
        task.sessionName,
      );
      task.toolUses = toolUses;
      task.turns = turns;
      task.recentCalls = recent;
    }
  }, intervalMs);
}
