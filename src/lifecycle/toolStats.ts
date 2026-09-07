import { join } from "node:path";
import { readRecentToolCalls } from "../helpers.js";
import { claudeToolUseCount } from "../subagent/claudeSession.js";
import { taskRuntime, type BackgroundTask } from "../types.js";

export function startToolStatsPolling(
  foregroundTasks: Map<string, BackgroundTask>,
  backgroundTasks: Map<string, BackgroundTask>,
  intervalMs: number,
  onUpdate?: () => void,
): NodeJS.Timeout {
  return setInterval(() => {
    const trackedTasks = [
      ...foregroundTasks.entries(),
      ...backgroundTasks.entries(),
    ] as Array<[string, BackgroundTask]>;
    let changed = false;

    for (const [id, task] of trackedTasks) {
      if (task.backend === "sdk") continue;
      const sessionDir = join(task.dir, "sessions", id);
      // Claude transcripts have no pi tool-call records; expose a best-effort
      // tool-use count and skip turn/recent-call bookkeeping instead of
      // reading the pi session layout (which never exists for claude tasks).
      const { toolUses, turns, recent } = taskRuntime(task) === "claude"
        ? { toolUses: claudeToolUseCount(task.claudeSessionFile ?? "", task.startedAt), turns: 0, recent: [] }
        : readRecentToolCalls(sessionDir, 12, task.sessionName);
      if (
        task.toolUses !== toolUses ||
        task.turns !== turns ||
        JSON.stringify(task.recentCalls) !== JSON.stringify(recent)
      ) {
        changed = true;
        task.toolUses = toolUses;
        task.turns = turns;
        task.recentCalls = recent;
      }
    }

    if (changed) onUpdate?.();
  }, intervalMs);
}
