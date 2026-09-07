import {
  getLastAssistantResultFromSessionDir,
  getLastAssistantTextFromSessionDir,
} from "../session-text.js";
import {
  enrichSubagentFailureMessageAsync,
  sessionJsonlExists,
} from "./failure-diagnostics.js";
import { readExitSentinel } from "./exitSentinel.js";
import { paneDeadAsync, probePane } from "./tmux.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type TaskCompletionStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout";

export interface TaskCompletionSnapshot {
  status: TaskCompletionStatus;
  content: string;
  source?: "session-jsonl" | "pane" | "exit-sentinel" | "timeout" | "signal";
}

export type ResourceState = "alive" | "missing" | "unavailable";
export type ResourceProbe = ResourceState | boolean;

export interface WaitForTaskCompletionOptions {
  sessionDir: string;
  sessionName: string;
  paneId?: string;
  artifactsDir?: string;
  taskId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  pollMs?: number;
  sinceMs?: number;
  resourceExists?: () => ResourceProbe | Promise<ResourceProbe>;
  exitSentinelPath?: string;
}

/**
 * v0.1.6: The subagent's final assistant message from the auto-saved
 * persistent JSONL session IS the result. No RESULT.md, no agent instructions
 * to write a file. Completion is gated by the assistant's terminal
 * `stopReason` (not `toolUse`, not streaming text).
 */
function readSessionResult(
  sessionDir: string,
  sessionName: string,
  sinceMs?: number,
): TaskCompletionSnapshot | null {
  const result = getLastAssistantResultFromSessionDir(
    sessionDir,
    sessionName,
    sinceMs,
  );
  if (!result) return null;
  return {
    status: result.status,
    content: result.content,
    source: "session-jsonl",
  };
}

const POST_PANE_EXIT_FLUSH_MS = 2500;
const POST_PANE_EXIT_RETRY_MS = 2500;

async function reportPaneExitFailure(
  options: Pick<
    WaitForTaskCompletionOptions,
    "paneId" | "artifactsDir" | "taskId" | "sessionDir"
  >,
): Promise<string> {
  const base = "Subagent pane exited without producing a result.";
  if (!options.paneId) return base;
  return enrichSubagentFailureMessageAsync({
    kind: "pane_exit",
    baseMessage: base,
    paneId: options.paneId,
    artifactsDir: options.artifactsDir,
    taskId: options.taskId,
    elapsedMs: 0,
  });
}

async function enrichEmptySessionFailure(
  snapshot: TaskCompletionSnapshot,
  options: Pick<
    WaitForTaskCompletionOptions,
    "paneId" | "artifactsDir" | "taskId" | "sessionDir"
  >,
): Promise<TaskCompletionSnapshot> {
  if (
    snapshot.status !== "failed" ||
    snapshot.content !== "Subagent finished without producing a result."
  ) {
    return snapshot;
  }
  return { ...snapshot, content: await reportPaneExitFailure(options) };
}

function normalizeResourceState(value: ResourceProbe): ResourceState {
  if (typeof value === "boolean") return value ? "alive" : "missing";
  return value;
}

async function getResourceState(
  options: Pick<WaitForTaskCompletionOptions, "paneId" | "resourceExists">,
): Promise<ResourceState> {
  if (options.resourceExists) {
    return normalizeResourceState(await options.resourceExists());
  }
  if (options.paneId) return probePane(options.paneId).state;
  return "missing";
}

export async function checkTaskCompletion(
  options: Omit<WaitForTaskCompletionOptions, "signal" | "timeoutMs" | "pollMs">,
): Promise<TaskCompletionSnapshot> {
  const initialResourceState = await getResourceState(options);

  if (options.paneId && initialResourceState === "missing") {
    await sleep(POST_PANE_EXIT_FLUSH_MS);
    const firstPass = readSessionResult(
      options.sessionDir,
      options.sessionName,
      options.sinceMs,
    );
    if (firstPass) return await enrichEmptySessionFailure(firstPass, options);
    await sleep(POST_PANE_EXIT_RETRY_MS);
  }

  const sessionResult = readSessionResult(
    options.sessionDir,
    options.sessionName,
    options.sinceMs,
  );
  // A provider error/abort can be an intermediate row while Pi retries. Do
  // not settle it while the child resource is still alive; a later poll may
  // observe the successful terminal row. Successful terminal output remains
  // authoritative immediately.
  if (sessionResult?.status === "completed") return sessionResult;
  const deferredSessionFailure = sessionResult?.status === "failed"
    ? sessionResult
    : undefined;

  if (options.exitSentinelPath && options.taskId) {
    const sentinel = readExitSentinel(options.exitSentinelPath, options.taskId);
    if (sentinel) {
      await sleep(250);
      const finalSessionResult = readSessionResult(
        options.sessionDir,
        options.sessionName,
        options.sinceMs,
      );
      if (finalSessionResult) return finalSessionResult;
      const message = sentinel.exitCode === 0
        ? "Agent process exited without writing a final session result."
        : `Agent process exited with code ${sentinel.exitCode} before writing a final session result.`;
      return { status: "failed", content: message, source: "exit-sentinel" };
    }
  }

  const finalResourceState = await getResourceState(options);
  if (deferredSessionFailure && finalResourceState === "missing") {
    return await enrichEmptySessionFailure(deferredSessionFailure, options);
  }
  if (
    (options.paneId || options.resourceExists) &&
    finalResourceState !== "missing"
  ) {
    // A backend outage is not evidence that the child pane died. Keep the
    // durable task pending and let a later poll retry the probe.
    return { status: "running", content: "", source: "pane" };
  }

  return {
    status: "failed",
    content: await reportPaneExitFailure(options),
    source: "pane",
  };
}

export async function waitForTaskCompletion(
  options: WaitForTaskCompletionOptions,
): Promise<TaskCompletionSnapshot> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
  const pollMs = options.pollMs ?? 1000;

  while (Date.now() - started < timeoutMs) {
    if (options.signal?.aborted) {
      const partial = getLastAssistantTextFromSessionDir(
        options.sessionDir,
        options.sessionName,
        options.sinceMs,
      );
      return {
        status: "cancelled",
        content: partial?.trim() || "Task was cancelled.",
        source: "signal",
      };
    }

    const snapshot = await checkTaskCompletion(options);
    if (snapshot.status !== "running") return snapshot;
    await sleep(pollMs);
  }

  const elapsedMs = Date.now() - started;
  // A provider failure may have been deferred while the child resource stayed
  // alive. Preserve that classified terminal content instead of replacing it
  // with a generic timeout if no later retry arrived.
  const finalSessionResult = readSessionResult(
    options.sessionDir,
    options.sessionName,
    options.sinceMs,
  );
  if (finalSessionResult) return await enrichEmptySessionFailure(finalSessionResult, options);

  const base = `Task timed out after ${Math.round(timeoutMs / 1000)}s without producing a result.`;
  let content = base;
  if (options.paneId && await paneDeadAsync(options.paneId)) {
    content = await enrichSubagentFailureMessageAsync({
      kind: "timeout",
      baseMessage: base,
      paneId: options.paneId,
      artifactsDir: options.artifactsDir,
      taskId: options.taskId,
      elapsedMs,
    });
  } else if (
    options.artifactsDir &&
    options.taskId &&
    !sessionJsonlExists(options.artifactsDir, options.taskId)
  ) {
    content = await enrichSubagentFailureMessageAsync({
      kind: "timeout",
      baseMessage: base,
      artifactsDir: options.artifactsDir,
      taskId: options.taskId,
      elapsedMs,
    });
  }

  return {
    status: "timeout",
    content,
    source: "timeout",
  };
}