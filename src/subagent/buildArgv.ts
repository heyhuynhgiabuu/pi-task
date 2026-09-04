/**
 * Build `pi` CLI argv for subagent spawns.
 */

import type { AgentConfig } from "../helpers.js";
import { resolveAgentToolAllowlist } from "../agent-tools.js";

export interface PiPromptLaunchOptions {
  systemPromptPath: string;
  deferTaskPrompt: boolean;
}

export interface BuildPiArgvOptions {
  agent: AgentConfig;
  sessionName: string;
  sessionDir: string;
  promptContent: string;
  resume?: boolean;
  resumeSessionRef?: string;
  parentToolNames?: string[];
  taskToolName?: string;
  promptLaunch?: PiPromptLaunchOptions;
  /** Absolute skill paths passed to Pi's repeatable --skill option. */
  skillPaths?: string[];
  fast?: boolean;
  fastExtensionPath?: string;
  /**
   * Extensions that must load even when discovery is disabled (--no-extensions).
   * Pushed only alongside --no-extensions so discovery-enabled launches keep
   * loading extensions through their normal mechanism.
   */
  requiredExtensions?: string[];
}

export function buildPiArgv(opts: BuildPiArgvOptions): string[] {
  const { agent, sessionName, sessionDir, promptContent, resume } = opts;

  const allowedTools = resolveAgentToolAllowlist({
    tools: agent.tools,
    disallowedTools: agent.disallowedTools,
    parentToolNames: opts.parentToolNames,
    taskToolName: opts.taskToolName,
  });

  const args: string[] = [];
  const noDiscovery =
    opts.fast || process.env.PI_TASK_CHILD_NO_EXTENSIONS === "1";
  if (noDiscovery) {
    args.push("--no-extensions");
    for (const extensionPath of opts.requiredExtensions ?? []) {
      args.push("--extension", extensionPath);
    }
  }
  if (opts.fast) {
    if (!opts.fastExtensionPath) {
      throw new Error("Fast task launch requires the pi-task extension path");
    }
    args.push("--extension", opts.fastExtensionPath, "--fast");
  }
  if (agent.model) args.push("--model", agent.model);
  if (agent.thinking) args.push("--thinking", agent.thinking);
  for (const skillPath of opts.skillPaths ?? []) {
    args.push("--skill", skillPath);
  }
  args.push("--tools", allowedTools.join(","));
  args.push("--name", sessionName);
  args.push("--session-dir", sessionDir);
  if (resume) args.push("--session", opts.resumeSessionRef ?? sessionName);
  args.push(
    "--append-system-prompt",
    opts.promptLaunch?.systemPromptPath ?? agent.body,
  );
  if (!opts.promptLaunch?.deferTaskPrompt) args.push(promptContent);
  return args;
}
