import {
  getLastAssistantTextFromSessionDir,
  hasAgentFinished,
} from "../session-text.js";
import {
  getLastClaudeAssistantText,
  hasClaudeFinished,
} from "./claudeSession.js";
import {
  enrichSubagentFailureMessage,
  sessionJsonlExists,
} from "./failure-diagnostics.js";
    import { readExitSentinel } from "./exitSentinel.js";
    import { paneDead, paneExists } from "./tmux.js";

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
  resourceExists?: () => boolean | Promise<boolean>;
  exitSentinelPath?: string;
  /** Child runtime; "pi" (default) reads pi JSONL, "claude" reads the
   * Claude Code transcript. */
  runtime?: "pi" | "claude";
  /** Absolute Claude Code transcript path (required for runtime "claude"). */
  claudeSessionFile?: string;
}

interface SessionTextSource {
  sessionDir: string;
  sessionName: string;
  sinceMs?: number;
  runtime?: "pi" | "claude";
  claudeSessionFile?: string;
}

/**
 * Final assistant text for a session, or null while the child is still
 * running. One branch per runtime: pi reads the pi session JSONL in
 * sessionDir; claude reads its own transcript file. All read paths inside
 * completion polling (session read, post-pane-exit flush, exit-sentinel
 * final read) funnel through here.
 */
function readSessionText(
  options: SessionTextSource,
): string | null {
  if (options.runtime === "claude") {
    const file = options.claudeSessionFile;
    if (!file || !hasClaudeFinished(file, options.sinceMs)) return null;
    const text = getLastClaudeAssistantText(file, options.sinceMs).trim();
    return text.length > 0 ? text : null;
  }
  if (!hasAgentFinished(options.sessionDir, options.sessionName, options.sinceMs)) return null;
  const text = getLastAssistantTextFromSessionDir(
    options.sessionDir,
    options.sessionName,
    options.sinceMs,
  ).trim();
  return text.length > 0 ? text : null;
}

const POST_PANE_EXIT_FLUSH_MS = 2500;
const POST_PANE_EXIT_RETRY_MS = 2500;

function reportPaneExitFailure(
  options: Pick<
    WaitForTaskCompletionOptions,
    "paneId" | "artifactsDir" | "taskId" | "sessionDir"
  >,
): string {
  const base = "Subagent pane exited without producing a result.";
  if (!options.paneId) return base;
  return enrichSubagentFailureMessage({
    kind: "pane_exit",
    baseMessage: base,
    paneId: options.paneId,
    artifactsDir: options.artifactsDir,
    taskId: options.taskId,
    elapsedMs: 0,
  });
}

export async function checkTaskCompletion(
  options: Omit<WaitForTaskCompletionOptions, "signal" | "timeoutMs" | "pollMs">,
): Promise<TaskCompletionSnapshot> {
  const paneAlive = options.resourceExists
    ? await options.resourceExists()
    : options.paneId
      ? paneExists(options.paneId)
      : false;

  if (options.paneId && !paneAlive) {
    await sleep(POST_PANE_EXIT_FLUSH_MS);
    const firstPass = readSessionText(options);
    if (firstPass) {
      return { status: "completed", content: firstPass, source: "session-jsonl" };
    }
    await sleep(POST_PANE_EXIT_RETRY_MS);
  }

  const sessionResult = readSessionText(options);
  if (sessionResult) {
    return { status: "completed", content: sessionResult, source: "session-jsonl" };
  }

  if (options.exitSentinelPath && options.taskId) {
    const sentinel = readExitSentinel(options.exitSentinelPath, options.taskId);
    if (sentinel) {
      await sleep(250);
      const finalSessionResult = readSessionText(options);
      if (finalSessionResult) {
        return { status: "completed", content: finalSessionResult, source: "session-jsonl" };
      }
      const message = sentinel.exitCode === 0
        ? "Agent process exited without writing a final session result."
        : `Agent process exited with code ${sentinel.exitCode} before writing a final session result.`;
      return { status: "failed", content: message, source: "exit-sentinel" };
    }
  }

  const stillAlive = options.resourceExists
    ? await options.resourceExists()
    : options.paneId
      ? paneExists(options.paneId)
      : false;
  if (options.paneId && stillAlive) {
    return { status: "running", content: "", source: "pane" };
  }

  return {
    status: "failed",
    content: reportPaneExitFailure(options),
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
      const partial = options.runtime === "claude"
        ? getLastClaudeAssistantText(
            options.claudeSessionFile ?? "",
            options.sinceMs,
          )
        : getLastAssistantTextFromSessionDir(
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
  const base = `Task timed out after ${Math.round(timeoutMs / 1000)}s without producing a result.`;
  let content = base;
  if (options.paneId && paneDead(options.paneId)) {
    content = enrichSubagentFailureMessage({
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
    content = enrichSubagentFailureMessage({
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