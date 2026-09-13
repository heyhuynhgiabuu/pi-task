# @heyhuynhgiabuu/pi-task

Delegating task/subagent extension for [Pi](https://pi.dev). It adds a `task` tool that can run specialized subagents in foreground or background, show task progress in the TUI, and deliver background completion back to the parent assistant.

## Demo

![pi-task background task demo](./media/demo-background-task.webp)

_Auto-playing preview of the 89s walkthrough (1 fps): spawning a background subagent in a tmux pane, watching the live tool-call progress in the parent pane, and reading the final result via the session JSONL._

For the full high-quality 89s @ 56 fps version, [download the MP4](https://github.com/heyhuynhgiabuu/pi-task/releases/download/v0.2.0/demo-background-task.mp4).

## Features

- Foreground tasks: parent waits and receives the subagent result directly.
- Background tasks: parent continues, task widget shows progress, completion arrives as a follow-up.
- Interactive task panel below the editor: press `↓` on an empty prompt to enter the task rows, `↑/↓` to navigate, `Enter` to open a task's live transcript view, `x` to stop or dismiss, `Esc` to return to typing. Steps aside if another extension owns a custom editor.
- Live transcript view with steering: `Enter` on a task row replaces the main view with the task's running transcript (pi's native message/tool components); typing + `Enter` steers a running tmux/HerdR task, `PageUp`/`PageDown` scroll, `Esc` returns. SDK children show live tool activity (no session JSONL) and cannot be steered from the panel.
- Delivery guards: a background result is never delivered into a different conversation or `/tree` branch; it stays recoverable in task-session history and the child session file.
- Tmux backend for observable subagent panes.
- HerdR and tmux terminal backends, with SDK fallback when neither is available.
- Agent frontmatter support: `model`, `thinking`, `fast`, `skills`, `tools`, `disallowed_tools`.
- Per-call thinking control: an optional task `thinking` value uses Pi's canonical levels when the agent leaves `thinking` unset; frontmatter remains authoritative when present.
- Task-local OpenAI/OpenAI-Codex Fast Mode: apply priority service tier to configured models without changing model, thinking level, or shared configuration.
- Built-in starter agents: `scout`, `explore`, `general`, `reviewer`.
- Project/user agent overrides via `.pi/agents/*.md` or `~/.pi/agent/agents/*.md`.

## Install

```bash
pi install npm:@heyhuynhgiabuu/pi-task
```

Latest release: https://github.com/heyhuynhgiabuu/pi-task/releases/latest

Or load locally:

`pi -e ./src/index.ts`

Restart Pi after installing or changing extension config.

## Usage

The handoff contract lives in the `task` schema. Pi validates tool arguments against `parameters` before the tool runs and reports the missing property by name, so `agent_type`, `description`, and `prompt` are enforced rather than merely stated. Runtime validation is the second layer for what the schema cannot express: a stale `operation`, blank strings, thinking values, and the reviewer cross-field requirement. `prompt` carries:

- goal: the exact outcome wanted
- scope and references: what to inspect, why each reference matters, and the base/diff to review; paths are evidence, not context handoff
- non-goals: what to avoid or leave untouched
- write/read policy: whether the child may edit or must stay read-only
- acceptance criteria and stop condition: observable conditions that must be true before stopping
- verification recipe: checks to run or evidence to gather

Parent reasoning that lives outside the referenced files goes in `parent_context` and `proposed_changes` rather than in `prompt`.

An optional `thinking` task parameter accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Agent frontmatter wins; the call-level value applies only when the selected agent omits `thinking`. The resolved value is forwarded through Pi, SDK, Claude Code, and comparison launches.

Fast Mode is optional and driven by one flag: `pi --fast` applies the priority service tier to the session's own model calls and to every child it delegates to. An agent's `fast: true` or `fast: false` frontmatter overrides it for that agent; behavior defaults to `false`. The main `dist/index.js` entry installs the parent-side bridge after startup and also handles isolated terminal children. Load only one extension that owns `--fast`; Pi reports a conflict when pi-task and another fast-mode extension such as pi-codex-fast are enabled together.

```json
{
  "agent_type": "general",
  "description": "Implement focused fix",
  "background": false,
  "prompt": "Goal: implement the bounded fix. Non-goals: do not change the model or thinking level. Write/read policy: edit only the requested files. Acceptance criteria: tests pass. Stop condition: the fix is verified. Verification: run the focused tests."
}
```

When effective Fast Mode is enabled, a configured OpenAI or OpenAI-Codex child uses `serviceTier: "priority"` when its model is listed in `pi-codex-fast.json` under the Pi agent directory. The config's `enabled` value is not consulted, and pi-task never writes the file. If that file is missing or invalid, the built-in fallback list applies: `openai/gpt-5.4`, `openai/gpt-5.5`, `openai-codex/gpt-5.4`, `openai-codex/gpt-5.5`, `openai-codex/gpt-5.6-luna`. Unsupported or unlisted models use their normal streamer. Terminal children use an isolated provider bridge; SDK children inject the same bridge while keeping normal extension discovery disabled.

A reviewer request with missing parent_context or proposed_changes is rejected. If there are no design changes, pass an explicit item such as “No proposed design changes; assess the implementation against the stated goal.”

Foreground task:

```json
{
  "agent_type": "explore",
  "description": "Find auth flow",
  "background": false,
  "parent_context": "No parent-only context; map current repository behavior.",
  "proposed_changes": ["No proposed design changes; document current behavior only."],
  "prompt": "Goal: map the auth flow. Scope: auth entrypoints, middleware, and session issuance. Non-goals: do not edit files. Write/read policy: read-only. Acceptance criteria: return file:line evidence for each mapped path. Stop condition: the flow is mapped. Verification: return file:line evidence. References: inspect the repository under the working directory."
}
```

Background task:

```json
{
  "agent_type": "scout",
  "description": "Research SDK docs",
  "background": true,
  "parent_context": "The parent needs version-matched official guidance, not an implementation.",
  "proposed_changes": ["No proposed design changes; return research only."],
  "prompt": "Goal: research the latest Pi SDK extension APIs. Scope: official documentation and version-matched examples. Non-goals: no code changes. Write/read policy: read-only. Acceptance criteria: summarize the relevant APIs with citations. Stop condition: official docs and key APIs are summarized. Verification: cite official docs. References: explain why each source matters."
}
```

Durable specialist conversation:

```
{
  "agent_type": "scout",
  "conversation_id": "research-ai",
  "description": "Ask research assistant",
  "background": false,
  "prompt": "Continue our prior research thread. What did we conclude about retrieval evaluation?"
}
```

`conversation_id` maps to a durable subagent run. Reused across calls to keep specialist memory, e.g. a reusable research assistant. Use `/task` to list known durable conversations.

        Stored files:

        ```
        .pi/artifacts/task-sessions.json          # conversation_id -> { task_id }
        .pi/artifacts/sessions/<task-id>/*.jsonl  # subagent session transcript/result
        .pi/task-registry.json                    # active background tasks
        .pi/task-session-history.json             # task status and session metadata
        ```

        The subagent's final assistant message in the task JSONL session is
        the result; no separate result file is required.

    Note: true conversation resume requires the tmux/CLI backend so Pi can reopen the saved subagent session. SDK fallback can run foreground or background one-shot tasks, but it cannot resume a prior Pi session.

    A foreground (`background: false`) task result names its durable task id in the model-visible content (`Task ID: <id> — pass as task_id to resume this session.`), so the parent can resume the same session instead of repeating discovery. Pi terminal runs reopen the saved session; SDK and Claude Code runs report that session resume is unavailable and use the id for status and transcript review. Tool-call and result rows label the mode (`sync`/`async`).

If Pi restarts while background tasks are still running, pi-task restores them on startup. Treat restored tasks as still in flight: do not relaunch overlapping work unless you intentionally want a second competing run. An active background task cannot be converted into a foreground relaunch; steer it in background mode or wait for completion. Use `/task` to inspect what was restored before taking action.

### Task control

Control is a user action, so it lives on the `/task` command rather than on the model-facing tool:

```
/task              # list durable conversations (also /task list)
/task status <task-id-or-conversation-id>
/task cancel <task-id-or-conversation-id>
```

`status` is read-only and resolves by task id, session name, or conversation id. Its structured details include lifecycle timestamps, elapsed milliseconds, runtime/session metadata, available transcript turn/tool counts, persisted result diagnostics, and a verified terminal exit code when an exit sentinel exists. `cancel` only closes a live task-owned tmux or strongly-identified HerdR resource and persists `cancelled` before cleanup. If cleanup fails, it reports `cleanup_pending` and keeps a durable retry receipt for the next restore. SDK background cancellation is reported as unsupported because the SDK backend currently does not retain a durable cancellation handle.

A start/resume request that is missing a required field returns a targeted reason naming each one (for example `prompt must be a string; description must be a string`) instead of one generic message. A payload that still carries `operation` is rejected as an invalid start request, so a stale control call cannot launch work.

## Agent precedence

When two agents have the same name, later sources override earlier ones:

1. bundled agents from this package
2. user agents: `~/.pi/agent/agents/*.md`
3. project agents: `.pi/agents/*.md`

## Agent frontmatter

```md
---
description: Local read-only code explorer
model: opencode-go/deepseek-v4-flash
thinking: off
readonly: true
skills: memory, verification-before-completion
# hidden: true      # omit from task tool catalog; block invoke
# proactive: true   # listed in proactive delegation block on task tool
tools: read, grep, find, ls
disallowed_tools: edit, write
---

# Agent instructions
```

Pi has one session parent agent; all `*.md` agents under `agents/` are **task subagents** only. pi-task always appends the agent Markdown body to the child system prompt; `prompt_mode` is not a supported frontmatter field. Use `hidden` for internal/orchestration-only agents.

`skills:` is a comma-separated list of native Pi skill names. pi-task resolves each name against Pi's skill registry and passes the resulting file path through repeatable `--skill` flags to Pi terminal children; SDK children receive the same explicit skill paths. Claude Code terminal children do not support Pi skill paths, so declaring `skills:` for a Claude runtime fails the launch instead of silently dropping the skill. An unknown declared skill fails the task instead of silently dropping the skill. Skill loading remains progressive: the child may need to read or invoke the declared skill to load its full instructions.

`tools:` is an explicit allowlist. If omitted, pi-task starts from the tools actually registered in the parent Pi session, then removes `disallowed_tools`. `readonly: true` always adds write/edit/apply_patch to the deny list, even when `tools:` is explicit. It does **not** deny `bash` for ordinary tasks; use explicit `tools:` or `disallowed_tools: bash` when an agent must not run shell. Recursive `task` delegation is always blocked.

For `compare: true`, the effective allowlist must contain only known non-mutating tools. `bash`, write/edit/apply_patch, and unknown extension tools are rejected even when `readonly: true`; use an explicit list such as `tools: read, grep, find, ls` for a comparable read-only agent.

If Pi restarts while a background comparison is still running, recovery rebuilds the group from durable records and replays the grouped report into the session that loads the extension after the restart (the new session), not the one that launched it. The report is delivered at most once per group; an already-delivered group is marked in `task-session-history.json` and never replayed.

Bundled agents in `agents/`: `explore`, `scout`, `general`, `reviewer`. They declare role-specific native skills and defer model selection to the current Pi session; a user or project agent can set `model:` explicitly. Those declared skills must be installed in Pi's skill registry. `readonly` blocks mutating tools (write/edit/apply_patch), not `bash` outside comparison mode.

When the child must actually run in another checkout, pass its absolute existing directory as `cwd`; otherwise the child inherits the caller cwd. For a mutating parallel task, the parent creates a Git worktree first, passes that worktree as `cwd`, then reviews, merges, and removes it after the task finishes. pi-task never creates, merges, or removes worktrees, and `workspace_group` only groups HerdR terminals—it is not filesystem isolation.

```json
{
  "agent_type": "general",
  "description": "Implement isolated fix",
  "cwd": "/absolute/path/to/repo-fix-worktree",
  "prompt": "Implement and verify the bounded fix. Do not edit parent-owned artifacts."
}
```

## Orchestration patterns with one tool

You do not need a separate orchestration tool for most work. Keep `task` as the only primitive and express orchestration in the prompt and calling pattern.

- Fan-out and synthesize: launch several read-only tasks in one message, then run one reviewer/synthesizer task after they complete.
- Adversarial verification: pair a producer task with a separate skeptic/verifier task using the same rubric.
- Tournament/ranking: spawn multiple candidate-producing tasks, then one comparator task that ranks them pairwise.
- Loop until done: rerun a narrowly scoped task with an explicit stop condition like "no new findings for two rounds" or "no remaining failing checks".

Keep the parent responsible for orchestration decisions and final verification. The child tasks do the work; the parent should not duplicate it while they run. Prefer improving prompts and reviewer patterns before inventing a second orchestration tool.

## Environment

| Variable | Effect |
|----------|--------|
| `PI_TASK_CHILD_NO_EXTENSIONS=1` | Child `pi` runs with `--no-extensions` (fewer startup failures in tmux subagents). |
| `PI_SUBAGENT_FORWARD_<NAME>` | Opt-in environment forwarding for terminal subagents. The child receives `<NAME>` without the `PI_SUBAGENT_FORWARD_` prefix; ordinary parent variables are not copied. |
| `PI_TASK_SUBAGENT_FORWARD_PREFIXES` | Optional comma-separated forwarding prefixes, defaulting to `PI_SUBAGENT_FORWARD_`. Prefixes must match `[A-Z][A-Z0-9_]*`; the longest matching prefix wins. An invalid configured prefix rejects the terminal launch. |
| `PI_TASK_COMPLETION_DELIVERY` | Background completion delivery: `followUp` (default) queues a dedicated model turn so a completion does not interrupt the parent's current reasoning; `steer` is an explicit opt-in that injects the result into the current turn while streaming; `nextTurn` queues the completion for your next prompt. Completion notifications settling within a short window are debounced. Queued messages are in-memory only and task-session history keeps the recovery pointer. Requires Pi 0.32+ (`nextTurn`: 0.34+). |
| `PI_TASK_POLL_MS` | Background poll interval (default 2000). |
| `PI_TASK_BACKEND` | `auto` (default), `herdr`, `tmux`, or `sdk`. `auto` prefers HerdR only when Pi is already running inside an active HerdR pane, then tmux, then SDK. |
| `PI_TASK_TOOL_NAME` | Delegation tool name, default `task`. Set `Agent` to align with Claude Code's native subagent tool name. Use a unique valid tool name. |
| `PI_TASK_TMUX_SPLIT` | Tmux pane orientation: `auto` (default), `horizontal` (side-by-side), or `vertical` (top/bottom). Auto uses a horizontal split when pane width is at least twice its height; otherwise it uses a vertical split. |

Environment forwarding applies only to tmux and HerdR launches, and values are captured when each child starts; changing the parent environment does not update an existing child. Invalid target names are ignored with a name-only diagnostic. Duplicate or overlapping prefixes use deterministic precedence and emit diagnostics without values. The required `PI_TASK_TOOL_DISABLED=1` child control always wins over a forwarded collision. Forwarded values are not secret-safe: HerdR passes them through CLI arguments and tmux stores them in the per-task launch script. SDK subagents are in-process, see the parent's raw environment, and do not receive a stripped per-child environment snapshot.

For HerdR, install and launch HerdR 0.7.5 or later separately, then start Pi inside a managed pane. pi-task requires `HERDR_ENV=1`, `HERDR_PANE_ID`, and an absolute `HERDR_SOCKET_PATH`; it never starts or installs HerdR. HerdR 0.7.5 requires topology to be created separately, so pi-task creates an unfocused pane before starting Pi through `herdr agent start`. A `workspace_group` creates a dedicated shared workspace; otherwise the task starts in an unfocused sibling pane in the caller's tab. `herdr integration install pi` is optional and improves lifecycle labels, but task completion still comes from Pi session JSONL. Persisted tasks validate both the socket path and HerdR terminal identity before reading, steering, or closing a pane.

### Background task failed with "Subagent pane exited"

That means the tmux pane died before a session JSONL result was available — not necessarily a tmux bug. The parent message should include session dir status and a **pane capture** when possible. Check the `task-*` split pane for extension load errors; try `PI_TASK_CHILD_NO_EXTENSIONS=1` or `background: false` for one-shot review.

## Development

```bash
npm install
npm run typecheck
npm test
npm run cost    # model-visible task surface budget, in tokens
npm run smoke   # requires `pi` on PATH; checks peer version
npm run build
npm pack --dry-run
```

## Notes

- Tmux is recommended for interactive observability.
- In non-tmux/headless environments, pi-task falls back to the Pi SDK backend.
- Treat subagent results as untrusted until you read artifacts/files and verify claims.
