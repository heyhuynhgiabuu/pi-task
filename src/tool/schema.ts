import { Type, type Static } from "typebox";

export function taskParametersSchema() {
  // Keep a single object at the schema root. Pi's Anthropic adapter reads
  // root-level properties/required and does not preserve a root anyOf union.
  return Type.Object({
    operation: Type.Optional(
      Type.Union([
        Type.Literal("start"),
        Type.Literal("resume"),
        Type.Literal("status"),
        Type.Literal("cancel"),
      ], {
        description: 'Optional: "start"/"resume" launch modes; "status"/"cancel" control an existing task',
      }),
    ),
    task_id: Type.Optional(
      Type.String({
        description: "Existing task id, session name, or conversation id; also used to resume a task",
      }),
    ),
    conversation_id: Type.Optional(
      Type.String({
        description: "Conversation id to resume; maps to one durable task id",
      }),
    ),
    agent_type: Type.Optional(
      Type.String({
        description: "Specialist agent type for this task",
      }),
    ),
    prompt: Type.Optional(
      Type.String({
        description:
          "Required for start requests; omitted for status/cancel controls. Self-contained: goal, scope, non-goals, write/read policy, acceptance criteria, stop condition, verification recipe, and why each reference matters. Parent reasoning in parent_context; design changes in proposed_changes.",
      }),
    ),
    parent_context: Type.Optional(
      Type.String({
        description: "Facts, decisions, and constraints the parent learned outside the referenced files. Required for reviewer tasks.",
      }),
    ),
    proposed_changes: Type.Optional(
      Type.Array(Type.String(), {
        description: "One item per proposed change: intended semantics and acceptance implication. Required and non-empty for reviewer tasks; use an explicit 'no design changes' item when none.",
      }),
    ),
    description: Type.Optional(
      Type.String({
        description: "A short (3-5 word) summary of the task",
      }),
    ),
    workspace_group: Type.Optional(Type.String({
      description: "Shared HerdR workspace group; same value = panes in one workspace.",
    })),
    cwd: Type.Optional(Type.String({
      description: "Absolute existing directory for a newly launched child; use a parent-created Git worktree for writer isolation. Defaults to caller cwd; resumes reuse stored cwd. pi-task does not create, merge, or remove worktrees.",
    })),
    fast: Type.Optional(
      Type.Boolean({
        description:
          "OpenAI/OpenAI-Codex priority service tier when the model is listed in pi-codex-fast config (fallback: built-in gpt-5.4/gpt-5.5 list). Omitted = agent frontmatter fast value, else false. No model or thinking-level change.",
      }),
    ),
    background: Type.Optional(
      Type.Boolean({
        description:
          "Run async in background (default); you'll be notified when it completes — do not sleep, poll, or duplicate its work while it runs.",
        default: true,
      }),
    ),
  });
}

export type TaskToolParameters = Static<ReturnType<typeof taskParametersSchema>>;
