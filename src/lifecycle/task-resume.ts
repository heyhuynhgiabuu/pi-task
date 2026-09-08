import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  findJsonlSessionByName,
  findTaskSessionHistory,
  readRegistry,
  repairTaskSessionRef,
} from "../conversation.js";
import { buildTaskFollowUpPrompt } from "../tool/index.js";
import type { TaskStartRequest } from "../task-control.js";
import type { BackgroundTask, RegistryEntry } from "../types.js";
import { sessionViewOf } from "../panel/delivery.js";
import type { DeliveryGuard } from "../panel/delivery.js";
import { durableParentOf, transferTaskOwnership } from "./ownership.js";
import { steerRunningBackgroundTask } from "../subagent/steer.js";

export interface TaskResumeResult {
  content: [{ type: "text"; text: string }];
  details: Record<string, unknown>;
  isError?: boolean;
}

export type TaskResumeResolution =
  | {
      kind: "continue";
      taskParams: TaskStartRequest;
      id: string;
      sessionName: string;
      resume: boolean;
      resumeSessionRef?: string;
      persistedTaskCwd?: string;
    }
  | { kind: "handled"; result: TaskResumeResult };

export interface TaskResumeOptions {
  requestedTaskId: string;
  taskParams: TaskStartRequest;
  agentName: string;
  piDir: string;
  artifactsDir: string;
  conversationId?: string;
  extensionPiDir: string;
  ctx: ExtensionContext;
  backgroundTasks: Map<string, BackgroundTask>;
  deliveryGuard: DeliveryGuard;
  registryEntryStatus: (entry: RegistryEntry) => "alive" | "missing" | "unavailable";
}

export function resolveTaskResume({
  requestedTaskId,
  taskParams,
  agentName,
  piDir,
  artifactsDir,
  conversationId,
  extensionPiDir,
  ctx,
  backgroundTasks,
  deliveryGuard,
  registryEntryStatus,
}: TaskResumeOptions): TaskResumeResolution {
  const entries = readRegistry(piDir);
  const registryEntry = entries.find(
    (entry) => entry.id === requestedTaskId || entry.sessionName === requestedTaskId,
  );
  let entry =
    registryEntry ??
    findTaskSessionHistory(piDir, requestedTaskId) ??
    findJsonlSessionByName(piDir, requestedTaskId, agentName);

  // Older history entries can lack the JSONL path needed by `pi --session`, or
  // hold a stale one. Repair it (and the durable record) before the spawn
  // reuses it.
  if (entry) entry = repairTaskSessionRef(piDir, entry);
  if (entry?.comparisonGroupId) {
    return {
      kind: "handled",
      result: {
        content: [{ type: "text", text: "Comparison tasks cannot be resumed individually." }],
        details: {
          phase: "failed",
          error: "resume_unsupported_for_compare",
          task_id: entry.id,
        },
        isError: true,
      },
    };
  }
  if (!entry) {
    const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`;
    return {
      kind: "continue",
      taskParams: { ...taskParams, task_id: undefined },
      id,
      sessionName: conversationId ?? `task-${id}`,
      resume: false,
    };
  }

  const persistedTaskCwd = entry.cwd;
  if (entry.cleanupPending) {
    return {
      kind: "handled",
      result: {
        content: [{ type: "text", text: `Task "${requestedTaskId}" is cancelled but backend cleanup is still pending; retry after the resource is cleaned up.` }],
        details: { phase: "failed", error: "cleanup_pending", task_id: entry.id },
        isError: true,
      },
    };
  }
  // repairTaskSessionRef ran above: a present sessionRef implies the file exists
  // (valid refs are kept, stale ones re-discovered). A stale recorded dir must
  // not block resume when the transcript is discoverable — the spawn writes
  // runtime files under the current artifacts root and heals the record.
  if (!existsSync(entry.dir) && !entry.sessionRef) {
    return {
      kind: "handled",
      result: {
        content: [
          {
            type: "text",
            text: `Task "${requestedTaskId}" artifact directory no longer exists: ${entry.dir}`,
          },
        ],
        details: {
          phase: "failed",
          error: "Task artifact dir missing",
        },
        isError: true,
      },
    };
  }

  const id = entry.id;
  const sessionName = entry.sessionName;
  const resumeSessionRef = entry.sessionRef;
  const entryStatus = registryEntryStatus(entry);
  if (entryStatus === "unavailable") {
    return {
      kind: "handled",
      result: {
        content: [{ type: "text", text: "The HerdR session for this task is temporarily unavailable. The durable task record was preserved; retry when HerdR reconnects." }],
        details: { phase: "failed", error: "HerdR temporarily unavailable" },
        isError: true,
      },
    };
  }
  if (entryStatus === "alive") {
    if (taskParams.background === false) {
      return {
        kind: "handled",
        result: {
          content: [{ type: "text", text: `Task "${requestedTaskId}" is already running in the background and cannot be relaunched as foreground.` }],
          details: { phase: "failed", error: "active task cannot run foreground", task_id: id },
          isError: true,
        },
      };
    }
    const bgtask: BackgroundTask = {
      dir: artifactsDir,
      cwd: entry.cwd,
      agentType: entry.agentType,
      sessionName,
      paneId: entry.handle?.resourceId ?? entry.paneId,
      handle: entry.handle,
      backend: entry.handle?.backend ?? "tmux",
      originalPane: null,
      description: taskParams.description || entry.description,
      startedAt: entry.startedAt,
      toolUses: 0,
      turns: 0,
      maxTurns: entry.maxTurns,
      conversationId: entry.conversationId,
      ...durableParentOf(sessionViewOf(ctx)),
      recentCalls: [],
    };
    backgroundTasks.set(id, bgtask);
    deliveryGuard.track(id, sessionViewOf(ctx));
    transferTaskOwnership(extensionPiDir, registryEntry, sessionViewOf(ctx));
    const steerResult = steerRunningBackgroundTask(
      bgtask.paneId,
      buildTaskFollowUpPrompt({
        prompt: taskParams.prompt,
        parentContext: taskParams.parent_context,
        proposedChanges: taskParams.proposed_changes,
      }),
      bgtask.handle,
    );
    if (!steerResult.ok) {
      return {
        kind: "handled",
        result: {
          content: [{ type: "text", text: `Task "${requestedTaskId}" was restored, but the follow-up prompt could not be delivered (${steerResult.reason}).` }],
          details: { phase: "failed", error: `resume steering failed: ${steerResult.reason}` },
          isError: true,
        },
      };
    }

    return {
      kind: "handled",
      result: {
        content: [
          {
            type: "text",
            text: `Resumed task "${requestedTaskId}" and delivered the follow-up prompt. The subagent is still running in background; avoid relaunching overlapping work. Use /task-sessions to inspect it, and it will notify on completion.`,
          },
        ],
        details: {
          task_id: id,
          agent_type: entry.agentType,
          description: taskParams.description || entry.description,
          conversation_id: entry.conversationId ?? conversationId,
          tmux_session: sessionName,
          background: true,
        },
      },
    };
  }

  if (!resumeSessionRef) {
    return {
      kind: "handled",
      result: {
        content: [
          {
            type: "text",
            text: `Task "${requestedTaskId}" was found, but its session JSONL file could not be resolved. Cannot resume without a --session file path.`,
          },
        ],
        details: {
          phase: "failed",
          error: "Task session file missing",
        },
        isError: true,
      },
    };
  }

  return {
    kind: "continue",
    taskParams,
    id,
    sessionName,
    resume: true,
    resumeSessionRef,
    persistedTaskCwd,
  };
}
