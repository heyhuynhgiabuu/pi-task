import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  readRegistry,
  readTaskSessionHistory,
} from "./conversation.js";
import {
  completeTask as persistCompletedTask,
  type ComparisonSettledHook,
} from "./lifecycle/completion.js";
import {
  decideCancellation,
  findTaskRecord,
  fromBackgroundTask,
  fromHistoryEntry,
  fromRegistryEntry,
  type TaskControlRecord,
  type TaskControlRequest,
} from "./task-control.js";
import type { BackgroundTask, RegistryEntry } from "./types.js";

export type TaskResourceStatus = "alive" | "missing" | "unavailable";

export interface TaskControlToolResult {
  content: [{ type: "text"; text: string }];
  details: Record<string, unknown>;
  isError?: boolean;
}

export interface TaskControlDependencies {
  pi: ExtensionAPI;
  piDir: string;
  backgroundTasks: Map<string, BackgroundTask>;
  registryEntryStatus(entry: RegistryEntry): TaskResourceStatus;
  clearTaskWidgetIfIdle(): void;
  completeTask?: typeof persistCompletedTask;
  onComparisonSettled?: ComparisonSettledHook;
  /** Keep the cancelled task's row visible in the panel for its linger. */
  noteTaskFinished?: (id: string, task: BackgroundTask) => void;
}

function taskControlRecords(deps: TaskControlDependencies): TaskControlRecord[] {
  return [
    ...[...deps.backgroundTasks.entries()].map(([id, task]) => fromBackgroundTask(id, task)),
    ...readRegistry(deps.piDir).map(fromRegistryEntry),
    ...readTaskSessionHistory(deps.piDir).map(fromHistoryEntry),
  ];
}

function taskControlText(record: TaskControlRecord): string {
  return [
    `Task ${record.id}: ${record.status}`,
    `agent: ${record.agentType}`,
    `backend: ${record.backend}`,
    `session: ${record.sessionName}`,
    ...(record.conversationId ? [`conversation: ${record.conversationId}`] : []),
    ...(record.cwd ? [`cwd: ${record.cwd}`] : []),
    ...(record.cleanupPending ? ["cleanup: pending"] : []),
  ].join("\n");
}

function backgroundTaskFromRegistry(entry: RegistryEntry): BackgroundTask {
  return {
    dir: entry.dir,
    cwd: entry.cwd,
    agentType: entry.agentType,
    sessionName: entry.sessionName,
    paneId: entry.handle?.backend === "tmux" ? entry.handle.resourceId : entry.paneId,
    handle: entry.handle,
    backend: entry.handle?.backend ?? entry.backend ?? (entry.paneId ? "tmux" : "sdk"),
    originalPane: null,
    description: entry.description,
    startedAt: entry.startedAt,
    toolUses: 0,
    turns: 0,
    conversationId: entry.conversationId,
    recentCalls: [],
    comparisonGroupId: entry.comparisonGroupId,
    comparisonModel: entry.comparisonModel,
    comparisonDescription: entry.comparisonDescription,
    comparisonIndex: entry.comparisonIndex,
  };
}

function errorResult(
  request: TaskControlRequest,
  text: string,
  error: string,
  extra: Record<string, unknown> = {},
): TaskControlToolResult {
  return {
    content: [{ type: "text", text }],
    details: {
      operation: request.operation,
      task_id: request.taskId,
      phase: "failed",
      error,
      ...extra,
    },
    isError: true,
  };
}

export function handleTaskControl(
  request: TaskControlRequest,
  deps: TaskControlDependencies,
): TaskControlToolResult {
  const record = findTaskRecord(request.taskId, taskControlRecords(deps));
  if (!record) {
    return errorResult(request, `Task "${request.taskId}" was not found.`, "task_not_found");
  }

  if (request.operation === "status") {
    return {
      content: [{ type: "text", text: taskControlText(record) }],
      details: {
        operation: "status",
        task_id: record.id,
        agent_type: record.agentType,
        session_name: record.sessionName,
        conversation_id: record.conversationId,
        backend: record.backend,
        status: record.status,
        cleanup_pending: record.cleanupPending,
        cwd: record.cwd,
        phase: record.status === "running" ? "running" : "done",
      },
    };
  }

  const decision = decideCancellation(record);
  if (decision.kind === "terminal") {
    return errorResult(
      request,
      `Task "${record.id}" is already ${decision.status}.`,
      "task_already_terminal",
      { status: decision.status },
    );
  }
  if (decision.kind === "unsupported") {
    return errorResult(
      request,
      `Task "${record.id}" uses the SDK backend and cannot be cancelled through the durable control API.`,
      "sdk_cancel_unsupported",
      { backend: record.backend },
    );
  }

  const entry = readRegistry(deps.piDir).find((candidate) => candidate.id === record.id);
  if (!entry) {
    return errorResult(
      request,
      `Task "${record.id}" has no durable live resource to cancel.`,
      "live_resource_missing",
      { backend: decision.backend },
    );
  }

  let resourceStatus: TaskResourceStatus;
  try {
    resourceStatus = deps.registryEntryStatus(entry);
  } catch {
    resourceStatus = "unavailable";
  }
  if (resourceStatus !== "alive") {
    return errorResult(
      request,
      `Task "${record.id}" could not be cancelled because its ${decision.backend} resource is ${resourceStatus}.`,
      `resource_${resourceStatus}`,
      { backend: decision.backend },
    );
  }

  const task = deps.backgroundTasks.get(record.id) ?? backgroundTaskFromRegistry(entry);
  const completion = (deps.completeTask ?? persistCompletedTask)(
    deps.pi,
    record.id,
    task,
    "Task was cancelled by request.",
    "cancelled",
    deps.piDir,
    undefined,
    undefined,
    deps.onComparisonSettled,
  );
  deps.noteTaskFinished?.(record.id, task);
  deps.backgroundTasks.delete(record.id);
  deps.clearTaskWidgetIfIdle();
  if (!completion.cleanupSucceeded) {
    return errorResult(
      request,
      `Task "${record.id}" was marked cancelled, but its ${decision.backend} resource could not be closed; cleanup will be retried.`,
      "cleanup_pending",
      { backend: decision.backend, status: "cancelled", cleanup_pending: true },
    );
  }
  return {
    content: [{ type: "text", text: `Cancelled task ${record.id} (${record.agentType}) via ${decision.backend}.` }],
    details: {
      operation: "cancel",
      task_id: record.id,
      agent_type: record.agentType,
      backend: decision.backend,
      status: "cancelled",
      phase: "done",
    },
  };
}
