import { arr, bool, num, obj, oneOf, opt, str, type Static } from "@earendil-works/pi-schema";
import { PI_THINKING_LEVELS } from "../thinking.js";

/**
 * The model-facing parameter surface, paid on every turn.
 *
 * The handoff contract lives here rather than in the tool description: Pi
 * validates tool arguments against `parameters` before `execute` and reports
 * the missing property by name, so `required` is enforced rather than stated.
 * `parseTaskStartRequest` covers what the schema cannot express — blank
 * strings and the reviewer cross-field requirement (plus direct non-schema
 * callers).
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
  return obj({
    agent_type: str({
      description: "Specialist agent type for this task",
    }),
    description: str({
      description: "A short (3-5 words) summary of the task",
    }),
    prompt: str({
      description:
        "Handoff: goal, scope, non-goals, write policy, acceptance, checks. Parent-only reasoning: parent_context/proposed_changes.",
    }),
    thinking: opt(oneOf(PI_THINKING_LEVELS, {
      description: "Thinking level; agent frontmatter wins",
    })),
    task_id: opt(
      str({
        description: "Resume this existing task instead of starting a fresh one; an unknown id is an error",
      }),
    ),
    conversation_id: opt(
      str({
        description: "Start/resume a named conversation on the HerdR and tmux backends; not task_id",
      }),
    ),
    parent_context: opt(
      str({
        description:
          "Parent-only facts, decisions, constraints. Required for reviewer tasks.",
      }),
    ),
    proposed_changes: opt(
      arr(str(), {
        description:
          "Changes + acceptance. Required non-empty for reviewer tasks; use 'no design changes' if none.",
      }),
    ),
    workspace_group: opt(str({
      description: "Group HerdR panes into a shared workspace",
    })),
    results_from: opt(
      arr(str(), {
        description:
          "Settled task ids whose results are injected into this child's prompt (same session only)",
      }),
    ),
    timeout_minutes: opt(num({
      exclusiveMinimum: 0,
      description:
        "Per-task wall-clock ceiling in minutes (overrides agent/global ceiling for durable and background terminal tasks)",
    })),
    cwd: opt(str({
      description: "Absolute existing directory; default caller, resume uses stored cwd. No worktree creation.",
    })),
    compare: opt(
      bool({
        description: "Run a dual-model comparison on read-only agents",
      }),
    ),
    background: opt(
      bool({
        description: "Run async in background; default true",
        default: true,
      }),
    ),
  });
}

export type TaskToolParameters = Static<ReturnType<typeof taskParametersSchema>>;
