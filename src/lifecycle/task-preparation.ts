import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { updateTaskSessionsRegistry } from "../conversation.js";
import {
  TASK_BACKGROUND_DEFAULT,
  type AgentConfig,
} from "../helpers.js";
import { resolveAgentSkillPaths } from "../subagent/skills.js";
import { isValidBackendPreference, resolveRequestedBackendKind } from "../subagent/selectBackend.js";
import { hasTmux } from "../subagent/tmux.js";
import type { TaskStartRequest } from "../task-control.js";
import { resolveTaskCwd } from "../task-cwd.js";
import { buildTaskPrompt } from "../tool/index.js";

export interface TaskPreparationResult {
  content: [{ type: "text"; text: string }];
  details: Record<string, unknown>;
  isError?: boolean;
}

export type TaskPreparationResolution =
  | {
      kind: "continue";
      taskCwd: string;
      skillPaths: string[];
      descText: string;
      isBackground: boolean;
      promptContent: string;
      sessionDir: string;
    }
  | { kind: "handled"; result: TaskPreparationResult };

export interface TaskPreparationOptions {
  taskParams: TaskStartRequest;
  agent: AgentConfig;
  ctx: ExtensionContext;
  artifactsDir: string;
  id: string;
  conversationId?: string;
  persistedTaskCwd?: string;
  /** `taskBackend` from pi settings, resolved by the caller before launch. */
  settingsBackend?: string;
}

export interface TaskMaterializationOptions {
  piDir: string;
  artifactsDir: string;
  id: string;
  sessionDir: string;
  conversationId?: string;
}

export async function prepareTaskExecution({
  taskParams,
  agent,
  ctx,
  artifactsDir,
  id,
  conversationId,
  persistedTaskCwd,
  settingsBackend,
}: TaskPreparationOptions): Promise<TaskPreparationResolution> {
  const taskCwdResolution = resolveTaskCwd(ctx.cwd, taskParams.cwd, persistedTaskCwd);
  if (taskCwdResolution.kind === "invalid") {
    return {
      kind: "handled",
      result: {
        content: [{ type: "text", text: taskCwdResolution.message }],
        details: { phase: "failed", error: "invalid cwd" },
        isError: true,
      },
    };
  }
  const taskCwd = taskCwdResolution.cwd;
  let skillPaths: string[];
  try {
    skillPaths = await resolveAgentSkillPaths(
      agent.skills,
      taskCwd,
      ctx.isProjectTrusted(),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: "handled",
      result: {
        content: [{ type: "text", text: message }],
        details: { phase: "failed", error: "agent skills unavailable" },
        isError: true,
      },
    };
  }

  // Keep the legacy durable-conversation error precedence while leaving the
  // actual backend capability check to the side-effect-free caller preflight.
  const gate = evaluateDurableConversationGate({
    conversationId,
    settingsBackend,
    tmuxAvailable: hasTmux(),
    herdrContextAvailable: process.env.HERDR_ENV === "1"
      && Boolean(process.env.HERDR_PANE_ID)
      && Boolean(process.env.HERDR_SOCKET_PATH),
  });
  if (gate.kind === "rejected") {
    return { kind: "handled", result: gate.result };
  }

  const descText = taskParams.description || "";
  const isBackground = taskParams.background ?? TASK_BACKGROUND_DEFAULT;
  const promptContent = buildTaskPrompt({
    description: descText,
    agentName: agent.name,
    agentSource: agent.source,
    prompt: taskParams.prompt,
    parentContext: taskParams.parent_context,
    proposedChanges: taskParams.proposed_changes,
    cwd: taskCwd,
  });

  const sessionDir = join(artifactsDir, "sessions", id);

  return {
    kind: "continue",
    taskCwd,
    skillPaths,
    descText,
    isBackground,
    promptContent,
    sessionDir,
  };
}

export type DurableConversationGateResolution =
  | { kind: "allowed" }
  | { kind: "rejected"; result: TaskPreparationResult };

/**
 * The shared durable-conversation rejection. The early launch gate and the
 * post-resolution SDK backstop in index.ts must stay one message, so both go
 * through here; `details.error` is a stable failure identifier.
 */
export function durableConversationRejection(conversationId: string): TaskPreparationResult {
  return {
    content: [
      {
        type: "text",
        text:
          "Durable conversations need a backend that can reopen the child session: start Pi inside HerdR or tmux, select the durable backend with PI_TASK_BACKEND=durable (or the taskBackend setting), or omit conversation_id for a one-shot SDK task.",
      },
    ],
    details: {
      phase: "failed",
      error: "tmux required for durable conversation",
      conversation_id: conversationId,
    },
    isError: true,
  };
}

/**
 * Whether `conversation_id` can resume on the backend the launch would select.
 * Durable keeps its conversation registry in SQLite and needs no terminal;
 * terminal conversations need an active HerdR context or tmux server; SDK
 * runs are one-shot and cannot reopen a session. The preference resolution
 * mirrors `resolveTaskBackend` via `resolveRequestedBackendKind`, and an
 * invalid preference is allowed through so the resolver's precise error wins.
 */
export function evaluateDurableConversationGate(input: {
  conversationId?: string;
  settingsBackend?: string;
  tmuxAvailable: boolean;
  herdrContextAvailable: boolean;
}): DurableConversationGateResolution {
  if (!input.conversationId) return { kind: "allowed" };
  const preference = resolveRequestedBackendKind({ settingsBackend: input.settingsBackend });
  if (!isValidBackendPreference(preference)) return { kind: "allowed" };
  const terminalAvailable = input.tmuxAvailable || input.herdrContextAvailable;
  const conversationsSupported = preference === "durable" || (preference !== "sdk" && terminalAvailable);
  if (conversationsSupported) return { kind: "allowed" };
  return { kind: "rejected", result: durableConversationRejection(input.conversationId) };
}

/** Materialize durable task artifacts only after side-effect-free preflight passes. */
export async function materializeTaskExecution({
  piDir,
  artifactsDir,
  id,
  sessionDir,
  conversationId,
}: TaskMaterializationOptions): Promise<void> {
  if (conversationId) {
    await mkdir(artifactsDir, { recursive: true });
    updateTaskSessionsRegistry(piDir, (registry) => ({
      ...registry,
      [conversationId]: {
        task_id: id,
        updated_at: new Date().toISOString(),
      },
    }));
  }
  await mkdir(sessionDir, { recursive: true });
}
