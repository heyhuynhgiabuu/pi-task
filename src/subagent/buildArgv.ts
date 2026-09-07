/**
 * Build child CLI argv for subagent spawns (pi / Claude Code runtimes).
 */

import type { AgentConfig } from "../helpers.js";
import {
  resolveAgentToolAllowlist,
  resolveClaudeToolPolicy,
} from "../agent-tools.js";

export type ChildRuntime = "pi" | "claude";

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

export interface BuildClaudeArgsOptions {
  agent: AgentConfig;
  /** Pinned Claude Code session id (UUID); the transcript is <id>.jsonl. */
  sessionId: string;
  promptContent: string;
  deferTaskPrompt?: boolean;
}

/**
 * Build `claude` CLI arguments. Flags first, optional positional prompt last
 * (Claude Code treats the first positional argument as the initial prompt).
 */
export function buildClaudeArgs(opts: BuildClaudeArgsOptions): string[] {
  const args: string[] = [];
  // Tool policy is translated per runtime: explicit tools/disallowed_tools map
  // onto --tools/--disallowedTools (unmappable names throw); readonly: true
  // enforces a read-only surface so bypassPermissions grants no escape.
  const policy = resolveClaudeToolPolicy({
    tools: opts.agent.tools,
    disallowedTools: opts.agent.disallowedTools,
    readonly: opts.agent.readonly,
  });
  if (policy.tools !== "default") args.push("--tools", policy.tools);
  if (policy.disallowedTools) {
    args.push("--disallowedTools", policy.disallowedTools);
  }
  const permissionMode = opts.agent.permissionMode?.trim();
  if (permissionMode) args.push("--permission-mode", permissionMode);
  if (opts.agent.model) args.push("--model", opts.agent.model);
  // pi thinking levels map onto claude effort: off/medium -> low, high -> high,
  // max/xhigh -> max. Only claude-recognized values are forwarded.
  const effort = effortFromThinking(opts.agent.thinking);
  if (effort) args.push("--effort", effort);
  args.push("--session-id", opts.sessionId);
  if (!opts.deferTaskPrompt) args.push(opts.promptContent);
  return args;
}

function effortFromThinking(
  thinking: string | undefined,
): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  const value = thinking?.trim().toLowerCase();
  if (!value) return undefined;
  if (value === "off" || value === "minimal") return "low";
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max") {
    return value as "low" | "medium" | "high" | "xhigh" | "max";
  }
  return undefined;
}

/** Route child argv construction by agent runtime (default: pi). */
export function buildChildArgs(
  agent: AgentConfig,
  opts: BuildPiArgvOptions & BuildClaudeArgsOptions,
): string[] {
  if (agent.runtime === "claude") {
    const { sessionId, deferTaskPrompt } = opts;
    return buildClaudeArgs({ agent, sessionId, promptContent: opts.promptContent, deferTaskPrompt });
  }
  const {
    agent: _agent,
    sessionId: _sessionId,
    deferTaskPrompt: _deferTaskPrompt,
    ...piOpts
  } = opts;
  return buildPiArgv({ ...piOpts, agent });
}
