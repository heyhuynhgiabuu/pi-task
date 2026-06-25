import { TASK_PROMPT_INSTRUCTIONS } from "../helpers.js";

export interface BuildTaskPromptOptions {
  description: string;
  agentName: string;
  agentSource: string;
  prompt: string;
  cwd: string;
}

export function buildTaskPrompt(options: BuildTaskPromptOptions): string {
  return [
    `# Task: ${options.description}`,
    "",
    "## Agent",
    `${options.agentName} (${options.agentSource})`,
    "",
    "## Instructions",
    options.prompt,
    "",
    "## Working Directory",
    options.cwd,
    "",
    TASK_PROMPT_INSTRUCTIONS,
  ].join("\n");
}
