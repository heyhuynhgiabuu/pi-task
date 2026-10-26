import { Type, type Static } from "typebox";
import { PI_THINKING_LEVELS } from "../thinking.js";

/**
 * The model-facing parameter surface, paid on every turn.
 *
 * The handoff contract lives here rather than in the tool description: Pi
 * validates tool arguments against `parameters` before `execute` and reports
 * the missing property by name, so `required` is enforced rather than stated.
 * `parseTaskStartRequest` covers what the schema cannot express — a stale
 * `operation`, blank strings, thinking values, the reviewer cross-field requirement.
 *
 * Deliberately absent: `operation` (start and resume are told apart by
 * `task_id`; status and cancel belong to `/task`) and `fast` (a session or
 * agent setting, so `pi --fast` and agent frontmatter carry it).
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
        "Handoff: goal, scope, non-goals, write policy, acceptance, checks. Parent-only reasoning: parent_context/proposed_changes.",
    }),
    thinking: Type.Optional(Type.String({
      description: `Thinking; frontmatter wins: ${PI_THINKING_LEVELS.join("|")}`,
    })),
    task_id: Type.Optional(
      Type.String({
        description: "Resume this task instead of starting a fresh one",
      }),
    ),
    conversation_id: Type.Optional(
      Type.String({
        description: "Start/resume a named conversation on the HerdR and tmux backends; not task_id",
      }),
    ),
    parent_context: Type.Optional(
      Type.String({
        description:
          "Parent-only facts, decisions, constraints. Required for reviewer tasks.",
      }),
    ),
    proposed_changes: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Changes + acceptance. Required non-empty for reviewer tasks; use 'no design changes' if none.",
      }),
    ),
    workspace_group: Type.Optional(Type.String({
      description: "Group HerdR panes into a shared workspace",
    })),
    cwd: Type.Optional(Type.String({
      description: "Absolute existing directory; default caller, resume uses stored cwd. No worktree creation.",
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
