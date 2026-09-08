import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { updateTaskSessionsRegistry } from "../conversation.js";
import {
  TASK_BACKGROUND_DEFAULT,
  type AgentConfig,
} from "../helpers.js";
import { resolveAgentSkillPaths } from "../subagent/skills.js";
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
  piDir: string;
  artifactsDir: string;
  id: string;
  conversationId?: string;
  persistedTaskCwd?: string;
}

export async function prepareTaskExecution({
  taskParams,
  agent,
  ctx,
  piDir,
  artifactsDir,
  id,
  conversationId,
  persistedTaskCwd,
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

  const durableBackendPreference = (process.env.PI_TASK_BACKEND ?? "auto").trim().toLowerCase();
  const herdrContextAvailable = process.env.HERDR_ENV === "1"
    && Boolean(process.env.HERDR_PANE_ID)
    && Boolean(process.env.HERDR_SOCKET_PATH);
  if (conversationId && (durableBackendPreference === "sdk" || (!hasTmux() && !herdrContextAvailable))) {
    return {
      kind: "handled",
      result: {
        content: [
          {
            type: "text",
            text: "Durable conversations require an active HerdR or tmux terminal backend so Pi can save and reopen the subagent session. Start Pi inside HerdR, start tmux, or omit conversation_id for a one-shot SDK task.",
          },
        ],
        details: {
          phase: "failed",
          error: "tmux required for durable conversation",
          conversation_id: conversationId,
        },
        isError: true,
      },
    };
  }

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
  await mkdir(sessionDir, { recursive: true });

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
