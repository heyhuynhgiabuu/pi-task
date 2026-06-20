/**
 * Tmux helpers for subagent panes (shared by task extension).
 */

import { execFileSync } from "node:child_process";

export function tmuxCmd(args: string[]): string {
  return execFileSync("tmux", args, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

export function hasTmux(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export function paneExists(paneId: string): boolean {
  try {
    const out = tmuxCmd(["list-panes", "-a", "-F", "#{pane_id}"]);
    return out.split("\n").includes(paneId);
  } catch {
    return false;
  }
}

export function getCurrentPaneId(): string | null {
  try {
    return tmuxCmd(["display-message", "-p", "#{pane_id}"]);
  } catch {
    return null;
  }
}

export function splitWindowPane(
  cwd: string,
  command: string,
): { paneId: string; originalPane: string | null } {
  const originalPane = getCurrentPaneId();
  const paneId = tmuxCmd([
    "split-window",
    "-h",
    "-P",
    "-F",
    "#{pane_id}",
    "-c",
    cwd,
    command,
  ]);
  return { paneId, originalPane };
}

export function killAgentPane(
  paneId: string,
  originalPane: string | null,
): void {
  try {
    tmuxCmd(["kill-pane", "-t", paneId]);
  } catch {
    /* already dead */
  }
  if (originalPane) {
    try {
      tmuxCmd(["select-pane", "-t", originalPane]);
    } catch {
      /* ignore */
    }
  }
}

/** Inject keys into a running subagent pane (steer / follow-up). */
export function tmuxSteerPane(paneId: string, message: string): void {
  const escaped = message.replace(/'/g, `'\"'\"'`);
  tmuxCmd(["send-keys", "-t", paneId, "-l", escaped]);
  tmuxCmd(["send-keys", "-t", paneId, "Enter"]);
}
