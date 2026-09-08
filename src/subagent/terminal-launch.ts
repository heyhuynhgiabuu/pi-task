import { join } from "node:path";
import { shellQuote } from "../helpers.js";
import { resolveSubagentEnvironment } from "./environment.js";
import type {
  TerminalBackend,
  TerminalBackendKind,
  TerminalHandle,
} from "./terminalBackend.js";
import {
  setPaneRemainOnExit,
  setPaneSelfDestruct,
  splitWindowPane,
  writePaneLaunchScript,
} from "./tmux.js";

export interface TerminalTaskLaunchOptions {
  backend: TerminalBackendKind;
  terminalBackend: TerminalBackend;
  agentArgs: readonly string[];
  initialPrompt: string;
  cwd: string;
  sessionDir: string;
  sessionName: string;
  environment: Record<string, string>;
  /** Child runtime; "pi" (default) launches the pi CLI, "claude" launches
   * the Claude Code CLI with its own transcript path. */
  runtime?: "pi" | "claude";
  /** Absolute Claude Code transcript path (required for runtime "claude"). */
  claudeSessionFile?: string;
  label: string;
  workspaceGroup?: string;
  remainOnExit: boolean;
  selfDestruct: boolean;
}

export interface TerminalTaskLaunchResult {
  handle: TerminalHandle;
  paneId: string;
  originalPane: string | null;
}

export function buildTmuxEnvironmentPrefix(
  environment: Readonly<Record<string, string>>,
): string {
  return Object.entries(environment)
    .map(([name, value]) => `${name}=${shellQuote(value)}`)
    .join(" ");
}

export async function launchTerminalTask({
  backend,
  terminalBackend,
  agentArgs,
  initialPrompt,
  cwd,
  sessionDir,
  sessionName,
  environment,
  runtime,
  claudeSessionFile,
  label,
  workspaceGroup,
  remainOnExit,
  selfDestruct,
}: TerminalTaskLaunchOptions): Promise<TerminalTaskLaunchResult> {
  const claudeRuntime = runtime === "claude";
  const environmentResult = resolveSubagentEnvironment(process.env, environment);
  if (!environmentResult.ok) throw new Error(environmentResult.error);
  for (const diagnostic of environmentResult.diagnostics) {
    console.warn(`[pi-task] ${diagnostic.message}`);
  }
  const childEnvironment = environmentResult.environment;

  if (backend === "herdr") {
    const handle = await terminalBackend.launch({
      agentArgs,
      initialPrompt,
      cwd,
      env: childEnvironment,
      agentKind: claudeRuntime ? "claude" : "pi",
      label,
      workspaceGroup,
    });
    return {
      handle,
      paneId: handle.resourceId,
      originalPane: process.env.HERDR_PANE_ID ?? null,
    };
  }

  const envPrefix = buildTmuxEnvironmentPrefix(childEnvironment);
  // Claude gets its prompt as the final positional argv element (submitted by
  // the terminal command line); pi embeds it in agentArgs.
  const shellCommand = claudeRuntime
    ? `${envPrefix} claude ${agentArgs.map((arg) => shellQuote(arg)).join(" ")} ${shellQuote(initialPrompt)}`.trimStart()
    : `${envPrefix} pi ${agentArgs.map((arg) => shellQuote(arg)).join(" ")}`;
  // Claude writes its transcript to its own pinned session file, not the pi
  // task session layout.
  const sessionFile = claudeRuntime && claudeSessionFile
    ? claudeSessionFile
    : join(sessionDir, sessionName + ".jsonl");
  const childCommand = `cd ${shellQuote(cwd)} && ${shellCommand}`;
  // No transcript-stability watcher for claude: its JSONL does not grow
  // during long tool executions, so stability != exit.
  const terminalCommand = writePaneLaunchScript(
    sessionDir,
    sessionFile,
    childCommand,
    !claudeRuntime,
  );
  const splitResult = splitWindowPane(cwd, terminalCommand);
  const paneId = splitResult.paneId;
  setPaneRemainOnExit(paneId, remainOnExit);
  if (selfDestruct) setPaneSelfDestruct(paneId, true);
  return {
    handle: { backend: "tmux", resourceId: paneId },
    paneId,
    originalPane: splitResult.originalPane,
  };
}
