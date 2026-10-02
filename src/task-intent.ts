import { createHash } from "node:crypto";

/**
 * Replay safety for fresh task starts (pi-durable's subagent lesson:
 * find-before-create keyed by the owner). A fresh start is identified by its
 * intent — agent, prompt, cwd, and mode — and a re-invocation of the same
 * delegation is answered with the live task instead of spawning a twin.
 *
 * Only survivors can be twins: terminal/herdr background tasks outlive the
 * parent process, while SDK and foreground runs die with it, so the hash is
 * recorded on registry entries only.
 */
export interface TaskStartIntentParams {
  agent_type: string;
  description: string;
  prompt: string;
  thinking?: string;
  cwd?: string;
  background?: boolean;
  workspace_group?: string;
  compare?: boolean;
  task_id?: string;
  conversation_id?: string;
}

/**
 * The intent hash of a fresh start, or undefined for starts that must never
 * be deduplicated: resumes (task_id/conversation_id already identify the
 * task) and comparisons (two models deliberately share one prompt).
 */
export function startIntentHash(input: {
  agentName: string;
  params: TaskStartIntentParams;
  ctxCwd: string;
  claudeRuntime: boolean;
}): string | undefined {
  const { params } = input;
  if (params.compare || params.task_id || params.conversation_id) return undefined;
  const canonical = JSON.stringify([
    input.agentName,
    params.description,
    params.prompt,
    params.cwd ?? input.ctxCwd,
    params.background === true,
    params.thinking ?? null,
    params.workspace_group ?? null,
    input.claudeRuntime ? "claude" : "pi",
  ]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}
