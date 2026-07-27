import { Type } from "typebox";

export function taskParametersSchema() {
  return Type.Object({
    agent_type: Type.String({
      description: "The type of specialist agent to use for this task",
    }),
    prompt: Type.String({
      description:
        "The complete task for the agent to perform. Be detailed and self-contained. Include goal, non-goals, write/read policy, stop condition, and verification recipe.",
    }),
        description: Type.String({
          description: "A short (3-5 word) summary of the task",
        }),
        workspace_group: Type.Optional(Type.String({
          description: "Shared HerdR workspace group. Concurrent tasks with the same value use panes in one workspace.",
        })),
        cwd: Type.Optional(Type.String({
          description: "Absolute existing directory where a newly launched child runs. Use a parent-created Git worktree for writer isolation. Defaults to the caller cwd; resumed launches reuse their stored cwd. pi-task does not create, merge, or remove the worktree.",
        })),

    task_id: Type.Optional(
      Type.String({
        description:
          "Resume an existing background task by id instead of starting a new task.",
      }),
    ),
    conversation_id: Type.Optional(
      Type.String({
        description:
          "Durable specialist conversation id. Reuses .pi/artifacts/task-<id>/sessions when called again.",
      }),
    ),
    background: Type.Optional(
      Type.Boolean({
        description:
          "Run in background (async). You will be notified when it completes. DO NOT sleep, poll, ask the task for status, or duplicate its work while it runs in background.",
        default: true,
      }),
    ),
  });
}
