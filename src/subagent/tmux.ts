import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildTmuxSplitWindowArgs, chooseTmuxSplitDirection } from "../helpers.js";
import { createDefaultCommandRunner } from "./terminalBackend.js";

export type TmuxSplitResult = {
  paneId: string;
  originalPane: string | null;
};

function tmuxCmd(args: string[]): string {
  return execFileSync("tmux", args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
    killSignal: "SIGKILL",
  }).trim();
}

function tmuxCmdQuiet(args: string[]): string {
  try {
    return tmuxCmd(args);
  } catch {
    return "";
  }
}

function tmuxErrorText(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const value = error as { message?: unknown; stderr?: unknown; stdout?: unknown };
  return [value.message, value.stderr, value.stdout]
    .filter((part): part is string => typeof part === "string")
    .join(" ");
}

function isMissingPaneError(error: unknown): boolean {
  return /can't find pane|no such pane|pane.*not found/i.test(tmuxErrorText(error));
}

export type TmuxPaneProbe =
  | { state: "alive" }
  | { state: "missing" }
  | { state: "unavailable"; error: unknown };

export type AsyncTmuxCommand = (
  args: readonly string[],
  input?: string,
) => Promise<string>;

const defaultAsyncTmuxCommand: AsyncTmuxCommand = (() => {
  const runner = createDefaultCommandRunner();
  return async (args, input) =>
    (await runner.run("tmux", args, { input })).stdout.trim();
})();

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function hasTmux(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    if (!process.env.TMUX) return false;
    tmuxCmd(["display-message", "-p", "#{pane_id}"]);
    return true;
  } catch {
    return false;
  }
}

function getCurrentPaneId(): string | null {
  return tmuxCmdQuiet(["display-message", "-p", "#{pane_id}"]) || null;
}

function getCurrentPaneSize(
  targetPane?: string | null,
): { width: number; height: number } | null {
  const args = ["display-message", "-p", "#{pane_width} #{pane_height}"];
  if (targetPane) args.splice(1, 0, "-t", targetPane);
  const raw = tmuxCmdQuiet(args);
  const [widthRaw, heightRaw] = raw.trim().split(/\s+/, 2);
  const width = Number(widthRaw);
  const height = Number(heightRaw);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  return { width, height };
}

export function splitWindowPane(cwd: string, command: string): TmuxSplitResult {
  const originalPane = getCurrentPaneId();
  const paneSize = getCurrentPaneSize(originalPane);
  const direction = chooseTmuxSplitDirection(
    paneSize?.width ?? 0,
    paneSize?.height ?? 0,
    process.env.PI_TASK_TMUX_SPLIT,
  );
  const paneId = tmuxCmd(
    buildTmuxSplitWindowArgs(cwd, command, direction, originalPane),
  );
  return { paneId, originalPane };
}

export function setPaneRemainOnExit(paneId: string, enabled: boolean): void {
  tmuxCmdQuiet([
    "set-option",
    "-p",
    "-t",
    paneId,
    "remain-on-exit",
    enabled ? "on" : "off",
  ]);
}

export function setPaneSelfDestruct(paneId: string, enabled: boolean, delaySeconds = 1): void {
  const hook = enabled
    ? `run-shell 'sleep ${Math.max(0, delaySeconds)}; tmux kill-pane -t ${paneId} 2>/dev/null || true'`
    : "";
  tmuxCmdQuiet(["set-hook", "-p", "-t", paneId, "pane-died", hook]);
}

export function probePane(paneId: string): TmuxPaneProbe {
  try {
    const actualPaneId = tmuxCmd([
      "display-message",
      "-p",
      "-t",
      paneId,
      "#{pane_id}",
    ]);
    return actualPaneId === paneId
      ? { state: "alive" }
      : { state: "missing" };
  } catch (error) {
    return isMissingPaneError(error)
      ? { state: "missing" }
      : { state: "unavailable", error };
  }
}

