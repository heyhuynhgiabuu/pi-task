import { TASK_PROMPT_INSTRUCTIONS } from "../helpers.js";

export interface TaskHandoffOptions {
  prompt: string;
  parentContext?: string;
  proposedChanges?: readonly string[];
  /**
   * Pre-rendered `results_from` section (see `formatResultInjection`). It goes
   * last, immediately before the closing instructions, because it is input the
   * child reads after its own instructions and before it starts reporting.
   */
  results?: string;
}

export interface BuildTaskPromptOptions extends TaskHandoffOptions {
  description: string;
  cwd: string;
}

const TASK_WORKSPACE_SCOPE = (cwd: string): string => `## Workspace scope

Default workspace: ${cwd}.

- Inspect and cite files under this directory by default.
- Do not search sibling repositories, home-directory projects, or unrelated workspaces unless explicitly required.
- If another absolute path is required, name it explicitly and explain why.
- For scout tasks, prefer external sources; inspect local files only when explicitly named or needed for comparison.`;

const TASK_HANDOFF_INTEGRITY = `## Handoff integrity

This task-specific message is the complete handoff from the parent agent. The parent may have read files, made decisions, or proposed changes that are not stored in the repository.

- A referenced file is evidence, not a context handoff. Do not assume reading it reconstructs the parent's reasoning.
- Before acting, extract the goal, constraints, parent-provided facts, proposed changes, and acceptance criteria into a checklist.
- For a review or audit, enumerate every proposed change and state whether it is present, absent, or inconsistent with the current code.
- If the instructions refer to proposed changes or prior decisions without stating them, report the missing handoff instead of inventing requirements.
- If context the task requires is missing, stop and report the handoff as blocked rather than performing a speculative audit.
- Honor read-only or no-side-effect constraints in the instructions; verification must not violate them.`;

function renderParentHandoff(options: TaskHandoffOptions): string[] {
  const sections: string[] = [];
  const parentContext = options.parentContext?.trim();
  if (parentContext) {
    sections.push(`## Parent context\n${parentContext}`);
  }
  const proposedChanges = (options.proposedChanges ?? [])
    .map((change) => change.trim())
    .filter(Boolean);
  if (proposedChanges.length > 0) {
    sections.push(`## Proposed changes\n${proposedChanges.map((change) => `- ${change}`).join("\n")}`);
  }
  return sections;
}

export function buildTaskFollowUpPrompt(options: TaskHandoffOptions): string {
  return [
    options.prompt,
    ...renderParentHandoff(options),
    options.results?.trim(),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function buildTaskPrompt(options: BuildTaskPromptOptions): string {
  return [
    `# Task: ${options.description}`,
    `## Instructions\n${options.prompt}`,
    ...renderParentHandoff(options),
    TASK_WORKSPACE_SCOPE(options.cwd),
    TASK_HANDOFF_INTEGRITY,
    options.results?.trim(),
    TASK_PROMPT_INSTRUCTIONS,
  ]
    .filter(Boolean)
    .join("\n\n");
}
