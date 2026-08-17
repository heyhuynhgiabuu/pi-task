import type {
  BackgroundTask,
  ExecutionBackend,
  RegistryEntry,
  TaskSessionHistoryEntry,
} from "./types.js";

export type TaskLifecycleStatus =
  | "running"
  | "done"
  | "cancelled"
  | "aborted"
  | "failed"
  | "timeout";

export type TaskControlSource = "active" | "registry" | "history";

export interface TaskControlRequest {
  operation: "status" | "cancel";
  taskId: string;
}

export interface TaskStartRequest {
  agent_type: string;
  prompt: string;
  description: string;
  parent_context?: string;
  proposed_changes?: string[];
  workspace_group?: string;
  cwd?: string;
  task_id?: string;
  conversation_id?: string;
  background?: boolean;
}

export interface TaskControlRecord {
  id: string;
  agentType: string;
  description: string;
  sessionName: string;
  conversationId?: string;
  backend: ExecutionBackend;
  cwd?: string;
  dir: string;
  sessionRef?: string;
  startedAt: number;
  completedAt?: number;
  status: TaskLifecycleStatus;
  cleanupPending?: boolean;
  source: TaskControlSource;
}

export type CancellationDecision =
  | { kind: "allowed"; backend: "tmux" | "herdr" }
  | { kind: "unsupported"; reason: "sdk_backend" }
  | { kind: "terminal"; status: Exclude<TaskLifecycleStatus, "running"> };

const INVALID_TASK_CONTROL_REQUEST =
  "Invalid task control request: status/cancel require only operation and task_id; omit operation for start/resume.";

function inferBackend(
  backend: ExecutionBackend | undefined,
  handle: RegistryEntry["handle"] | BackgroundTask["handle"],
  paneId: string | undefined,
): ExecutionBackend {
  return backend ?? handle?.backend ?? (paneId ? "tmux" : "sdk");
}

export function fromBackgroundTask(id: string, task: BackgroundTask): TaskControlRecord {
  return {
    id,
    agentType: task.agentType,
    description: task.description,
    sessionName: task.sessionName,
    conversationId: task.conversationId,
    backend: inferBackend(task.backend, task.handle, task.paneId),
    cwd: task.cwd,
    dir: task.dir,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    status: task.status ?? "running",
    source: "active",
  };
}

export function fromRegistryEntry(entry: RegistryEntry): TaskControlRecord {
  return {
    id: entry.id,
    agentType: entry.agentType,
    description: entry.description,
    sessionName: entry.sessionName,
    conversationId: entry.conversationId,
    backend: inferBackend(entry.backend, entry.handle, entry.paneId),
    cwd: entry.cwd,
    dir: entry.dir,
    sessionRef: entry.sessionRef,
    startedAt: entry.startedAt,
    source: "registry",
    status: entry.cleanupPending ? entry.cleanupPhase ?? "failed" : "running",
    cleanupPending: entry.cleanupPending,
  };
}

export function fromHistoryEntry(entry: TaskSessionHistoryEntry): TaskControlRecord {
  return {
    id: entry.id,
    agentType: entry.agentType,
    description: entry.description,
    sessionName: entry.sessionName,
    conversationId: entry.conversationId,
    backend: inferBackend(entry.backend, entry.handle, entry.paneId),
    cwd: entry.cwd,
    dir: entry.dir,
    sessionRef: entry.sessionRef,
    startedAt: entry.startedAt,
    completedAt: entry.completedAt,
    source: "history",
    status: entry.status,
  };
}

function parsePromptHandoff(prompt: string): {
  parentContext?: string;
  proposedChanges?: string[];
} {
  const sections = new Map<string, string>();
  const sectionPattern = /(?:^|\n)(Parent context|Proposed changes):\s*([\s\S]*?)(?=\n(?:Parent context|Proposed changes|Scope|Non-goals|Write\/read policy|Acceptance criteria|Stop condition|Verification recipe|References):|$)/gi;
  for (const match of prompt.matchAll(sectionPattern)) {
    sections.set(match[1]!.toLowerCase(), match[2]!.trim());
  }

  const parentContext = sections.get("parent context") || undefined;
  const proposedSection = sections.get("proposed changes");
  const proposedChanges = proposedSection
    ? proposedSection
      .split(/\r?\n/)
      .map((line) => line.replace(/^[-*]\s+/, "").trim())
      .filter(Boolean)
    : undefined;
  return { parentContext, proposedChanges };
}

