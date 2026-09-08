import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  readRegistry,
  updateRegistry,
  upsertTaskSessionHistory,
} from "../conversation.js";
import {
  getLastAssistantResultFromSessionDir,
  getLastMessageTimestampFromSessionDir,
} from "../session-text.js";
import {
  claudeSessionFilePath,
  getLastClaudeMessageTimestamp,
  hasClaudeFinished,
} from "../subagent/claudeSession.js";
import {
  killAgentPaneStrictAsync,
  probePaneAsync,
} from "../subagent/tmux.js";
import { taskRuntime, type BackgroundTask, type RegistryEntry } from "../types.js";

/** A syntactically valid Claude Code session UUID. */
function isClaudeSessionId(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

/**
 * Transcript path for a persisted claude entry: prefer the durable session
 * UUID; legacy entries without one may fall back to sessionName only when it
 * is itself a UUID (early builds pinned it as such). Anything else must not
 * invent a path — restore polls the pi layout or fails closed instead.
 */
function restoredClaudeSessionFile(entry: RegistryEntry): string | undefined {
  if (taskRuntime(entry) !== "claude" || !entry.cwd) return undefined;
  const sessionId = isClaudeSessionId(entry.claudeSessionId)
    ? entry.claudeSessionId
    : isClaudeSessionId(entry.sessionName)
      ? entry.sessionName
      : undefined;
  return sessionId ? claudeSessionFilePath(entry.cwd, sessionId) : undefined;
}

function restoredClaudeCompletionAt(
  entry: RegistryEntry,
  sinceMs: number,
): number | undefined {
  const file = restoredClaudeSessionFile(entry);
  return file ? getLastClaudeMessageTimestamp(file, sinceMs) : undefined;
}

export async function restoreActiveBackgroundTasks(
  piDir: string,
  backgroundTasks: Map<string, BackgroundTask>,
  resourceExists?: (entry: RegistryEntry) => boolean | Promise<boolean>,
  closeResource?: (entry: RegistryEntry) => void | Promise<void>,
  session?: { sessionId: string; isProcessAlive?: (pid: number) => boolean },
): Promise<void> {
  const registry = readRegistry(piDir);
  const staleIds: string[] = [];
  const ownerAlive = session?.isProcessAlive ?? defaultProcessAlive;
  const terminalReceipt = (
    entry: RegistryEntry,
    status: "done" | "failed",
    completedAt: number,
  ): void => {
    upsertTaskSessionHistory(piDir, {
      id: entry.id,
      status,
      background: true,
      agentType: entry.agentType,
      description: entry.description,
      sessionName: entry.sessionName,
      runtime: entry.runtime,
      ...(entry.claudeSessionId !== undefined
        ? { claudeSessionId: entry.claudeSessionId }
        : {}),
      startedAt: entry.startedAt,
      handle: entry.handle,
      paneId: entry.paneId,
      piDir: entry.piDir,
      dir: entry.dir,
      cwd: entry.cwd,
      ownerSessionId: entry.ownerSessionId,
      ownerLeafId: entry.ownerLeafId,
      completedAt,
      comparisonGroupId: entry.comparisonGroupId,
      comparisonModel: entry.comparisonModel,
      comparisonDescription: entry.comparisonDescription,
      comparisonIndex: entry.comparisonIndex,
      comparisonDelivered: entry.comparisonDelivered,
      ...(entry.comparisonPartialDelivered !== undefined
        ? { comparisonPartialDelivered: entry.comparisonPartialDelivered }
        : {}),
    });
  };
  // Best-effort terminal cleanup. HerdR resources always need an explicit
  // close (with the persisted identity for it); a tmux pane is killed only
  // when it may still be alive.
  const closeEntryResource = async (
    entry: RegistryEntry,
    paneId: string | undefined,
    killPane: boolean,
  ): Promise<boolean> => {
    if (entry.handle?.backend === "herdr") {
      if (!closeResource) return false;
      try {
        await closeResource(entry);
        return true;
      } catch {
        return false;
      }
    }
    if (!killPane || !paneId) return true;
    try {
      if (closeResource) await closeResource(entry);
      else await killAgentPaneStrictAsync(paneId, null);
      return true;
    } catch {
      return false;
    }
  };
  const restoreTask = (entry: RegistryEntry, paneId: string | undefined): void => {
    backgroundTasks.set(entry.id, {
      dir: entry.dir,
      cwd: entry.cwd,
      agentType: entry.agentType,
      sessionName: entry.sessionName,
      runtime: entry.runtime,
      ...(entry.claudeSessionId !== undefined ? { claudeSessionId: entry.claudeSessionId } : {}),
      ...(restoredClaudeSessionFile(entry)
        ? { claudeSessionFile: restoredClaudeSessionFile(entry) }
        : {}),
      paneId,
      handle: entry.handle,
      backend: entry.handle?.backend ?? entry.backend ?? "tmux",
      originalPane: null,
      description: entry.description,
      startedAt: entry.startedAt,
      toolUses: 0,
      turns: 0,
      conversationId: entry.conversationId,
      ownerSessionId: entry.ownerSessionId,
      ownerLeafId: entry.ownerLeafId,
      maxTurns: entry.maxTurns,
      recentCalls: [],
      comparisonGroupId: entry.comparisonGroupId,
      comparisonModel: entry.comparisonModel,
      comparisonDescription: entry.comparisonDescription,
      comparisonIndex: entry.comparisonIndex,
      comparisonDelivered: entry.comparisonDelivered,
      comparisonPartialDelivered: entry.comparisonPartialDelivered,
    });
  };

  for (const entry of registry) {
    try {
      await restoreEntry(entry);
    } catch {
      // A failed durable write or unreadable session during restore must not
      // abort extension registration; retain the entry for a later attempt.
    }
  }

  if (staleIds.length) {
    updateRegistry(piDir, (entries) =>
      entries.filter((entry) => !staleIds.includes(entry.id)),
    );
  }

  async function restoreEntry(entry: RegistryEntry): Promise<void> {
    // Ownership gate (issue #20): a live task belongs to the session that
    // spawned it — another session's process must not adopt, steer, time
    // out, or deliver it. Only when the owning process is provably gone may
    // this process recover the task, and recovery never adopts: an orphaned
    // live pane is terminated because nobody is left to consume its result.
    const foreign =
      session !== undefined &&
      session.sessionId !== "" &&
      entry.ownerSessionId !== undefined &&
      entry.ownerSessionId !== session.sessionId;
    if (foreign && (entry.ownerPid === undefined || ownerAlive(entry.ownerPid))) {
      // The owner is running elsewhere (or unverifiable): leave the entry
      // untouched for that process.
      return;
    }
    // Past the gate, `foreign` means the owning process is provably gone —
    // an orphan this process may recover but never adopt.

    if (entry.cleanupPending) {
      try {
        if (closeResource) await closeResource(entry);
        else if (entry.handle?.backend !== "herdr" && (entry.handle?.resourceId ?? entry.paneId)) {
          await killAgentPaneStrictAsync(entry.handle?.resourceId ?? entry.paneId!, null);
        } else if (entry.handle?.backend === "herdr") {
          return;
        }
        // completion writes the cleanup receipt BEFORE the history upsert, so
        // a crash (or an unwritable history file) can leave a receipt without
        // a terminal record. Synthesize it here: comparison grouping needs
        // both siblings' history records, and a receipt-only task would
        // otherwise vanish from history when its registry entry is removed.
        const receiptSessionDirs = [join(entry.dir, "sessions", entry.id), entry.dir];
        const receiptCompletedAt =
          restoredClaudeCompletionAt(entry, entry.startedAt) ??
          receiptSessionDirs
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
          runtime: entry.runtime,
          ...(entry.claudeSessionId !== undefined
            ? { claudeSessionId: entry.claudeSessionId }
            : {}),
          startedAt: entry.startedAt,
          handle: entry.handle,
          paneId: entry.paneId,
          piDir: entry.piDir,
          dir: entry.dir,
          cwd: entry.cwd,
          conversationId: entry.conversationId,
          ownerSessionId: entry.ownerSessionId,
          ownerLeafId: entry.ownerLeafId,
          completedAt: receiptCompletedAt,
          comparisonGroupId: entry.comparisonGroupId,
          comparisonModel: entry.comparisonModel,
          comparisonDescription: entry.comparisonDescription,
          comparisonIndex: entry.comparisonIndex,
          // Forward the delivered marker only when the receipt truly has it:
          // upsert spread-merges, so an explicit undefined would clobber a
          // true marker recorded before the registry-removal write failed.
          ...(entry.comparisonDelivered === true
            ? { comparisonDelivered: true }
            : {}),
          ...(entry.comparisonPartialDelivered === true
            ? { comparisonPartialDelivered: true }
            : {}),
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
    const claudeFile = restoredClaudeSessionFile(entry);
    const sessionResult = claudeFile
      ? hasClaudeFinished(claudeFile, entry.startedAt)
        ? { status: "completed" as const }
        : null
      : sessionDirs
          .map((dir) =>
            getLastAssistantResultFromSessionDir(
              dir,
              entry.sessionName,
              entry.startedAt,
            ),
          )
          .find((result) => result !== null);
    const paneId = entry.handle?.resourceId ?? entry.paneId;
    let paneAlive: boolean;
    try {
      paneAlive = resourceExists
        ? await resourceExists(entry)
        : entry.handle?.backend === "herdr"
          ? false
          : await (async () => {
              if (!paneId) return false;
              const probe = await probePaneAsync(paneId);
              if (probe.state === "unavailable") throw probe.error;
              return probe.state === "alive";
            })();
    } catch {
      // A temporary backend outage must not destroy the durable task record.
      return;
    }

    if (
      sessionResult?.status === "completed" ||
      (sessionResult?.status === "failed" && !paneAlive)
    ) {
      // Faithful completion time from the session itself: restore can happen
      // long after the child finished, and recovered comparison reports would
      // otherwise inflate durations by the outage length.
      const completedAt =
        restoredClaudeCompletionAt(entry, entry.startedAt) ??
        sessionDirs
          .map((dir) =>
            getLastMessageTimestampFromSessionDir(dir, entry.sessionName, entry.startedAt),
          )
          .find((ts) => ts !== undefined) ?? Date.now();
      terminalReceipt(
        entry,
        sessionResult.status === "failed" ? "failed" : "done",
        completedAt,
      );
      if (await closeEntryResource(entry, paneId, paneAlive)) staleIds.push(entry.id);
      return;
    }

    // Comparison siblings whose session is still running must remain active;
    // a sibling already finished above is recovered from durable history and
    // fed into the coordinator during extension startup.
    if (entry.comparisonGroupId && entry.comparisonModel && !foreign) {
      restoreTask(entry, paneId);
      return;
    }

    if (!paneAlive) {
      if (!await closeEntryResource(entry, paneId, false)) return;
      terminalReceipt(entry, "failed", Date.now());
      staleIds.push(entry.id);
      return;
    }

    if (foreign) {
      // Owner gone, pane still alive, session unfinished: no consumer
      // remains, so terminate the child and record a terminal receipt.
      if (!await closeEntryResource(entry, paneId, true)) return;
      terminalReceipt(entry, "failed", Date.now());
      staleIds.push(entry.id);
      return;
    }

    restoreTask(entry, paneId);
  }
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is not signalable by this user.
    return error instanceof Error && (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
