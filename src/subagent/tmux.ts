/**
 * Tmux helpers for subagent panes (shared by task extension + completion poll).
 */

import { execFileSync } from "node:child_process";

export function tmuxCmd(args: string[]): string {
  return execFileSync("tmux", args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function hasTmux(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function paneExists(paneId: string): boolean {
  try {
    return tmuxCmd(["list-panes", "-a", "-F", "#{pane_id}"])
      .split("\n")
      .includes(paneId);
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
  // Pass the command directly to split-window. tmux waits for the new shell
  // to be ready before executing it, avoiding the send-keys race where the
  // shell processes an incomplete line because Enter arrives before all
  // characters have been typed.
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

/**
 * Kill the subagent pane and restore focus to the original pane.
 *
 * Guards the kill with paneExists so a stale/recycled pane id cannot target
 * the wrong pane, and tolerates an undefined paneId (e.g. SDK path).
 */
export function killAgentPane(
  paneId: string | undefined,
  originalPane: string | null,
): void {
  if (paneId) {
    try {
      if (paneExists(paneId)) tmuxCmd(["kill-pane", "-t", paneId]);
    } catch {
      /* ignore */
    }
  }
  if (originalPane) {
    try {
      tmuxCmd(["select-pane", "-t", originalPane]);
    } catch {
      /* ignore */
    }
  }
}
