import { existsSync } from "node:fs";
import { readRegistry, writeRegistry } from "../conversation.js";
import { paneExists } from "../subagent/tmux.js";
import type { BackgroundTask } from "../types.js";

export function restoreActiveBackgroundTasks(
  piDir: string,
  backgroundTasks: Map<string, BackgroundTask>,
): void {
  const registry = readRegistry(piDir);
  const staleIds: string[] = [];

  for (const entry of registry) {
    if (!existsSync(entry.dir)) {
      staleIds.push(entry.id);
      continue;
    }

    const paneAlive = entry.paneId ? paneExists(entry.paneId) : false;
    if (!paneAlive) {
      staleIds.push(entry.id);
      continue;
    }

    backgroundTasks.set(entry.id, {
      dir: entry.dir,
      agentType: entry.agentType,
      sessionName: entry.sessionName,
      paneId: entry.paneId,
      originalPane: null,
      description: entry.description,
      startedAt: entry.startedAt,
      toolUses: 0,
      turns: 0,
      conversationId: entry.conversationId,
      recentCalls: [],
    });
  }

  if (staleIds.length) {
    writeRegistry(
      piDir,
      registry.filter((entry) => !staleIds.includes(entry.id)),
    );
  }
}
