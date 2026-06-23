import { readFile } from "node:fs/promises";
    import { existsSync } from "node:fs";
    import { getLastAssistantTextFromSessionDir, hasAgentFinished } from "../session-text.js";
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
      sinceMs?: number;
    }

async function readResultFile(resultPath: string): Promise<string | null> {
  if (!existsSync(resultPath)) return null;
  const text = (await readFile(resultPath, "utf-8")).trim();
  return text.length > 0 ? text : null;
}

        /**
         * Get the last assistant text from the session directory, but ONLY if
         * the agent has actually finished (agent_end emitted). Without this
         * gate, intermediate streaming messages like "Now let me read..." are
         * mistaken for final results and the pane is killed mid-work.
         */
        function readSessionText(
          sessionDir: string,
          sessionName: string,
          sinceMs?: number,
        ): string | null {
      // Session files are written by pi directly into `sessionDir`
      // (flat). Filter by session_info.name so a new task never
      // completes from an older task's JSONL.
          if (!hasAgentFinished(sessionDir, sessionName, sinceMs)) return null;
          const text = getLastAssistantTextFromSessionDir(
            sessionDir,
            sessionName,
            sinceMs,
          ).trim();
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

          // Check session JSONL (gated on agent_end). If the agent has
          // finished, capture the result and kill the pane — even if the
          // pane shell is still lingering (e.g. remain-on-exit).
          const sessionResult = readSessionText(
            options.sessionDir,
            options.sessionName,
            options.sinceMs,
          );
          if (sessionResult) {
            return { status: "completed", content: sessionResult, source: "session-jsonl" };
          }

          // No agent_end yet. If the pane is still alive, the agent is
          // working — keep polling. Intermediate streaming text without
          // agent_end is not a valid completion signal.
          if (options.paneId && paneExists(options.paneId)) {
            return { status: "running", content: "", source: "pane" };
          }

          // Pane exited without agent_end or text — genuine failure.
          return { status: "failed", content: "Subagent pane exited without producing a result." };
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