export function parseTaskStartRequest(value: unknown): TaskStartRequest | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    (candidate.operation !== undefined && candidate.operation !== "start") ||
    typeof candidate.agent_type !== "string" ||
    typeof candidate.prompt !== "string" ||
    typeof candidate.description !== "string"
  ) {
    return undefined;
  }
  const optionalStringFields = [
    "workspace_group",
    "cwd",
    "task_id",
    "conversation_id",
  ] as const;
  if (optionalStringFields.some((field) =>
    candidate[field] !== undefined && typeof candidate[field] !== "string"
  )) {
    return undefined;
  }
  if (candidate.background !== undefined && typeof candidate.background !== "boolean") {
    return undefined;
  }
  const parsedPromptHandoff = parsePromptHandoff(candidate.prompt);
  const suppliedParentContext = typeof candidate.parent_context === "string"
    ? candidate.parent_context.trim()
    : undefined;
  if (candidate.parent_context !== undefined && suppliedParentContext === undefined) {
    return undefined;
  }
  const suppliedProposedChanges = Array.isArray(candidate.proposed_changes)
    ? candidate.proposed_changes
      .filter((change): change is string => typeof change === "string")
      .map((change) => change.trim())
      .filter(Boolean)
    : undefined;
  if (
    candidate.proposed_changes !== undefined &&
    (!Array.isArray(candidate.proposed_changes) ||
      suppliedProposedChanges === undefined ||
      suppliedProposedChanges.length !== candidate.proposed_changes.length)
  ) {
    return undefined;
  }
  const parentContext = suppliedParentContext ?? parsedPromptHandoff.parentContext;
  const proposedChanges = suppliedProposedChanges ?? parsedPromptHandoff.proposedChanges;
  const isReviewer = candidate.agent_type === "reviewer";
  if (isReviewer && (!parentContext || !proposedChanges?.length)) {
    return undefined;
  }
  return {
    agent_type: candidate.agent_type,
    prompt: candidate.prompt,
    description: candidate.description,
    ...(parentContext !== undefined ? { parent_context: parentContext } : {}),
    ...(proposedChanges !== undefined ? { proposed_changes: proposedChanges } : {}),
    ...(typeof candidate.workspace_group === "string" ? { workspace_group: candidate.workspace_group } : {}),
    ...(typeof candidate.cwd === "string" ? { cwd: candidate.cwd } : {}),
    ...(typeof candidate.task_id === "string" ? { task_id: candidate.task_id } : {}),
    ...(typeof candidate.conversation_id === "string" ? { conversation_id: candidate.conversation_id } : {}),
    ...(typeof candidate.background === "boolean" ? { background: candidate.background } : {}),
  };
}

export function taskControlRequestError(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const operation = candidate.operation;
  if (operation !== "status" && operation !== "cancel") return undefined;

  const taskId = candidate.task_id;
  const hasNonControlFields = Object.keys(candidate).some(
    (field) => field !== "operation" && field !== "task_id",
  );
  if (typeof taskId !== "string" || taskId.trim().length === 0 || hasNonControlFields) {
    return INVALID_TASK_CONTROL_REQUEST;
  }
  return undefined;
}

export function parseTaskControlRequest(value: unknown): TaskControlRequest | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const operation = candidate.operation;
  if (operation !== "status" && operation !== "cancel") return undefined;
  // taskControlRequestError guarantees a non-empty string task id when it returns undefined.
  if (taskControlRequestError(value) !== undefined) return undefined;
  return { operation, taskId: (candidate.task_id as string).trim() };
}

function matches(record: TaskControlRecord, reference: string): boolean {
  return (
    record.id === reference ||
    record.sessionName === reference ||
    record.conversationId === reference
  );
}

export function findTaskRecord(
  reference: string,
  records: readonly TaskControlRecord[],
): TaskControlRecord | undefined {
  const normalized = reference.trim();
  if (!normalized) return undefined;

  return (
    records.find((record) => record.id === normalized) ??
    records.find((record) => matches(record, normalized))
  );
}

export function decideCancellation(record: TaskControlRecord): CancellationDecision {
  if (record.status !== "running") {
    return { kind: "terminal", status: record.status };
  }
  if (record.backend === "sdk") {
    return { kind: "unsupported", reason: "sdk_backend" };
  }
  return { kind: "allowed", backend: record.backend };
}