export async function probePaneAsync(
  paneId: string,
  run: AsyncTmuxCommand = defaultAsyncTmuxCommand,
): Promise<TmuxPaneProbe> {
  try {
    const actualPaneId = (await run([
      "display-message",
      "-p",
      "-t",
      paneId,
      "#{pane_id}",
    ])).trim();
    return actualPaneId === paneId
      ? { state: "alive" }
      : { state: "missing" };
  } catch (error) {
    return isMissingPaneError(error)
      ? { state: "missing" }
      : { state: "unavailable", error };
  }
}

export async function paneDeadAsync(
  paneId: string,
  run: AsyncTmuxCommand = defaultAsyncTmuxCommand,
): Promise<boolean> {
  const probe = await probePaneAsync(paneId, run);
  if (probe.state === "missing" || probe.state === "unavailable") {
    return probe.state === "missing";
  }
  try {
    return (await run([
      "display-message",
      "-p",
      "-t",
      paneId,
      "#{pane_dead}",
    ])).trim() === "1";
  } catch {
    return false;
  }
}

export async function capturePaneTailAsync(
  paneId: string,
  lines = 80,
  run: AsyncTmuxCommand = defaultAsyncTmuxCommand,
): Promise<string> {
  try {
    return await run([
      "capture-pane",
      "-p",
      "-t",
      paneId,
      "-S",
      `-${Math.max(1, lines)}`,
    ]);
  } catch {
    return "";
  }
}

export function paneExists(paneId: string): boolean {
  return probePane(paneId).state === "alive";
}

export function paneDead(paneId: string): boolean {
  const probe = probePane(paneId);
  if (probe.state === "missing" || probe.state === "unavailable") {
    return probe.state === "missing";
  }
  return tmuxCmdQuiet(["display-message", "-p", "-t", paneId, "#{pane_dead}"]) === "1";
}

export function capturePaneTail(paneId: string, lines = 80): string {
  return tmuxCmdQuiet([
    "capture-pane",
    "-p",
    "-t",
    paneId,
    "-S",
    `-${Math.max(1, lines)}`,
  ]);
}

export function killAgentPane(paneId: string, originalPane?: string | null): void {
  if (originalPane) {
    try {
      tmuxCmd(["select-pane", "-t", originalPane]);
    } catch {
      // Original pane may have been closed; still try to kill the agent pane.
    }
  }
  tmuxCmdQuiet(["kill-pane", "-t", paneId]);
}

export async function killAgentPaneStrictAsync(
  paneId: string,
  originalPane: string | null = null,
  run: AsyncTmuxCommand = defaultAsyncTmuxCommand,
): Promise<void> {
  if (originalPane) {
    try {
      await run(["select-pane", "-t", originalPane]);
    } catch {
      // Original pane may have been closed; still try to kill the agent pane.
    }
  }
  let existingPane: string;
  try {
    existingPane = (await run([
      "display-message",
      "-p",
      "-t",
      paneId,
      "#{pane_id}",
    ])).trim();
  } catch (error) {
    if (isMissingPaneError(error)) return;
    throw error;
  }
  if (existingPane !== paneId) throw new Error(`tmux pane identity mismatch: ${paneId}`);
  try {
    await run(["kill-pane", "-t", paneId]);
  } catch (error) {
    if (isMissingPaneError(error)) return;
    throw error;
  }
}

/** Close a task pane while distinguishing an unavailable tmux server from an already-gone pane. */
export function killAgentPaneStrict(paneId: string, originalPane?: string | null): void {
  if (originalPane) {
    try {
      tmuxCmd(["select-pane", "-t", originalPane]);
    } catch {
      // Original pane may have been closed; still try to kill the agent pane.
    }
  }
  let existingPane: string;
  try {
    existingPane = tmuxCmd(["display-message", "-p", "-t", paneId, "#{pane_id}"]);
  } catch (error) {
    if (isMissingPaneError(error)) return;
    throw error;
  }
  if (existingPane !== paneId) throw new Error(`tmux pane identity mismatch: ${paneId}`);
  try {
    tmuxCmd(["kill-pane", "-t", paneId]);
  } catch (error) {
    if (isMissingPaneError(error)) return;
    throw error;
  }
}

