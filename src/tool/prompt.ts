import { TASK_PROMPT_INSTRUCTIONS, TASK_RESULT_XML_INSTRUCTIONS } from "../helpers.js";

export interface TaskHandoffOptions {
  prompt: string;
  parentContext?: string;
  proposedChanges?: readonly string[];
}

export interface BuildTaskPromptOptions extends TaskHandoffOptions {
  description: string;
  agentName: string;
  agentSource: string;
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
- For an audit, enumerate every proposed change and state whether it is present, absent, or inconsistent with the current code.
- If the instructions refer to proposed changes or prior decisions without stating them, report the missing handoff instead of inventing requirements.
- If required reviewer context is missing, stop and return <status>blocked</status> rather than a successful speculative audit.`;

function renderParentHandoff(options: TaskHandoffOptions): string[] {
  const parentContext = options.parentContext?.trim() || "(none supplied)";
  const proposedChanges = (options.proposedChanges ?? [])
    .map((change) => change.trim())
    .filter(Boolean);

  return [
    "## Parent context",
    parentContext,
    "",
    "## Proposed changes",
    proposedChanges.length > 0
      ? proposedChanges.map((change) => `- ${change}`).join("\n")
      : "(none supplied)",
  ];
}

export function buildTaskFollowUpPrompt(options: TaskHandoffOptions): string {
  return [
    options.prompt,
    "",
    ...renderParentHandoff(options),
    "",
    TASK_HANDOFF_INTEGRITY,
  ].join("\n");
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
    ...renderParentHandoff(options),
    "",
    TASK_WORKSPACE_SCOPE(options.cwd),
    "",
    TASK_HANDOFF_INTEGRITY,
    "",
    TASK_PROMPT_INSTRUCTIONS,
    "",
    TASK_RESULT_XML_INSTRUCTIONS,
  ].join("\n");
}
