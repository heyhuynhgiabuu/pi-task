/**
 * Build `pi` CLI argv for subagent spawns.
 */

import type { AgentConfig } from "../helpers.js";
import { resolveAgentToolAllowlist } from "../agent-tools.js";

export interface BuildPiArgvOptions {
  agent: AgentConfig;
  sessionName: string;
  sessionDir: string;
  promptContent: string;
  resume?: boolean;
  parentToolNames?: string[];
}

export function buildPiArgv(opts: BuildPiArgvOptions): string[] {
  const { agent, sessionName, sessionDir, promptContent, resume } = opts;

  const allowedTools = resolveAgentToolAllowlist({
    tools: agent.tools,
    disallowedTools: agent.disallowedTools,
    parentToolNames: opts.parentToolNames,
  });

  const args: string[] = [];
  if (agent.model) args.push("--model", agent.model);
  if (agent.thinking) args.push("--thinking", agent.thinking);
  args.push("--tools", allowedTools.join(","));
  args.push("--name", sessionName);
  args.push("--session-dir", sessionDir);
  if (resume) args.push("--session", sessionName);
  args.push("--append-system-prompt", agent.body);
  args.push(promptContent);
  return args;
}
