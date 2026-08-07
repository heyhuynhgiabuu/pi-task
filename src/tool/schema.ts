import { Type } from "typebox";

export function taskParametersSchema() {
  // Keep a single object at the schema root. Pi's Anthropic adapter reads
  // root-level properties/required and does not preserve a root anyOf union.
  return Type.Object({
    operation: Type.Optional(
      Type.Union([
        Type.Literal("status"),
        Type.Literal("cancel"),
      ], {
        description: "For control requests only: inspect or cancel an existing task without starting a new subagent",
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
        description: "The type of specialist agent to use for this task",
      }),
    ),
    prompt: Type.Optional(
      Type.String({
        description:
          "Required for start requests; omitted for status/cancel controls. Be detailed and self-contained: include goal, scope, non-goals, write/read policy, acceptance criteria, stop condition, verification recipe, and why each reference matters. Put parent-only reasoning in parent_context and enumerate proposed changes in proposed_changes.",
      }),
    ),
    parent_context: Type.Optional(
      Type.String({
        description: "Facts, decisions, and constraints the parent learned outside the referenced files. Required for reviewer tasks.",
      }),
    ),
    proposed_changes: Type.Optional(
      Type.Array(Type.String(), {
        description: "One item per proposed change, including its intended semantics and acceptance implication. Required and non-empty for reviewer tasks; use an explicit 'no design changes' item when applicable.",
      }),
    ),
    description: Type.Optional(
      Type.String({
        description: "A short (3-5 word) summary of the task",
      }),
    ),
    workspace_group: Type.Optional(Type.String({
      description: "Shared HerdR workspace group. Concurrent tasks with the same value use panes in one workspace.",
    })),
    cwd: Type.Optional(Type.String({
      description: "Absolute existing directory where a newly launched child runs. Use a parent-created Git worktree for writer isolation. Defaults to the caller cwd; resumed launches reuse their stored cwd. pi-task does not create, merge, or remove the worktree.",
    })),
    background: Type.Optional(
      Type.Boolean({
        description:
          "Run in background (async). You will be notified when it completes. DO NOT sleep, poll, ask the task for status, or duplicate its work while it runs in background.",
        default: true,
      }),
    ),
  });
}
