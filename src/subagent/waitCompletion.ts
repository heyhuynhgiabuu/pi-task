import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getLastAssistantTextFromSessionDir } from "../session-text.js";
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
  sessionName: string;
  paneId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  pollMs?: number;
}

async function readResultFile(resultPath: string): Promise<string | null> {
  if (!existsSync(resultPath)) return null;
  const text = (await readFile(resultPath, "utf-8")).trim();
  return text.length > 0 ? text : null;
}

function readSessionText(
  sessionDir: string,
  sessionName: string,
): string | null {
  const sessionPath = join(sessionDir, "sessions", sessionName);
  const text = getLastAssistantTextFromSessionDir(sessionPath).trim();
  return text.length > 0 ? text : null;
}

export async function checkTaskCompletion(
  options: TaskCompletionOptions,
): Promise<TaskCompletionSnapshot> {
  const result = await readResultFile(options.resultPath);
  if (result) {
    return { status: "completed", content: result, source: "result-file" };
  }

  if (options.paneId && paneExists(options.paneId)) {
    return { status: "running", content: "", source: "pane" };
  }

  const sessionText = readSessionText(options.sessionDir, options.sessionName);
  if (sessionText) {
    return {
      status: "completed",
      content: sessionText,
      source: "session-jsonl",
    };
  }

  if (options.paneId) {
    return {
      status: "failed",
      content:
        "Task pane exited before producing a result or assistant response.",
      source: "pane",
    };
  }

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
