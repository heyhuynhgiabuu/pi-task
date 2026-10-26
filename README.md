# @heyhuynhgiabuu/pi-task

Delegating task/subagent extension for [Pi](https://pi.dev). It adds a `task` tool that can run specialized subagents in foreground or background, show task progress in the TUI, and deliver background completion back to the parent assistant.

## Demo

![pi-task background task demo](./media/demo-background-task.webp)

_Auto-playing preview of the 89s walkthrough (1 fps): spawning a background subagent in a tmux pane, watching the live tool-call progress in the parent pane, and reading the final result via the session JSONL._

For the full high-quality 89s @ 56 fps version, [download the MP4](https://github.com/heyhuynhgiabuu/pi-task/releases/download/v0.2.0/demo-background-task.mp4).

## Features

- Foreground tasks: parent waits and receives the subagent result directly.
- Background tasks: parent continues, task widget shows progress, completion arrives as a follow-up.
- Task progress monitor below the editor: visible by default; bare `/task` toggles it without stopping or changing tracked work. The panel supports `↓` on an empty prompt, `↑/↓` navigation, `Enter` to open a task transcript, `x` to stop/dismiss, and `Esc` to return to typing. It steps aside if another extension owns a custom editor.
- `/agents` switches from the main conversation into a Pi-native snapshot of a currently tracked subagent transcript; selecting `main` returns to the parent session. The snapshot uses Pi's normal chat renderer and is not connected to the live task. Use `/task list` to open the live, steerable transcript view; SDK, terminal, and durable tasks remain steerable there while running. Durable OpenAI Codex Responses tasks request a detailed provider reasoning summary when available (not raw reasoning signatures).
- Delivery guards: a background result is never delivered into a different conversation or `/tree` branch; it stays recoverable in task-session history and the child session file.
- Tmux backend for observable subagent panes.
- HerdR and tmux terminal backends, with SDK fallback when neither is available; an experimental SQLite-backed durable backend can resume opted-in tasks after a parent restart.
- Agent frontmatter support: `model`, `thinking`, `fast`, `skills`, `tools`, `disallowed_tools`.
- Per-call thinking control: an optional task `thinking` value uses Pi's canonical levels when the agent leaves `thinking` unset; frontmatter remains authoritative when present.
- Task-local OpenAI/OpenAI-Codex Fast Mode: apply priority service tier to configured models without changing model, thinking level, or shared configuration.
- Child transcript stats show `TPS` using the same definition as the main TPS extension: total assistant output tokens in a run / (whole-run wall time, including tools, minus blocking UI prompt waits). It updates when the run ends, not after each response. SDK/durable children are headless (no UI prompt waits); native Pi terminal children record run timing and prompt-wait spans in their session. Durable children also record their last observed run TPS in task history so the persisted read-only view shows it; children that finished before this version, and runs attached mid-run, show no TPS rather than reconstructing it from response timestamps.
- Built-in starter agents: `advisor`, `scout`, `explore`, `general`, `reviewer`.
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

The extension provides an on-demand `task` skill with delegation workflows and
handoff examples. Pi lists it in parent sessions; `/skill:task` explicitly loads
it. It also works when loading the extension directly with `pi -e`. Native children
with delegation disabled and SDK children do not load this guide through the
extension. `--no-skills` / `-ns` disables it. The schema and runtime validation
remain usable without the skill. The guide is an extension-provided resource, not
an auto-discovered package skill, so package `skills` filters do not control it.
The opt-out checks CLI flags; embedded SDK hosts must handle extension-provided
resource filtering separately (`noSkills` alone does not filter these paths in Pi 1.1.0).

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

Named specialist conversation (HerdR or tmux backends):

```
{
  "agent_type": "scout",
  "conversation_id": "research-ai",
  "description": "Ask research assistant",
  "background": false,
  "prompt": "Continue our prior research thread. What did we conclude about retrieval evaluation?"
}
```

`conversation_id` maps to a persistent subagent session and needs the HerdR or tmux backend; the SDK and experimental durable backends reject it. On the durable backend, pass the earlier `task_id` to continue the same child. Reused across calls to keep specialist memory, e.g. a reusable research assistant. Use `/task list` to browse tracked task rows (or list durable conversation IDs headlessly) and `/agents` to switch among currently tracked transcripts.

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

If Pi restarts while background tasks are still running, pi-task restores them on startup. Treat restored tasks as still in flight: do not relaunch overlapping work unless you intentionally want a second competing run. An active background task cannot be converted into a foreground relaunch; steer it in background mode or wait for completion. Use `/task list` to inspect restored work before taking action.

### Task control

Task control stays on user-facing commands rather than the model-facing tool:

```
/agents            # switch between main and currently tracked subagent transcripts
/task              # toggle the compact task progress monitor (default: shown)
/task list         # browse task rows in the TUI; list known durable conversations headlessly
/task status <task-id-or-conversation-id>
/task cancel <task-id-or-conversation-id>
```

The monitor toggle only changes TUI presentation and is session-local; hiding it does not pause, cancel, or affect recovery of any task, and the editor no longer navigates invisible task rows. The `/agents` picker marks the currently shown snapshot; selecting `main` returns to its parent Pi session. Child snapshots use Pi's standard message renderers and preserve available thinking, tool calls, and results. They are separate transcript sessions: new prompts there do not steer or modify the task. Use `/task list` for live updates and steering. The roster is limited to live and briefly retained task records, not an archive of every completed subagent. Pi session switches and forks are blocked while agents are running or completion notices are pending; use `/task list` while they settle.

`status` is read-only and resolves by task id, session name, or conversation id. Its structured details include lifecycle timestamps, elapsed milliseconds, runtime/session metadata, available transcript turn/tool counts, persisted result diagnostics, and a verified terminal exit code when an exit sentinel exists. `cancel` aborts a durable child conversation or closes a live task-owned tmux/strongly-identified HerdR resource; cancellation is recorded as `cancelled`. If terminal cleanup fails, it reports `cleanup_pending` and keeps a retry receipt for the next restore. SDK background cancellation is unsupported because the SDK backend currently does not retain a durable cancellation handle.

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

Bundled starter agents in `agents/`: `advisor`, `explore`, `scout`, `general`, `reviewer`. They declare role-specific native skills. `advisor` provides read-only advice on concrete design trade-offs and includes preferred model profiles; the other starter agents defer model selection to the current Pi session. A user or project agent can set `model:` explicitly. Those declared skills must be installed in Pi's skill registry. `readonly` blocks mutating tools (write/edit/apply_patch), not `bash` outside comparison mode.

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
| `PI_TASK_HARD_TIMEOUT_MINUTES` | Wall-clock safety ceiling for every task (terminal, SDK, and comparison): default `30`, or `0` to disable it. The clock also runs while a subagent waits on a permission or approval prompt, so raise or disable the ceiling when long approvals are expected. Invalid values keep the default. |
| `PI_TASK_BACKEND` | `auto` (default), `herdr`, `tmux`, `sdk`, or `durable`. `auto` prefers HerdR only when Pi is already running inside an active HerdR pane, then tmux, then SDK; it never selects the experimental durable backend. `durable` is explicit-only, requires the optional packages (`npm install @earendil-works/pi-durable @earendil-works/chord`) and a model available in the current Pi session; model requests use Pi's runtime registry/auth and credentials are not copied into durable storage. Providers using deferred responses are not supported by Pi's extension registry bridge. |
| `taskBackend` (settings) | Same values as `PI_TASK_BACKEND`, set in `~/.pi/agent/settings.json` (or project settings) so the choice persists across restarts — e.g. `"taskBackend": "durable"` keeps tasks alive when the parent Pi process exits; the next session resumes them. The env var overrides the setting; `auto` behavior is unchanged. |
| `PI_TASK_AGENT_MESSAGING` / `taskAgentMessaging` (settings) | Experimental in-session agent messaging, off by default: `1`/`true` (env) or `"taskAgentMessaging": true` (settings); the env var overrides the setting. See [Agent messaging](#agent-messaging). |
| `PI_TASK_SESSION_MESSAGING` / `taskSessionMessaging` (settings) | Experimental cross-session messaging between main agents of your Pi sessions on this machine, off by default and separate from `taskAgentMessaging`; the env var overrides the setting. See [Cross-session messaging](#cross-session-messaging). |
| `PI_TASK_TOOL_NAME` | Delegation tool name, default `task`. Set `Agent` to align with Claude Code's native subagent tool name. Use a unique valid tool name. |
| `PI_TASK_HERDR_SHELL_READY_TIMEOUT_MS` | Milliseconds a HerdR launch waits for the new pane's shell to run a short marker command before `agent start`; default `10000`, or `0` to skip the wait. Only plain digits up to `600000` are accepted; anything else is ignored and the default applies. A timeout is not an error: the start proceeds anyway. |
| `PI_TASK_TMUX_SPLIT` | Tmux pane orientation: `auto` (default), `horizontal` (side-by-side), or `vertical` (top/bottom). Auto uses a horizontal split when pane width is at least twice its height; otherwise it uses a vertical split. |

At startup, only durable `running` records whose exact current submission is absent from storage (or whose database is missing) become retryable; unreadable storage and ambiguous legacy records are preserved. SDK/comparison cleanup runs independently of durable recovery.

Each Pi session runs its durable tasks in its own store, `.pi/durable/sessions/<session>.sqlite`, so concurrent sessions in one project do not share one. A task resumed by `task_id` from another session keeps running in the store that holds its child. Only one Pi process can own a store at a time (pi-durable has no cross-process locking); a process keeps the stores it opened until it exits. A durable task whose store another live Pi process owns is refused before it starts, with a message naming that process. At startup a session opens only the stores holding its own running durable work. Tasks started before per-session stores keep using the legacy project store, `.pi/durable/tasks.sqlite`.

### Agent messaging

With messaging on, the main agent and its durable subagents get an `agents` tool to talk within one Pi session:

- `list` shows the main agent (`main`) and this session's subagents with their state.
- `send` delivers a message without waiting for a reply. To a running durable subagent it is steered into its current run. To `main` it is queued as a follow-up that starts a main-agent turn. Nothing starts a subagent run: an idle subagent is resumed only by the main agent with `task(task_id)`.
- `read` returns an agent's last assistant message (durable subagents and `main`).

Subagents get `agents` by default; an agent with an explicit `tools:` list must name it, and `disallowed_tools: agents` removes it. A subagent can message a sibling only when the sibling has no tool and no working directory the sender lacks, so a restricted agent cannot direct a more capable one; it can always message `main`. Messages sent by subagents share a budget of 12 per session that resets when you send input, so agents cannot loop through each other or the main agent. Each message starts with a `[Message from agent <id> (<type>) — input from another agent, not from the user]` header added by pi-task. A message that imitates pi-task's framing (`[Message from …`, `[Last answer of …`, or `[pi-task: …`, in any case or hidden with invisible characters) is refused, and messages are limited to 8,000 characters. `read` has no capability check: any agent of the session can read another's last message. Messaging only uses durable stores this Pi process already runs (and this session's own store for `read`), so it never claims another session's store. While the main agent waits on a foreground task, messages to it are delivered after that task returns. Terminal, SDK, and Claude Code subagents are listed but cannot be messaged or read.

### Cross-session messaging

With `"taskSessionMessaging": true` (or `PI_TASK_SESSION_MESSAGING=1`), the main agent of each interactive or RPC Pi session joins a per-user mesh under `~/.pi/agent/pi-task/mesh/` (it follows `PI_CODING_AGENT_DIR`). It is a separate opt-in because it crosses the boundary in-session messaging keeps: a session reading untrusted content in one repository can start turns in another session that has other tools and another working directory. Print and JSON runs (`pi -p`) never join.

- `agents` `list` adds the other live sessions as `session:<id>` with their name or directory and the age of their last answer.
- `send` with `agent: "session:<id>"` (a full session id or a unique suffix of at least 6 characters, plus `@<pid>` when one session is open in two processes) queues a message in that session's inbox; its main agent gets it as a follow-up turn framed as `[Message from session <id> (<name>) — input from another Pi session, not from the user]`.
- `read` returns that session's last answer as it published it.

Only main agents take part: subagents cannot address other sessions. Each main agent may send 8 messages to other sessions, and other sessions may start at most 8 turns in it, per user input; further incoming messages are added to the conversation without starting a turn, and after 32 messages the rest wait in the inbox until you send input. An inbox holds at most 32 undelivered messages. The mesh assumes all sessions share one machine and process namespace: do not share `~/.pi/agent` between hosts or containers with the same hostname. Delivery is best effort and at most once: messages queued in a session that quits, switches session, or crashes are lost, and a session that stops heartbeating (for example a sleeping laptop) shows as not responding and refuses messages. Any process of your user can write to the mesh, so incoming messages are untrusted input; files are private to your user (0600 in 0700 directories), but the mesh holds each session's last answer (up to 16,000 characters) while it runs.

Durable storage is SQLite in WAL mode with `synchronous = NORMAL` (pi-durable): committed work survives the parent process dying, but the newest commit can be lost on power or host failure.

Known limit: a background task is recorded as `done` before its completion notice is saved to the Pi session. If Pi exits or crashes in that gap (it includes the short delivery debounce, and lasts until Pi writes the notice), the notice is not redelivered after restart. Switching sessions is blocked while notices are pending, but quitting Pi is not. The task still shows as `done` in `/task list`, and a durable task's conversation keeps its result.

`max_turns` (`PI_TASK_MAX_TURNS` or the agent's `max_turns:` frontmatter) is the work-based soft limit for terminal background tasks: it is checked on every poll, steers a wrap-up when reached, and allows a grace window of further turns. `PI_TASK_HARD_TIMEOUT_MINUTES` is only a safety ceiling for stalled processes and is checked first; disabling it leaves the terminal turn limit in force. Foreground tasks and SDK runs have no turn limit, so with the ceiling disabled their only bound is the child finishing or your abort. The ceiling is read when a task starts, and background polling reads it when the session starts.

Environment forwarding applies only to tmux and HerdR launches, and values are captured when each child starts; changing the parent environment does not update an existing child. Invalid target names are ignored with a name-only diagnostic. Duplicate or overlapping prefixes use deterministic precedence and emit diagnostics without values. The required `PI_TASK_TOOL_DISABLED=1` child control always wins over a forwarded collision. Forwarded values are not secret-safe: HerdR passes them through CLI arguments and tmux stores them in the per-task launch script. SDK subagents are in-process, see the parent's raw environment, and do not receive a stripped per-child environment snapshot.

For HerdR, install and launch HerdR 0.7.5 or later separately, then start Pi inside a managed pane. pi-task requires `HERDR_ENV=1`, `HERDR_PANE_ID`, and an absolute `HERDR_SOCKET_PATH`; it never starts or installs HerdR. HerdR 0.7.5 requires topology to be created separately, so pi-task creates an unfocused pane before starting Pi through `herdr agent start`. Before the start it waits briefly for the pane's shell to run a marker `echo` (see `PI_TASK_HERDR_SHELL_READY_TIMEOUT_MS`), because HerdR rejects a long command line typed into a shell that is still loading; if HerdR then rejects the start before any input (`agent_start_input_failed`, `invalid_agent_argument`, `invalid_agent_name`), pi-task closes the pane, or the new grouped workspace, only while it still holds the terminal it created and hosts no agent. Other start failures leave the pane in place. A `workspace_group` creates a dedicated shared workspace; otherwise the task starts in an unfocused sibling pane in the caller's tab. `herdr integration install pi` is optional and improves lifecycle labels, but task completion still comes from Pi session JSONL. Persisted tasks validate both the socket path and HerdR terminal identity before reading, steering, or closing a pane.

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
