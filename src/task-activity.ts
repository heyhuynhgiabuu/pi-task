/**
 * What a running child is doing right now, for the animated working
 * indicators (the below-editor task rows and the live child panel).
 *
 * Phases come only from data that actually exists:
 *
 * - `tool`: a tool slot that is still running — a live transcript tool item with
 *   `inProgress`, or a session-file tool call whose result has not been written.
 * - `thinking` / `streaming`: an in-flight streamed assistant partial. Only the
 *   durable live projection marks items with `streaming` (the `pi.live`
 *   generation partial); snapshot reads of a session JSONL hold committed
 *   messages and therefore never claim either phase.
 * - `running`: the child process is alive but nothing finer is known yet.
 *
 * A task that is no longer running has no activity, so its indicator stops.
 */

import type { ToolCallRecord } from "./helpers.js";
import type { TranscriptItem } from "./panel/transcript.js";

export type TaskPhase = "thinking" | "streaming" | "tool" | "running";

export interface TaskActivity {
  phase: TaskPhase;
  /** Ready-to-render label, e.g. `Running websearch…`. */
  label: string;
}

export interface TaskActivityInput {
  /** Live transcript items, when the backend streams them (durable, SDK). */
  items?: readonly TranscriptItem[];
  /** Tool calls read from the child's session file (terminal and SDK children). */
  recentCalls?: readonly ToolCallRecord[];
  /** Task status; anything other than "running"/undefined means it has settled. */
  status?: string;
}

function runningTool(name: string | undefined): TaskActivity {
  const tool = (name ?? "").trim();
  return { phase: "tool", label: tool ? `Running ${tool}…` : "Running…" };
}

export function taskActivity(input: TaskActivityInput): TaskActivity | undefined {
  if (input.status !== undefined && input.status !== "running") return undefined;

  const last = input.items?.at(-1);
  if (last?.type === "tool" && last.inProgress === true) return runningTool(last.name);
  if (last?.type === "assistant" && last.streaming === true) {
    // A partial that has only produced reasoning is thinking, not answering.
    return last.text.trim() === "" && (last.thinking ?? "").trim() !== ""
      ? { phase: "thinking", label: "Thinking…" }
      : { phase: "streaming", label: "Streaming…" };
  }

  const latestCall = input.recentCalls?.at(-1);
  if (latestCall?.status === "in_progress") return runningTool(latestCall.name);

  return { phase: "running", label: "Running…" };
}
