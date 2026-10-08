/**
 * Build child CLI argv for subagent spawns (pi / Claude Code runtimes).
 */

import { fileURLToPath } from "node:url";
import type { AgentConfig } from "../helpers.js";
import { TASK_ROLE_PROMPT_FLAG } from "./child-role-prompt.js";
import {
  parseToolList,
  resolveAgentToolAllowlist,
  resolveClaudeToolPolicy,
} from "../agent-tools.js";

const DEFAULT_TASK_EXTENSION_PATH = fileURLToPath(new URL(
  import.meta.url.endsWith(".ts") ? "../index.ts" : "../index.js",
  import.meta.url,
));

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
  /** Pi-task entry loaded for child role injection and the optional fast bridge. */
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
  const explicitMcpTools = parseToolList(agent.tools).filter((tool) =>
    tool.startsWith("mcp__"),
  );
  const selectedMcpTools = allowedTools.filter((tool) =>
    tool.startsWith("mcp__") && explicitMcpTools.includes(tool),
  );
  if (noDiscovery && selectedMcpTools.length > 0) {
    throw new Error(
      "This Pi child has MCP tools selected, but extension loading is disabled; enable extension loading to use MCP.",
    );
  }
  if (opts.fast && !opts.fastExtensionPath) {
    throw new Error("Fast task launch requires the pi-task extension path");
  }
  if (noDiscovery) args.push("--no-extensions");
  const taskExtensionPath = opts.fastExtensionPath ?? DEFAULT_TASK_EXTENSION_PATH;
  args.push("--extension", taskExtensionPath);
  if (opts.fast) args.push("--fast");
  if (noDiscovery) {
    const extensions = new Set([taskExtensionPath]);
    for (const extensionPath of opts.requiredExtensions ?? []) {
      if (extensions.has(extensionPath)) continue;
      extensions.add(extensionPath);
      args.push("--extension", extensionPath);
    }
  }
  if (selectedMcpTools.length === 0) args.push("--no-mcp");
  if (agent.model) args.push("--model", agent.model);
  if (agent.thinking) args.push("--thinking", agent.thinking);
  for (const skillPath of opts.skillPaths ?? []) {
    args.push("--skill", skillPath);
  }
  args.push("--tools", allowedTools.join(","));
  args.push("--name", sessionName);
  args.push("--session-dir", sessionDir);
  if (resume) {
    if (!opts.resumeSessionRef) {
      throw new Error("Resuming a task requires a resolved session JSONL path");
    }
    args.push("--session", opts.resumeSessionRef);
  }
  // The built-in append flag replaces native APPEND_SYSTEM discovery. The child
  // extension instead layers its role after Pi has resolved cwd and trust.
  args.push(`--${TASK_ROLE_PROMPT_FLAG}=${opts.promptLaunch?.systemPromptPath ?? agent.body}`);
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
  if (opts.agent.skills?.length) {
    throw new Error(
      "Claude Code runtime does not support Pi skills; remove the agent's skills or switch the agent to the pi runtime.",
    );
  }
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
