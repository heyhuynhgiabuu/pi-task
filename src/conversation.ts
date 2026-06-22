import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Conversational subagent helpers.
 *
 * Durable subagent conversations reuse the existing
 * `.pi/artifacts/task-<id>/` artifact convention and add a small
 * `conversation_id` -> `task-<id>` registry under the same artifacts dir.
 */

export interface ConversationMetadata {
  conversation_id: string;
  task_id: string;
  artifact: string;
  agent_type: string;
  session_dir: string;
  session_name: string;
  created_at: string;
  last_used_at: string;
  last_prompt?: string;
}

export type ConversationRegistry = Record<string, string>;

export const CONVERSATION_REGISTRY_FILE = "task-conversations.json";

export function getArtifactsDir(piDir: string): string {
  return join(piDir, "artifacts");
}

export function getConversationRegistryPath(piDir: string): string {
  return join(getArtifactsDir(piDir), CONVERSATION_REGISTRY_FILE);
}

export function taskArtifactName(taskId: string): string {
  return taskId.startsWith("task-") ? taskId : `task-${taskId}`;
}

export function taskIdFromArtifactName(artifactName: string): string {
  return artifactName.startsWith("task-")
    ? artifactName.slice("task-".length)
    : artifactName;
}

export function normalizeConversationId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const conversationId = value.trim();
  if (!conversationId) return undefined;
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(conversationId)) {
    throw new Error(
      "conversation_id must be 1-80 chars and contain only letters, numbers, '.', '_' or '-'",
    );
  }
  return conversationId;
}

export function readConversationRegistry(piDir: string): ConversationRegistry {
  try {
    const parsed = JSON.parse(
      readFileSync(getConversationRegistryPath(piDir), "utf-8"),
    ) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const registry: ConversationRegistry = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") registry[key] = value;
    }
    return registry;
  } catch {
    return {};
  }
}

export function writeConversationRegistry(
  piDir: string,
  registry: ConversationRegistry,
): void {
  const artifactsDir = getArtifactsDir(piDir);
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(
    getConversationRegistryPath(piDir),
    `${JSON.stringify(registry, null, 2)}\n`,
    "utf-8",
  );
}

export function readConversationMetadata(
  metadataPath: string,
): ConversationMetadata | undefined {
  try {
    const parsed = JSON.parse(
      readFileSync(metadataPath, "utf-8"),
    ) as Partial<ConversationMetadata>;
    if (!parsed.conversation_id || !parsed.task_id) return undefined;
    return parsed as ConversationMetadata;
  } catch {
    return undefined;
  }
}

export function buildSessionCard(metadata: ConversationMetadata): string {
  return [
    `# ${metadata.conversation_id}`,
    "",
    `Agent: ${metadata.agent_type}`,
    `Task: ${taskArtifactName(metadata.task_id)}`,
    `Last used: ${metadata.last_used_at}`,
    `Session dir: ${metadata.session_dir}`,
    "",
    "## Resume",
    "",
    "```json",
    JSON.stringify(
      {
        agent_type: metadata.agent_type,
        conversation_id: metadata.conversation_id,
        prompt: "Continue from the prior specialist conversation.",
      },
      null,
      2,
    ),
    "```",
    "",
    "## Last prompt",
    "",
    metadata.last_prompt ?? "",
    "",
  ].join("\n");
}

export function writeConversationArtifacts(options: {
  taskDir: string;
  taskId: string;
  conversationId: string;
  agentType: string;
  sessionDir: string;
  sessionName: string;
  prompt: string;
}): ConversationMetadata {
  const now = new Date().toISOString();
  const metadataPath = join(options.taskDir, "metadata.json");
  const existing = readConversationMetadata(metadataPath);
  const metadata: ConversationMetadata = {
    conversation_id: options.conversationId,
    task_id: options.taskId,
    artifact: taskArtifactName(options.taskId),
    agent_type: options.agentType,
    session_dir: options.sessionDir,
    session_name: options.sessionName,
    created_at: existing?.created_at ?? now,
    last_used_at: now,
    last_prompt: options.prompt,
  };
  mkdirSync(options.taskDir, { recursive: true });
  writeFileSync(
    metadataPath,
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf-8",
  );
  writeFileSync(
    join(options.taskDir, "SESSION.md"),
    buildSessionCard(metadata),
    "utf-8",
  );
  return metadata;
}

export function renderConversationSessions(piDir: string): string {
  const registry = readConversationRegistry(piDir);
  const entries = Object.entries(registry).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (entries.length === 0) {
    return 'No durable task conversations found. Start one with task({ conversation_id: "research-ai", ... }).';
  }
  const lines = ["Durable task conversations:"];
  for (const [conversationId, artifactName] of entries) {
    const taskId = taskIdFromArtifactName(artifactName);
    const metadata = readConversationMetadata(
      join(getArtifactsDir(piDir), taskArtifactName(taskId), "metadata.json"),
    );
    const suffix = metadata
      ? ` — ${metadata.agent_type}, last used ${metadata.last_used_at}`
      : "";
    lines.push(`${conversationId} -> ${taskArtifactName(taskId)}${suffix}`);
  }
  return lines.join("\n");
}
