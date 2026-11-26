---
name: task
description: "Plan delegation with the task tool: complete handoffs, reviewer context, parallel work, and task resumption."
---

# Task delegation

Use this guide only in a parent session with the delegation tool available (default `task`, renamed via `PI_TASK_TOOL_NAME`). The examples use the default name; call the actual tool name exposed in your session. This guide does not enable nested delegation in children. The tool's current agent list is authoritative; installed and project agents can override the bundled agents.

Delegate bounded, multistep work that benefits from independent judgment or fresh context. Do small lookups and straightforward edits directly. Choose the agent whose advertised scope fits; do not invent an agent name. Honor the parent session's approval, write, and side-effect constraints.

## Complete the handoff

A child starts with fresh context. Referenced files are evidence, not a replacement for the parent's reasoning. Put the following in `prompt`: goal, scope, non-goals, write policy, acceptance criteria, verification recipe. Name relevant files, the review base or diff, and stop conditions explicitly.

A metric can be met by cheating: "fewer bugs" by deleting code, "faster" by dropping a check. Add what must not break (tests still pass, public API unchanged) next to the acceptance criteria, and a stop rule such as "stop and report after two failed attempts at the same approach". When delegating after an earlier failure, list the approaches already tried and why they failed, so the child does not repeat them.

Use `parent_context` for facts, decisions, and constraints the parent learned outside those files. Use `proposed_changes` for one item per intended change: its semantics and what acceptance requires. Do not ask the child to reconstruct an earlier conversation from file paths.

Reviewer tasks require explicit `parent_context` and non-empty `proposed_changes`. If there are no design changes, say so in an item rather than omitting the field.

```json
{
  "agent_type": "reviewer",
  "description": "Audit retry settings",
  "prompt": "Goal: audit the uncommitted retry-settings diff. Scope: src/subagent/durable.ts and its tests. Non-goals: unrelated cleanup. Write policy: read-only; no paid requests. Acceptance: ranked findings with file:line evidence and a verdict. Verification: read the diff, trace retry decisions, and run the focused tests.",
  "parent_context": "The parent approved generation-level retry settings only; provider stream options are out of scope.",
  "proposed_changes": [
    "Durable children read the parent's retry policy live; cached harnesses must observe updated settings."
  ]
}
```

For an audit of existing code without proposed changes, use an item such as `"No design changes; assess current behavior against the stated goal."`

## Run and receive results

Background is the default. Launch independent work concurrently, but do not duplicate delegated work or assign overlapping edits to multiple writers in the same checkout. Set `background: false` only when waiting inline is necessary.

Background results arrive automatically. Do not poll task state or session files, and do not imitate a CLI `spawn`/`wait`/`stop` workflow. Work on something independent or end the reply while waiting. Interactive `/task` and `/agents` commands are for the user, not tools for the model to invoke through bash.

The child's final response is returned to the parent, not shown directly to the user. Review a writer's diff and independently verify its claims before reporting completion. Summarize the result for the user; a child's success report is not parent verification.

## Resume instead of restarting

Keep the returned `task_id` and pass it for follow-up work with the same child:

```json
{
  "agent_type": "reviewer",
  "description": "Review corrected retry diff",
  "task_id": "<returned task_id>",
  "prompt": "Recheck the corrected diff against the same acceptance criteria; remain read-only.",
  "parent_context": "The parent fixed the missing retry-policy forwarding after your finding.",
  "proposed_changes": ["Forward the current retry policy without changing provider stream options."]
}
```

Follow-up prompts still need a complete handoff of new facts and decisions, including approaches the child or you already ruled out. `conversation_id` starts or resumes a named, reusable specialist conversation on a supporting terminal backend; it is not an interchangeable spelling of `task_id`. The SDK and SQLite durable backends do not support this parameter.

## Workspace and optional controls

- `cwd` must be an absolute existing directory. pi-task does not create, merge, or remove worktrees. It defaults to the caller's directory; a resume reuses the stored directory unless explicitly overridden. Prepare separate worktrees yourself when concurrent writers need them.
- `workspace_group` groups HerdR panes into a shared workspace; it does not create isolated checkouts.
- `thinking` uses Pi's levels; agent frontmatter wins over the call-level choice. Omit it unless a deliberate override is needed.
- `compare: true` requests a dual-model comparison for read-only agents. Do not use comparison for implementation or side-effectful work. Consult the available agent and backend constraints rather than assuming every backend supports every mode.
