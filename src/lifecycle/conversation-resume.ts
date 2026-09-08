import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
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

export interface ConversationResumeResult {
  content: [{ type: "text"; text: string }];
  details: Record<string, unknown>;
  isError?: boolean;
}

export type ConversationResumeResolution =
  | { kind: "continue"; id: string; sessionName: string; resumeSessionRef?: string; persistedTaskCwd?: string }
  | { kind: "handled"; result: ConversationResumeResult };

export interface ConversationResumeOptions {
  conversationId: string;
  registeredTaskId: string;
  taskParams: TaskStartRequest;
  agentName: string;
  piDir: string;
  artifactsDir: string;
  extensionPiDir: string;
  ctx: ExtensionContext;
  backgroundTasks: Map<string, BackgroundTask>;
  deliveryGuard: DeliveryGuard;
  registryEntryStatus: (entry: RegistryEntry) => "alive" | "missing" | "unavailable";
}

export function resolveConversationResume({
  conversationId,
  registeredTaskId,
  taskParams,
  agentName,
  piDir,
  artifactsDir,
  extensionPiDir,
  ctx,
  backgroundTasks,
  deliveryGuard,
  registryEntryStatus,
}: ConversationResumeOptions): ConversationResumeResolution {
  const id = registeredTaskId;
  const sessionName = conversationId;
  const previous = findTaskSessionHistory(piDir, id);
  const repairedPrevious = previous
    ? repairTaskSessionRef(piDir, previous)
    : undefined;
  let persistedTaskCwd = repairedPrevious?.cwd ?? previous?.cwd;
  const resumeSessionRef = repairedPrevious?.sessionRef;
  const metadataAgent = previous?.agentType;
  if (metadataAgent && metadataAgent !== agentName) {
    return {
      kind: "handled",
      result: {
        content: [
          {
            type: "text",
            text: `conversation_id "${conversationId}" belongs to agent "${metadataAgent}", not "${agentName}". Use the original agent_type or start a different conversation_id.`,
          },
        ],
        details: {
          phase: "failed",
          error: "conversation_id agent_type mismatch",
          conversation_id: conversationId,
        },
        isError: true,
      },
    };
  }

  const entry = readRegistry(piDir).find((candidate) => candidate.id === id);
  if (entry?.comparisonGroupId || repairedPrevious?.comparisonGroupId) {
    return {
      kind: "handled",
      result: {
        content: [{ type: "text", text: "Comparison tasks cannot be resumed individually." }],
        details: {
          phase: "failed",
          error: "resume_unsupported_for_compare",
          task_id: id,
        },
        isError: true,
      },
    };
  }
  persistedTaskCwd = entry?.cwd ?? persistedTaskCwd;
  if (entry?.cleanupPending) {
    return {
      kind: "handled",
      result: {
        content: [{ type: "text", text: `Conversation "${conversationId}" is cancelled but backend cleanup is still pending; retry after the resource is cleaned up.` }],
        details: { phase: "failed", error: "cleanup_pending", task_id: id },
        isError: true,
      },
    };
  }
  const entryStatus = entry ? registryEntryStatus(entry) : "missing";
  if (entryStatus === "unavailable") {
    return {
      kind: "handled",
      result: {
        content: [{ type: "text", text: "The HerdR session for this conversation is temporarily unavailable. The durable task record was preserved; retry when HerdR reconnects." }],
        details: { phase: "failed", error: "HerdR temporarily unavailable" },
        isError: true,
      },
    };
  }
  if (entry && entryStatus === "alive") {
    if (taskParams.background === false) {
      return {
        kind: "handled",
        result: {
          content: [{ type: "text", text: `Conversation "${conversationId}" is already running in the background and cannot be relaunched as foreground.` }],
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
      conversationId,
      ...durableParentOf(sessionViewOf(ctx)),
      recentCalls: [],
    };
    backgroundTasks.set(id, bgtask);
    deliveryGuard.track(id, sessionViewOf(ctx));
    transferTaskOwnership(extensionPiDir, entry, sessionViewOf(ctx));
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
          content: [{ type: "text", text: `Conversation "${conversationId}" was restored, but the follow-up prompt could not be delivered (${steerResult.reason}).` }],
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
            text: `Resumed conversation "${conversationId}" via ${sessionName} and delivered the follow-up prompt. The subagent is running in background and will notify on completion.`,
          },
        ],
        details: {
          task_id: id,
          agent_type: agentName,
          description: taskParams.description,
          conversation_id: conversationId,
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
            text: `Conversation "${conversationId}" was found, but its session JSONL file could not be resolved. Cannot resume without a --session file path.`,
          },
        ],
        details: {
          phase: "failed",
          error: "Conversation session file missing",
          conversation_id: conversationId,
        },
        isError: true,
      },
    };
  }

  return {
    kind: "continue",
    id,
    sessionName,
    resumeSessionRef,
    persistedTaskCwd,
  };
}
