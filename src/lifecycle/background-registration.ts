import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  updateRegistry,
  upsertTaskSessionHistory,
} from "../conversation.js";
import { ignoreStaleExtensionCtx } from "../stale-ctx.js";
import type { BackgroundTask, RegistryEntry } from "../types.js";

export interface BackgroundTaskRegistrationOptions {
  id: string;
  task: BackgroundTask;
  piDir: string;
  pi: ExtensionAPI;
  backgroundTasks: Map<string, BackgroundTask>;
  trackDelivery: () => void;
  ensureTaskWidget: () => void;
}

export function registerBackgroundTask({
  id,
  task,
  piDir,
  pi,
  backgroundTasks,
  trackDelivery,
  ensureTaskWidget,
}: BackgroundTaskRegistrationOptions): RegistryEntry {
  backgroundTasks.set(id, task);
  trackDelivery();

  const entry: RegistryEntry = {
    id,
    agentType: task.agentType,
    description: task.description,
    sessionName: task.sessionName,
    runtime: task.runtime,
    ...(task.claudeSessionId !== undefined
      ? { claudeSessionId: task.claudeSessionId }
      : {}),
    startedAt: task.startedAt,
    paneId: task.paneId,
    handle: task.handle,
    piDir,
    dir: task.dir,
    cwd: task.cwd,
    conversationId: task.conversationId,
    maxTurns: task.maxTurns,
    ownerSessionId: task.ownerSessionId,
    ownerLeafId: task.ownerLeafId,
    ownerPid: process.pid,
  };

  updateRegistry(piDir, (entries) => [...entries, entry]);
  upsertTaskSessionHistory(piDir, {
    ...entry,
    status: "running",
    background: true,
  });
  // This audit trail is best-effort because OpenPi can replace sessions while
  // an older pi-task closure is still unwinding. The JSON registry/history
  // above are the durable source of truth.
  ignoreStaleExtensionCtx(() => pi.appendEntry("task-registry", entry));
  ensureTaskWidget();
  return entry;
}
