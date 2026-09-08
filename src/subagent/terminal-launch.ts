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
  label,
  workspaceGroup,
  remainOnExit,
  selfDestruct,
}: TerminalTaskLaunchOptions): Promise<TerminalTaskLaunchResult> {
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
  const shellCommand = `${envPrefix} pi ${agentArgs.map((arg) => shellQuote(arg)).join(" ")}`;
  const sessionFile = join(sessionDir, sessionName + ".jsonl");
  const childCommand = `cd ${shellQuote(cwd)} && ${shellCommand}`;
  const terminalCommand = writePaneLaunchScript(sessionDir, sessionFile, childCommand);
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
