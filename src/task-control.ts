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
  fast?: boolean;
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

interface TaskStartValidation {
  request?: TaskStartRequest;
  problems: string[];
}

function validateTaskStartRequest(value: unknown): TaskStartValidation {
  if (!value || typeof value !== "object") {
    return { problems: ["request payload must be a JSON object"] };
  }
  const candidate = value as Record<string, unknown>;
  const problems: string[] = [];

  const operation = candidate.operation;
  if (operation !== undefined && operation !== "start" && operation !== "resume") {
    problems.push(
      `operation must be "start" or "resume" (or omitted); received ${JSON.stringify(operation)}`,
    );
  }
  for (const field of ["agent_type", "prompt", "description"] as const) {
    if (typeof candidate[field] !== "string") problems.push(`${field} must be a string`);
  }
  for (
    const field of ["workspace_group", "cwd", "task_id", "conversation_id"] as const
  ) {
    if (candidate[field] !== undefined && typeof candidate[field] !== "string") {
      problems.push(`${field} must be a string`);
    }
  }
  if (candidate.fast !== undefined && typeof candidate.fast !== "boolean") {
    problems.push("fast must be a boolean");
  }
  if (candidate.background !== undefined && typeof candidate.background !== "boolean") {
    problems.push("background must be a boolean");
  }
  if (problems.length > 0) return { problems };

  const parsedPromptHandoff = parsePromptHandoff(candidate.prompt as string);
  const suppliedParentContext = typeof candidate.parent_context === "string"
    ? candidate.parent_context.trim()
    : undefined;
  if (candidate.parent_context !== undefined) {
    if (typeof candidate.parent_context !== "string") {
      problems.push("parent_context must be a string");
    } else if (suppliedParentContext === "") {
      problems.push("parent_context was provided but is empty after trimming");
    }
  }
  let suppliedProposedChanges: string[] | undefined;
  if (candidate.proposed_changes !== undefined) {
    if (!Array.isArray(candidate.proposed_changes)) {
      problems.push("proposed_changes must be an array of strings");
    } else {
      const items = candidate.proposed_changes
        .filter((change): change is string => typeof change === "string")
        .map((change) => change.trim())
        .filter(Boolean);
      if (items.length !== candidate.proposed_changes.length) {
        const hasNonString = candidate.proposed_changes.some((change) => typeof change !== "string");
        problems.push(
          hasNonString
            ? "proposed_changes must contain only strings"
            : "proposed_changes contains blank items; each entry must be a non-empty string",
        );
      }
      suppliedProposedChanges = items;
    }
  }
  if (problems.length > 0) return { problems };

  const parentContext = suppliedParentContext ?? parsedPromptHandoff.parentContext;
  const proposedChanges = suppliedProposedChanges ?? parsedPromptHandoff.proposedChanges;
  if (candidate.agent_type === "reviewer") {
    const missing: string[] = [];
    if (!parentContext) missing.push("parent_context");
    if (!proposedChanges?.length) missing.push("proposed_changes");
    if (missing.length === 2) {
      problems.push(
        'reviewer tasks require parent_context and proposed_changes; pass them explicitly or include "Parent context:" and "Proposed changes:" sections in prompt',
      );
    } else if (missing.length === 1) {
      const field = missing[0]!;
      const header = field === "parent_context" ? "Parent context:" : "Proposed changes:";
      problems.push(
        `reviewer tasks require ${field}; pass it explicitly or include "${header}" section in prompt`,
      );
    }
  }
  if (problems.length > 0) return { problems };

  return {
    problems,
    request: {
      agent_type: candidate.agent_type as string,
      prompt: candidate.prompt as string,
      description: candidate.description as string,
      ...(parentContext !== undefined ? { parent_context: parentContext } : {}),
      ...(proposedChanges !== undefined ? { proposed_changes: proposedChanges } : {}),
      ...(typeof candidate.workspace_group === "string" ? { workspace_group: candidate.workspace_group } : {}),
      ...(typeof candidate.cwd === "string" ? { cwd: candidate.cwd } : {}),
      ...(typeof candidate.task_id === "string" ? { task_id: candidate.task_id } : {}),
      ...(typeof candidate.conversation_id === "string" ? { conversation_id: candidate.conversation_id } : {}),
      ...(typeof candidate.fast === "boolean" ? { fast: candidate.fast } : {}),
      ...(typeof candidate.background === "boolean" ? { background: candidate.background } : {}),
    },
  };
}

export function parseTaskStartRequest(value: unknown): TaskStartRequest | undefined {
  return validateTaskStartRequest(value).request;
}

/** Returns a targeted, model-actionable reason when a start/resume request would be rejected. */
export function taskStartRequestError(value: unknown): string | undefined {
  const { problems } = validateTaskStartRequest(value);
  return problems.length > 0 ? problems.join("; ") : undefined;
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
