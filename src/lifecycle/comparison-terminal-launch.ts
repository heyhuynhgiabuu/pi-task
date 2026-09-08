import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentConfig } from "../helpers.js";
import { buildPiArgs } from "../helpers.js";
import { killAgentPane } from "../subagent/tmux.js";
import type {
  TerminalBackend,
  TerminalBackendKind,
} from "../subagent/terminalBackend.js";
import { launchTerminalTask } from "../subagent/terminal-launch.js";
import type { ComparisonTerminalTask } from "./comparison-terminal-foreground.js";

export interface ComparisonTerminalLaunchSibling {
  id: string;
  index: 0 | 1;
  model: string;
  agent: AgentConfig;
  desc: string;
  sessionName: string;
  sessionDir: string;
}

export interface ComparisonTerminalLaunchOptions {
  siblings: readonly [
    ComparisonTerminalLaunchSibling,
    ComparisonTerminalLaunchSibling,
  ];
  agentName: string;
  selectedBackend: TerminalBackendKind;
  terminalBackend: TerminalBackend;
  prompt: string;
  cwd: string;
  parentToolNames: string[];
  taskToolName: string;
  skillPaths: string[];
  fast: boolean;
  taskExtensionPath: string;
  herdrRequiredExtension?: string;
  workspaceGroup?: string;
  isBackground: boolean;
}

export async function launchComparisonTerminalTasks({
  siblings,
  agentName,
  selectedBackend,
  terminalBackend,
  prompt,
  cwd,
  parentToolNames,
  taskToolName,
  skillPaths,
  fast,
  taskExtensionPath,
  herdrRequiredExtension,
  workspaceGroup,
  isBackground,
}: ComparisonTerminalLaunchOptions): Promise<ComparisonTerminalTask[]> {
  const terminalTasks: ComparisonTerminalTask[] = [];
  try {
    for (const s of siblings) {
      const startedAt = Date.now();
      let promptLaunch: { systemPromptPath: string; deferTaskPrompt: boolean } | undefined;
      if (selectedBackend === "herdr") {
        promptLaunch = {
          systemPromptPath: join(s.sessionDir, "agent-system-prompt.md"),
          deferTaskPrompt: true,
        };
        await writeFile(promptLaunch.systemPromptPath, s.agent.body, "utf8");
      }

      const piArgs = buildPiArgs(
        s.agent,
        s.sessionName,
        s.sessionDir,
        prompt,
        false,
        parentToolNames,
        taskToolName,
        undefined,
        promptLaunch,
        skillPaths,
        fast,
        taskExtensionPath,
        herdrRequiredExtension ? [herdrRequiredExtension] : undefined,
      );

      const launched = await launchTerminalTask({
        backend: selectedBackend,
        terminalBackend,
        agentArgs: piArgs,
        initialPrompt: prompt,
        cwd,
        sessionDir: s.sessionDir,
        sessionName: s.sessionName,
        environment: { PI_TASK_TOOL_DISABLED: "1" },
        label: `${agentName}-${s.id}`,
        workspaceGroup,
        remainOnExit: !isBackground,
        selfDestruct: isBackground,
      });
      terminalTasks.push({ ...s, ...launched, startedAt });
    }
  } catch (error) {
    for (const task of terminalTasks) {
      try {
        if (task.handle.backend === "herdr") await terminalBackend.close(task.handle);
        else killAgentPane(task.paneId, task.originalPane);
      } catch {
        // Best effort cleanup of already created panes
      }
    }
    throw error;
  }
  return terminalTasks;
}
