import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  capturePaneTail,
  capturePaneTailAsync,
  paneDead,
  paneDeadAsync,
  type AsyncTmuxCommand,
} from "./tmux.js";

const MAX_PANE_CHARS = 4000;

export function sessionDirForTask(artifactsDir: string, taskId: string): string {
  return join(artifactsDir, "sessions", taskId);
}

export function sessionJsonlExists(artifactsDir: string, taskId: string): boolean {
  const dir = sessionDirForTask(artifactsDir, taskId);
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir).some((f) => f.endsWith(".jsonl"));
  } catch {
    return false;
  }
}

function sanitizePaneCapture(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "(pane capture empty — child may have exited before rendering)";
  if (trimmed.length <= MAX_PANE_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_PANE_CHARS)}\n… [pane capture truncated]`;
}

export type SubagentFailureKind = "pane_exit" | "no_result" | "timeout";

export interface FailureDiagnosticsInput {
  kind: SubagentFailureKind;
  baseMessage: string;
  paneId?: string;
  artifactsDir?: string;
  taskId?: string;
  elapsedMs?: number;
}

function buildFailureDiagnosticsPrefix(input: FailureDiagnosticsInput): string[] {
  const lines: string[] = [input.baseMessage, ""];
  if (input.artifactsDir && input.taskId) {
    const sessionDir = sessionDirForTask(input.artifactsDir, input.taskId);
    const hasJsonl = sessionJsonlExists(input.artifactsDir, input.taskId);
    lines.push(`Session dir: ${sessionDir}`);
    lines.push(hasJsonl ? "Session JSONL: present" : "Session JSONL: missing (child pi may have crashed on startup or never wrote a session)");
    if (!hasJsonl && (input.elapsedMs ?? 0) < 60_000) {
      lines.push(
        "Hint: run the same pi command manually in a split pane, or set PI_TASK_CHILD_NO_EXTENSIONS=1 to skip extension load in subagents.",
      );
    }
    lines.push("");
  }
  return lines;
}

export function enrichSubagentFailureMessage(input: FailureDiagnosticsInput): string {
  const lines = buildFailureDiagnosticsPrefix(input);
  if (input.paneId) {
    const dead = paneDead(input.paneId);
    lines.push(`Tmux pane ${input.paneId}: ${dead ? "dead" : "still alive"}`);
    if (dead) {
      lines.push("", "Last lines from subagent pane:", "---", sanitizePaneCapture(capturePaneTail(input.paneId, 120)), "---");
    }
  }
  return lines.join("\n").trimEnd();
}

/** Async diagnostics for lifecycle paths; avoids synchronous tmux CLI calls. */
export async function enrichSubagentFailureMessageAsync(
  input: FailureDiagnosticsInput,
  run?: AsyncTmuxCommand,
): Promise<string> {
  const lines = buildFailureDiagnosticsPrefix(input);
  if (input.paneId) {
    const dead = await paneDeadAsync(input.paneId, run);
    lines.push(`Tmux pane ${input.paneId}: ${dead ? "dead" : "still alive"}`);
    if (dead) {
      lines.push(
        "",
        "Last lines from subagent pane:",
        "---",
        sanitizePaneCapture(await capturePaneTailAsync(input.paneId, 120, run)),
        "---",
      );
    }
  }
  return lines.join("\n").trimEnd();
}
