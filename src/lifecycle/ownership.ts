import {
  findTaskSessionHistory,
  updateRegistry,
  upsertTaskSessionHistory,
} from "../conversation.js";
import type { DeliveryGuard, SessionView } from "../panel/delivery.js";
import type { BackgroundTask, RegistryEntry } from "../types.js";

/** Return the durable parent context for a task spawned from a Pi session. */
export function durableParentOf(
  session: SessionView,
): Pick<BackgroundTask, "ownerSessionId" | "ownerLeafId"> {
  const ownerSessionId = session.getSessionId();
  return {
    ownerSessionId: ownerSessionId || undefined,
    ownerLeafId: ownerSessionId ? session.getLeafId() : undefined,
  };
}

/** Restore delivery ownership for tasks already adopted from the registry. */
export function restoreBackgroundTaskDeliveryGuards(
  backgroundTasks: ReadonlyMap<
    string,
    Pick<BackgroundTask, "ownerSessionId" | "ownerLeafId">
  >,
  sessionId: string,
  deliveryGuard: DeliveryGuard,
): void {
  if (!sessionId) return;
  for (const [id, task] of backgroundTasks) {
    if (task.ownerSessionId === undefined) continue;
    deliveryGuard.restore(id, {
      sessionId: task.ownerSessionId,
      leafId: task.ownerLeafId ?? null,
    });
  }
}

/** Transfer durable lifecycle ownership to the session resuming a task. */
export function transferTaskOwnership(
  piDir: string,
  registryEntry: RegistryEntry | undefined,
  session: SessionView,
): void {
  if (!registryEntry) return;
  const sessionId = session.getSessionId();
  // Without a session id ownership cannot be expressed; leave the entry as
  // recorded rather than stripping it.
  if (!sessionId) return;
  const parent = durableParentOf(session);
  if (
    registryEntry.ownerSessionId === sessionId &&
    registryEntry.ownerLeafId === parent.ownerLeafId &&
    registryEntry.ownerPid === process.pid
  ) {
    return;
  }
  updateRegistry(piDir, (entries) => {
    const idx = entries.findIndex((e) => e.id === registryEntry.id);
    if (idx === -1) return entries;
    entries[idx] = {
      ...registryEntry,
      ...parent,
      ownerPid: process.pid,
    };
    return entries;
  });
  const history = findTaskSessionHistory(piDir, registryEntry.id);
  if (history) {
    upsertTaskSessionHistory(piDir, {
      ...history,
      ...parent,
      ownerPid: process.pid,
    });
  }
}