/** Inject text into a running subagent pane (steer / follow-up). */
export function tmuxSteerPane(paneId: string, message: string): void {
  const bufferName = `pi-task-steer-${process.pid}-${Date.now()}`;
  try {
    execFileSync("tmux", ["load-buffer", "-b", bufferName, "-"], {
      input: message,
      stdio: ["pipe", "pipe", "pipe"],
    });
    tmuxCmd(["paste-buffer", "-b", bufferName, "-t", paneId]);
  } finally {
    tmuxCmdQuiet(["delete-buffer", "-b", bufferName]);
  }
  tmuxCmd(["send-keys", "-t", paneId, "Enter"]);
}

export async function tmuxSteerPaneAsync(
  paneId: string,
  message: string,
  run: AsyncTmuxCommand = defaultAsyncTmuxCommand,
): Promise<void> {
  const bufferName = `pi-task-steer-${process.pid}-${Date.now()}`;
  try {
    await run(["load-buffer", "-b", bufferName, "-"], message);
    await run(["paste-buffer", "-b", bufferName, "-t", paneId]);
  } finally {
    try {
      await run(["delete-buffer", "-b", bufferName]);
    } catch {
      // Best-effort buffer cleanup must not hide the steer result.
    }
  }
  await run(["send-keys", "-t", paneId, "Enter"]);
}

function sessionWatcherScript(sessionFilePath: string): string {
  const quotedPath = shellQuote(sessionFilePath);
  // Watch a *specific* file so stale sibling files can't trigger premature /exit.
  return `(
  if [ -s ${quotedPath} ]; then
    last_size=$(wc -c < ${quotedPath} 2>/dev/null || echo 0)
  else
    last_size=-1
  fi
  stable=0
  deadline=$(( $(date +%s) + 86400 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if [ -s ${quotedPath} ]; then
      size=$(wc -c < ${quotedPath} 2>/dev/null || echo 0)
      if [ "$size" = "$last_size" ]; then
        stable=$((stable + 1))
      else
        stable=0
        last_size=$size
      fi
      if [ "$stable" -ge 3 ]; then
        tmux send-keys -t "$TMUX_PANE" /exit Enter 2>/dev/null || true
        sleep 0.2
        tmux send-keys -t "$TMUX_PANE" 'exit 0' Enter 2>/dev/null || true
        sleep 2
        tmux kill-pane -t "$TMUX_PANE" 2>/dev/null || true
        exit 0
      fi
    fi
    sleep 0.5
  done
) & watcher_pid=$!`;
}

function buildPaneExitWatcherScript(
  sessionFilePath: string,
  command: string,
): string {
  return `tmux set-option -p -t "$TMUX_PANE" remain-on-exit on 2>/dev/null || true
${sessionWatcherScript(sessionFilePath)}
${command}
exit_code=$?
kill "$watcher_pid" 2>/dev/null || true
wait "$watcher_pid" 2>/dev/null || true
if [ "$exit_code" -eq 0 ]; then
  tmux set-hook -p -t "$TMUX_PANE" pane-died '' 2>/dev/null || true
  tmux set-option -p -t "$TMUX_PANE" remain-on-exit off 2>/dev/null || true
  tmux kill-pane -t "$TMUX_PANE" 2>/dev/null || true
fi
exit "$exit_code"`;
}

/**
 * Write the pane launch command to a script file and return a short
 * `sh <path>` command for `tmux split-window`.
 *
 * tmux rejects commands over its input-buffer limit (~16 KB on tmux 3.7c;
 * lower on older versions, issue #18), so the full subagent launch —
 * including the system-prompt file path, the initial prompt, and the
 * exit watcher — must never travel inside the tmux command string. The
 * script file has no such limit; the command handed to tmux stays short.
 * The script stays in the per-task session dir: the pane shell reads it
 * at start, so deleting it immediately would be racy.
 */
export function writePaneLaunchScript(
  sessionDir: string,
  sessionFilePath: string,
  command: string,
): string {
  const scriptPath = join(sessionDir, "pane-launch.sh");
  writeFileSync(
    scriptPath,
    buildPaneExitWatcherScript(sessionFilePath, command),
    { mode: 0o700 },
  );
  return `sh ${shellQuote(scriptPath)}`;
}


