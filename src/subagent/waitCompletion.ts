import { readFile } from "node:fs/promises";
    import { existsSync } from "node:fs";
    import { getLastAssistantTextFromSessionDir } from "../session-text.js";
    import { paneExists } from "./tmux.js";

    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
      _sessionName: string,
    ): string | null {
      // Session files are written by pi directly into `sessionDir`
      // (flat). `sessionName` is preserved for future per-session
      // filtering; for now, just scan the whole dir.
      const text = getLastAssistantTextFromSessionDir(sessionDir).trim();
      return text.length > 0 ? text : null;
    }
    
        export async function checkTaskCompletion(
          options: TaskCompletionOptions,
        ): Promise<TaskCompletionSnapshot> {
              // When the pane has exited, give pi a brief moment to flush the
              // session file. Without this, the read can catch a partial
              // file (e.g. the last `agent_end` / `message_end` events not
              // yet written) and report "failed" even though the subagent
              // completed successfully.
              if (options.paneId && !paneExists(options.paneId)) {
                await sleep(500);
              }

              const result = await readResultFile(options.resultPath);
              if (result) {
                return { status: "completed", content: result, source: "result-file" };
              }

              // Check session text FIRST. If the subagent's session file has
              // its final assistant message, the subagent is done — kill the
              // pane and return, regardless of whether the pane shell is
              // still open (e.g. remain-on-exit on, or the command exited but
              // tmux kept the shell alive).
          const sessionResult = readSessionText(
            options.sessionDir,
            options.sessionName,
          );
          if (sessionResult) {
            return { status: "completed", content: sessionResult, source: "session-jsonl" };
          }

          // No session text yet. If the pane is gone and we never got
          // session text, the subagent failed.
          if (options.paneId && !paneExists(options.paneId)) {
            return { status: "failed", content: "Subagent pane exited without producing a result." };
          }

          // Pane still exists and no session text yet — keep polling.
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
