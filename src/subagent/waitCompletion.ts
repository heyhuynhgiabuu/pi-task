import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  getLastAssistantTextFromSessionDir,
  getSessionTerminalState,
} from "../session-text.js";
import { paneExists } from "./tmux.js";

export type TaskCompletionStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout";

export interface TaskCompletionSnapshot {
  status: TaskCompletionStatus;
  content: string;
  source?: "result-file" | "session-jsonl" | "pane" | "timeout" | "signal";
}

export interface TaskCompletionOptions {
  resultPath: string;
  sessionDir: string;
  paneId?: string;
  /**
   * Predicate that reports whether a tmux pane is currently alive. The
   * default uses the real `paneExists` (which shells out to `tmux`).
   * Tests inject a synchronous mock so the pane-alive branch of the
   * completion state machine can be exercised deterministically on
   * machines that do not have a tmux server.
   */
  paneExists?: (paneId: string) => boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  pollMs?: number;
}

async function readResultFile(resultPath: string): Promise<string | null> {
  if (!existsSync(resultPath)) return null;
  const text = (await readFile(resultPath, "utf-8")).trim();
  return text.length > 0 ? text : null;
}

function readSessionText(sessionDir: string): string | null {
  // sessionDir is already the sessions directory (artifactDir/sessions).
  // pi writes jsonl files directly inside it as <session-id>.jsonl.
  const text = getLastAssistantTextFromSessionDir(sessionDir).trim();
  return text.length > 0 ? text : null;
}

/**
 * Resolve the sessions directory for a task artifact root.
 *
 * pi writes session jsonl files directly into `<artifactDir>/sessions`
 * (one file per session id). Centralising the join here means a future
 * change to the on-disk layout only has to touch one place, and the
 * wiring in `src/index.ts` can be unit-tested.
 */
export function resolveSessionDir(taskDir: string): string {
  return join(taskDir, "sessions");
}

export async function checkTaskCompletion(
  options: TaskCompletionOptions,
): Promise<TaskCompletionSnapshot> {
  // Dependency-injected so the pane-alive branch is testable without a
  // real tmux server (see TaskCompletionOptions.paneExists).
  const paneExistsFn = options.paneExists ?? paneExists;

  // 1. RESULT.md is the primary completion signal.
  const resultFile = await readResultFile(options.resultPath);
  if (resultFile) {
    return { status: "completed", content: resultFile, source: "result-file" };
  }

  // 2. If the subagent's last assistant turn ended with stopReason "stop"
  //    (or a non-tool-use error like "error"/"length"), the work is done even
  //    if the TUI pane is still open waiting for the next user input.
  const { state: terminalState, stopReason } = getSessionTerminalState(
    options.sessionDir,
  );
  if (terminalState === "stopped" || terminalState === "errored") {
    const sessionText = readSessionText(options.sessionDir);
    if (sessionText) {
      return {
        status: terminalState === "errored" ? "failed" : "completed",
        content: sessionText,
        source: "session-jsonl",
      };
    }
    // No assistant text to surface — fall back to a diagnostic that names
    // the real stopReason (so "error" and "length" are not conflated).
    const stopReasonLabel =
      stopReason ?? (terminalState === "stopped" ? "stop" : "error");
    return {
      status: terminalState === "errored" ? "failed" : "completed",
      content: `Subagent ended (stopReason: ${stopReasonLabel}) but did not write ${options.resultPath} and produced no final text. Inspect the session jsonl in ${options.sessionDir} for tool calls and intermediate output.`,
      source: "session-jsonl",
    };
  }

  // 3. Assistant is still mid-turn or session has not produced a jsonl yet.
  //    If the pane is alive, the subagent is running.
  if (options.paneId && paneExistsFn(options.paneId)) {
    return { status: "running", content: "", source: "pane" };
  }

  // 4. Pane is dead but we still have session text from a previous turn.
  //    (Legacy fallback; in practice step 2 catches the stopReason case.)
  const sessionText = readSessionText(options.sessionDir);
  if (sessionText) {
    return {
      status: "completed",
      content: sessionText,
      source: "session-jsonl",
    };
  }

  // 5. Pane dead, nothing to show → failed.
  if (options.paneId) {
    return {
      status: "failed",
      content:
        "Task pane exited before producing a result or assistant response.",
      source: "pane",
    };
  }

  // 6. No paneId (e.g. SDK path), no completion signal yet → still running.
  return { status: "running", content: "", source: "pane" };
}

export async function waitForTaskCompletion(
  options: TaskCompletionOptions,
): Promise<TaskCompletionSnapshot> {
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
  const pollMs = options.pollMs ?? 1000;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    if (options.signal?.aborted) {
      return {
        status: "cancelled",
        content: "Task was cancelled.",
        source: "signal",
      };
    }

    const snapshot = await checkTaskCompletion(options);
    if (snapshot.status !== "running") return snapshot;

    if (Date.now() >= deadline) {
      return {
        status: "timeout",
        content: `Task timed out after ${Math.round(timeoutMs / 1000)}s without producing a result.`,
        source: "timeout",
      };
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
