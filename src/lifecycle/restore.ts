import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  readRegistry,
  upsertTaskSessionHistory,
  writeRegistry,
} from "../conversation.js";
import { hasAgentFinished, getLastMessageTimestampFromSessionDir } from "../session-text.js";
import { killAgentPane, paneExists } from "../subagent/tmux.js";
import type { BackgroundTask, RegistryEntry } from "../types.js";

export function restoreActiveBackgroundTasks(
  piDir: string,
  backgroundTasks: Map<string, BackgroundTask>,
  resourceExists?: (entry: RegistryEntry) => boolean,
  closeResource?: (entry: RegistryEntry) => void,
): void {
  const registry = readRegistry(piDir);
  const staleIds: string[] = [];
  const restoreTask = (entry: RegistryEntry, paneId: string | undefined): void => {
    backgroundTasks.set(entry.id, {
      dir: entry.dir,
      cwd: entry.cwd,
      agentType: entry.agentType,
      sessionName: entry.sessionName,
      paneId,
      handle: entry.handle,
      backend: entry.handle?.backend ?? entry.backend ?? "tmux",
      originalPane: null,
      description: entry.description,
      startedAt: entry.startedAt,
      toolUses: 0,
      turns: 0,
      conversationId: entry.conversationId,
      recentCalls: [],
      comparisonGroupId: entry.comparisonGroupId,
      comparisonModel: entry.comparisonModel,
      comparisonDescription: entry.comparisonDescription,
      comparisonIndex: entry.comparisonIndex,
      comparisonDelivered: entry.comparisonDelivered,
    });
  };

  for (const entry of registry) {
    try {
      restoreEntry(entry);
    } catch {
      // A failed durable write or unreadable session during restore must not
      // abort extension registration; retain the entry for a later attempt.
    }
  }

  if (staleIds.length) {
    writeRegistry(
      piDir,
      registry.filter((entry) => !staleIds.includes(entry.id)),
    );
  }

  function restoreEntry(entry: RegistryEntry): void {
    if (entry.cleanupPending) {
      try {
        if (closeResource) closeResource(entry);
        else if (entry.handle?.backend !== "herdr" && (entry.handle?.resourceId ?? entry.paneId)) {
          killAgentPane(entry.handle?.resourceId ?? entry.paneId!, null);
        } else if (entry.handle?.backend === "herdr") {
          return;
        }
        // completion writes the cleanup receipt BEFORE the history upsert, so
        // a crash (or an unwritable history file) can leave a receipt without
        // a terminal record. Synthesize it here: comparison grouping needs
        // both siblings' history records, and a receipt-only task would
        // otherwise vanish from history when its registry entry is removed.
        const receiptSessionDirs = [join(entry.dir, "sessions", entry.id), entry.dir];
        const receiptCompletedAt = receiptSessionDirs
          .map((dir) =>
            getLastMessageTimestampFromSessionDir(dir, entry.sessionName, entry.startedAt),
          )
          .find((ts) => ts !== undefined) ?? Date.now();
        upsertTaskSessionHistory(piDir, {
          id: entry.id,
          status: entry.cleanupPhase ?? "failed",
          background: true,
          agentType: entry.agentType,
          description: entry.description,
          sessionName: entry.sessionName,
          startedAt: entry.startedAt,
          handle: entry.handle,
          paneId: entry.paneId,
          piDir: entry.piDir,
          dir: entry.dir,
          cwd: entry.cwd,
          conversationId: entry.conversationId,
          completedAt: receiptCompletedAt,
          comparisonGroupId: entry.comparisonGroupId,
          comparisonModel: entry.comparisonModel,
          comparisonDescription: entry.comparisonDescription,
          comparisonIndex: entry.comparisonIndex,
          comparisonDelivered: entry.comparisonDelivered,
        });
        staleIds.push(entry.id);
      } catch {
        // Keep the terminal cleanup receipt for a later retry.
      }
      return;
    }

    if (!existsSync(entry.dir)) {
      staleIds.push(entry.id);
      return;
    }

    // Production layout nests per-task sessions under dir/sessions/<id>
    // (see startBackgroundPolling); legacy records and tests may point dir
    // directly at the session folder, so accept both.
    const sessionDirs = [join(entry.dir, "sessions", entry.id), entry.dir];
    const sessionFinished = sessionDirs.some((dir) =>
      hasAgentFinished(dir, entry.sessionName, entry.startedAt),
    );
    const paneId = entry.handle?.resourceId ?? entry.paneId;
    let paneAlive: boolean;
    try {
      paneAlive = resourceExists
        ? resourceExists(entry)
        : entry.handle?.backend === "herdr"
          ? false
          : Boolean(paneId && paneExists(paneId));
    } catch {
      // A temporary backend outage must not destroy the durable task record.
      return;
    }

    if (sessionFinished) {
      // Faithful completion time from the session itself: restore can happen
      // long after the child finished, and recovered comparison reports would
      // otherwise inflate durations by the outage length.
      const completedAt = sessionDirs
        .map((dir) =>
          getLastMessageTimestampFromSessionDir(dir, entry.sessionName, entry.startedAt),
        )
        .find((ts) => ts !== undefined) ?? Date.now();
      upsertTaskSessionHistory(piDir, {
        id: entry.id,
        status: "done",
        background: true,
        agentType: entry.agentType,
        description: entry.description,
        sessionName: entry.sessionName,
        startedAt: entry.startedAt,
        handle: entry.handle,
        paneId: entry.paneId,
        piDir: entry.piDir,
        dir: entry.dir,
        cwd: entry.cwd,
        completedAt,
        comparisonGroupId: entry.comparisonGroupId,
        comparisonModel: entry.comparisonModel,
        comparisonDescription: entry.comparisonDescription,
        comparisonIndex: entry.comparisonIndex,
        comparisonDelivered: entry.comparisonDelivered,
      });
      let cleanupSucceeded = true;
      if (entry.handle?.backend === "herdr") {
        if (!closeResource) cleanupSucceeded = false;
        else {
          try {
            closeResource(entry);
          } catch {
            cleanupSucceeded = false;
          }
        }
      } else if (paneAlive && paneId) {
        try {
          if (closeResource) closeResource(entry);
          else killAgentPane(paneId, null);
        } catch {
          cleanupSucceeded = false;
        }
      }

      if (cleanupSucceeded) staleIds.push(entry.id);
      return;
    }

    // Comparison siblings whose session is still running must remain active;
    // a sibling already finished above is recovered from durable history and
    // fed into the coordinator during extension startup.
    if (entry.comparisonGroupId && entry.comparisonModel) {
      restoreTask(entry, paneId);
      return;
    }

    if (!paneAlive) {
      let cleanupSucceeded = true;
      if (entry.handle?.backend === "herdr") {
        if (!closeResource) cleanupSucceeded = false;
        else {
          try {
            closeResource(entry);
          } catch {
            cleanupSucceeded = false;
          }
        }
      }
      if (!cleanupSucceeded) return;
      upsertTaskSessionHistory(piDir, {
        id: entry.id,
        status: "failed",
        background: true,
        agentType: entry.agentType,
        description: entry.description,
        sessionName: entry.sessionName,
        startedAt: entry.startedAt,
        handle: entry.handle,
        paneId: entry.paneId,
        piDir: entry.piDir,
        dir: entry.dir,
        cwd: entry.cwd,
        completedAt: Date.now(),
        comparisonGroupId: entry.comparisonGroupId,
        comparisonModel: entry.comparisonModel,
        comparisonDescription: entry.comparisonDescription,
        comparisonIndex: entry.comparisonIndex,
        comparisonDelivered: entry.comparisonDelivered,
      });
      staleIds.push(entry.id);
      return;
    }

    restoreTask(entry, paneId);
  }
}
