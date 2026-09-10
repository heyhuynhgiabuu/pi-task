import { Type, type Static } from "typebox";

/**
 * The model-facing parameter surface, paid on every turn.
 *
 * The handoff contract lives here rather than in the tool description: Pi
 * validates tool arguments against `parameters` before `execute` and reports
 * the missing property by name, so `required` is enforced rather than stated.
 * `parseTaskStartRequest` covers what the schema cannot express — a stale
 * `operation`, blank strings, the reviewer cross-field requirement.
 *
 * Deliberately absent: `operation` (start and resume are told apart by
 * `task_id`; status and cancel belong to `/task`) and `fast` (a user
 * preference, set by agent frontmatter or the `--fast` flag).
 *
 * `conversation_id` stays. It is not a synonym for `task_id`: the durable
 * registry is keyed by conversation, and the conversation-resume path is only
 * reachable when it is supplied.
 */
export function taskParametersSchema() {
  // Keep a single object at the schema root. Pi's Anthropic adapter reads
  // root-level properties/required and does not preserve a root anyOf union.
  return Type.Object({
    agent_type: Type.String({
      description: "Specialist agent type for this task",
    }),
    description: Type.String({
      description: "A short (3-5 words) summary of the task",
    }),
    prompt: Type.String({
      description:
        "The handoff: goal, scope, non-goals, write policy, acceptance criteria, verification recipe. Parent reasoning learned outside the referenced files goes in parent_context and proposed_changes.",
    }),
    task_id: Type.Optional(
      Type.String({
        description: "Resume this task instead of starting a fresh one",
      }),
    ),
    conversation_id: Type.Optional(
      Type.String({
        description: "Resume a durable conversation by id; it maps to one task id",
      }),
    ),
    parent_context: Type.Optional(
      Type.String({
        description:
          "Facts, decisions, and constraints the parent learned outside the referenced files. Required for reviewer tasks.",
      }),
    ),
    proposed_changes: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "One item per change: intended semantics and acceptance implication. Required non-empty for reviewer tasks; pass an explicit 'no design changes' item when there are none.",
      }),
    ),
    workspace_group: Type.Optional(Type.String({
      description: "Shared HerdR workspace group; same value = panes in one workspace",
    })),
    cwd: Type.Optional(Type.String({
      description: "Absolute existing directory for the child. pi-task does not create, merge, or remove worktrees. Defaults to the caller's; a resume reuses the stored one.",
    })),
    compare: Type.Optional(
      Type.Boolean({
        description: "Run a dual-model comparison on read-only agents",
      }),
    ),
    background: Type.Optional(
      Type.Boolean({
        description: "Run async in background; default true",
        default: true,
      }),
    ),
  });
}

export type TaskToolParameters = Static<ReturnType<typeof taskParametersSchema>>;
