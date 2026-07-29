# Changelog

All notable changes to `@heyhuynhgiabuu/pi-task` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- HerdR initial prompts now wait for an observed agent state transition and retry Enter once when submission stalls, preventing child panes from remaining idle with the task prompt in the editor.

## [0.3.8] - 2026-07-28

### Added

- Optional validated `cwd` task input for running children in parent-created Git worktrees across SDK, tmux, and HerdR backends. The cwd is persisted for resumed launches; pi-task does not own worktree creation, merge, or cleanup.

### Fixed

- Reject foreground relaunch of an already-running durable task instead of starting a second child against the same session.

## [0.3.7] - 2026-07-22

### Changed

- Migrated the HerdR backend to HerdR 0.7.5's topology-first native agent launch API, preserving caller-tab affinity for ungrouped tasks and shared workspaces for grouped tasks.
- Updated the development and test baseline to Pi 0.81.0 and Pi's supported `typebox` package while keeping runtime peer dependencies host-provided.
- HerdR task completion now uses Pi session JSONL plus live agent detection instead of an exit sentinel.

### Fixed

- HerdR-backed tasks now pass the multiline system prompt through a file and submit the raw task prompt after agent startup, avoiding control-character rejection without wrapping user instructions as a file attachment.
- Hardened parallel HerdR launch and cleanup ownership by tracking task pane identities and serializing lifecycle mutations.

### Removed

- Removed `PI_TASK_HERDR_SHELL`; native `herdr agent start` no longer launches tasks through a configurable shell wrapper.

## [0.3.6] - 2026-07-21

### Fixed

- Tmux-backed background subagents now launch detached, preserving focus in the parent pane during parallel delegation.
- Removed an invalid extension-load-time tool inventory call that prevented pi-task v0.3.5 from loading.

## [0.3.5] - 2026-07-21

### Added

- `PI_TASK_TOOL_NAME` opt-in configuration for the delegation tool name; `task` remains the default and `Agent` enables Claude Code-compatible naming.

### Fixed

- SDK background tasks now deliver success and failure results to the parent, and all execution paths preserve child-reported outcome separately from runtime completion state.
- Subagents exclude the configured delegation tool name, preventing nested task delegation after a tool-name override.

## [0.3.4] - 2026-07-21

### Fixed

- Bundled agents now inherit Pi's configured/current model rather than requiring `opencode-go/deepseek-v4-flash`; explicit user and project agent models still take precedence.
- Test and smoke scripts no longer force `PI_XAI_SIDE_TOOLS=0`.

## [0.3.3] - 2026-07-21

### Fixed

- HerdR-backed tasks on Windows can use `PI_TASK_HERDR_SHELL` or automatic Git `sh.exe` detection instead of requiring `sh` on the HerdR daemon's `PATH`.

## [0.3.2] - 2026-07-19

### Added

- Configurable tmux pane orientation via `PI_TASK_TMUX_SPLIT=auto|horizontal|vertical`, with aspect-ratio detection in auto mode.

## [0.3.1] - 2026-07-17

### Fixed

- Launch ungrouped HerdR tasks in the caller's tab while retaining dedicated shared workspaces for grouped parallel tasks.
- Serialize grouped HerdR workspace launches and retain shared workspace ownership across concurrent tasks.
- Close only the task pane when grouped workspace state is unavailable after a Pi restart, preventing cleanup from terminating sibling tasks.

## [0.3.0] - 2026-07-13

### Added

- Optional HerdR execution backend with geometry-aware, serialized pane spawning, socket/terminal ownership checks, durable resume steering, and parent-owned cleanup.
- `PI_TASK_BACKEND=auto|herdr|tmux|sdk`; `auto` uses HerdR only when Pi already runs in a HerdR-managed pane.

### Changed

- Task titles now prefix the agent name with `⚙` (for example, `⚙ reviewer`) in initial, live-progress, and completion output.
- Task lifecycle persistence records completion before terminal cleanup, preventing orphaned widget entries.

### Fixed

- HerdR steering sends text followed by exactly one Enter.
- HerdR child exit sentinels no longer race the parent completion poller.
- Removed dead internal declarations and registered all behavioral tests in the package test command.

## [0.2.6] - 2026-07-10

### Added

- SDK widget regression coverage for tool events, polling isolation, lifecycle invalidation, and background settlement.

### Changed

- Non-tmux SDK task widgets now update only on task state changes instead of repainting continuously.
- Foreground SDK task results now use the same structured expand/collapse result contract as tmux and background tasks.

### Fixed

- SDK task widgets retain bash invocation details, render the newest tool call, and keep background rows until SDK settlement.
- Tmux foreground tasks continue using JSONL tool-stat polling after backend discrimination was introduced.

## [0.2.5] - 2026-07-10

### Added

- `test/taskWidget.test.ts` coverage for foreground/background widget spacing, connector layout, collapse behavior, and waiting/done/error states.

### Changed

- Task launch receipts now show the exact subagent JSONL path instead of tmux session/artifact directory lines.
- Foreground textual progress now mirrors the background receipt shape to avoid duplicating the widget's latest tool-call line.
- Background widget now uses the same two-line header/detail tree layout as foreground.
- `task` docs and schema now require a stronger prompt contract: goal, non-goals, write/read policy, stop condition, and verification recipe.
- `npm test` now includes `test/taskWidget.test.ts`.

### Fixed

- Foreground widget now collapses in-flight tool-call output instead of repeating many lines.
- Background widget spacing/indent is visually aligned across waiting, running, done, and error states.
- Removed stale harness references and dead foreground-progress `outputLines` plumbing.

## [0.2.4] - 2026-07-03

### Added

- Rich tmux subagent failure diagnostics: reports expected session dir, JSONL presence, startup hints, and pane tail when available.
- `PI_TASK_CHILD_NO_EXTENSIONS=1` to run child Pi sessions with `--no-extensions` while debugging extension-load crashes.
- Shared task title renderer for consistent foreground/background task title formatting.
- Polling regression coverage for overlapping background poll ticks.

### Changed

- Background task receipt text is shorter: removes extra tmux/session parentheticals.
- Background task completion uses theme `toolSuccessBg` instead of hardcoded ANSI RGB.
- Running and completed task UI spacing is aligned for task titles, stats, and expand/collapse hints.
- `npm test` now includes `test/polling.test.ts`.

### Fixed

- Background polling now reads subagent sessions from `artifacts/tasks/sessions/<taskId>` instead of the artifacts root.
- Background polling now uses an in-flight guard so slow poll ticks cannot duplicate completion notifications.
- Timeout/pane-exit diagnostics no longer collapse into an opaque “Subagent pane exited” message when session artifacts exist.

## [0.2.3] - 2026-07-02

### Added

- Bundled **general** agent; roster **explore**, **scout**, **general**, **reviewer** (removed bundled worker / planner / vision).
- Agent YAML: **`hidden`** (exclude from catalog + block `task` invoke), **`proactive`** (PROACTIVE block in tool description), **`readonly`** (deny write/edit/apply_patch/harness; bash allowed).
- `resolveTaskAgentPreflight`, dynamic `buildTaskToolDescription(agents)` catalog from discovered agents.
- Task prompt **Workspace scope** section (`buildTaskPrompt`); parent guideline for absolute repo paths when cwd ≠ target.
- `test/prompt.test.ts`; smoke check that `pi --version` meets peer `@earendil-works/pi-coding-agent` (skip if `pi` not on PATH).
- Frontmatter parsing tests (`hidden` / `proactive` / `readonly`).

### Changed

- `TASK_PROMPT_INSTRUCTIONS` aligned with XML result envelope; `TASK_RESULT_XML_INSTRUCTIONS` use `<summary>` (not stale `<episode>`).
- Bundled `explore` / `scout` agent docs: workspace rules; deduplicated bullets.
- Background task expand hint: closing `)` uses dim theme (was default white after inner ANSI reset).
- Foreground task widget: status line stays one row; tool lines capped (5) in onUpdate + bottom widget (8) to avoid overlapping agent • tools • duration when >10 toolcalls.
- Foreground sticky `renderCall`: show `agent • description` until elapsed ≥1s or tool count &gt;0 (no static `0 toolcalls • 0s`).
- `readProgress(sessionDir)`: same path as `countToolUses` for foreground polling (fixes reviewer path mismatch).
- Foreground sticky `renderCall`: agent `toolTitle`; tool count `text`; duration `success`.
- Task result body (foreground + background): stats use **`muted`** toolcalls + **`success`** duration (`formatElapsed`); sticky `renderCall` while running keeps **`text`** tool count (widget-style).
- Task-complete notification title: agent `toolTitle`, description `muted` (aligned with foreground sticky).
- Background: collapsed result shows **one** latest `⎿` tool line (not full multiline stream); bottom widget **1** tool line per background task (foreground widget still 8).

## [0.2.2] - 2026-07-01

### Added

- **Structured task results.** `parseResultXml` accepts canonical `<result>` tags
  and agent `<episode>` aliases (`sources` → evidence, `blockers` → caveats,
  `checks` → next_steps, `decisions` → findings). `buildTaskEnvelope` maps
  parsed XML into tool `details` for the TUI.
- **Shared result rendering.** `renderTaskResultBody` powers foreground
  `renderResult` and background `task-complete` notifications (Summary /
  Findings / Evidence / Files / Caveats / Next steps, Ctrl+O expand).
- **Foreground progress Ctrl+O.** `renderCall` respects `context.expanded`;
  sticky header shows recent tool lines when expanded (no duplicate `⎿` glyphs
  in the result body).
- **`lifecycle/completion.ts`.** Background completion sends parsed `details`
  (`structured_result`, `full_output`, section fields) instead of dumping raw XML.
- **Tests** for episode alias parsing, background receipt, and `formatTaskEnvelope`.

### Changed

- **Background start receipt.** Plain three-line receipt with `⎿ Started task…`
  (no `<task>` XML wrapper); Tmux and sessions lines align under **Started**.
- **Background TUI spacing.** `details.background` uses tight layout: one leading
  space on stats, preview, section labels/lines, and ` (ctrl+o …)` hints;
  branch lines starting with `⎿` are not double-indented.
- **Plain-text result fallback** uses `PLAIN_SUMMARY_MAX_CHARS` (500) for
  non-XML subagent replies.

### Fixed

- **task-complete TUI crash.** Renderer returns a `Box` with composed children
  instead of passing `root.render(0)` into `Text` (`trim is not a function`).
- **Background expand showed one-line summary only** — completion `details` now
  include full parsed sections for Ctrl+O.

## [0.2.1] - 2026-07-01

### Added

- **`background: true` support for SDK backend.** The Pi task tool now
  accepts `background: true` when running inside the SDK (non-tmux
  backend). The subagent's `AgentSession` lives in the host's process;
  its subscriptions and extension context stay valid as long as the
  parent session is alive, which is what OpenPi's sidecar guarantees.
- **`stale-ctx` filtering.** `extension_error` events that come from
  a Promise rejection whose message mentions "this extension ctx is
  stale" are now swallowed before the UI sees them. The host's
  session-replacement path was triggering a benign race during reload.
- **Task-session-history helpers.** New `task-session-history.json`
  is the source of truth for runtime task status. The renderer no
  longer reads `TASKS.md` for status or navigation.
- **Cancelled foreground navigation is normalized.** A click on a
  pending task row no longer aborts the running child; the row stays
  unclickable until the task settles.

### Fixed

- **`reload_session` no longer leaks extension timers.** The sidecar
  now does a full session replacement (dispose + startSession) on
  reload, which atomically destroys the old runner and its timers.
- **Background tmux panes self-destruct on exit.** Pane
  `remain-on-exit` and `setPaneSelfDestruct` are set so dead tasks
  don't accumulate.
- **Restore reconciles registry with JSONL.** On startup,
  `restoreActiveBackgroundTasks` walks the registry and the
  per-task JSONL, marking tasks done/failed and killing stale panes.

## [0.2.0] — 2026-06-25

### Changed

- **Modular refactor of `src/`.** The single-file `index.ts` is now a thin
  wiring layer; the implementation is split across focused modules:
  - `src/tool/` — `renderCall`, `renderResult`, `taskComplete`, `prompt`,
    `schema`.
  - `src/lifecycle/` — `polling`, `completion`, `toolStats`, `widget`,
    `restore`.
  - `src/subagent/` — `buildArgv`, `runSdk`, `tmux`, `waitCompletion`.
  - `src/conversation.ts` — `findJsonlSessionByName`, registry and
    `task-session-history` helpers.
  - `src/constants.ts` — `BACKGROUND_CHECK_MS`, `COUNT_POLL_MS`,
    `TASK_TIMEOUT_MS`, `MAX_POLL_ERRORS`.
  - `src/types.ts` — `BackgroundTask`, `RegistryEntry`,
    `TaskSessionHistoryEntry`, `TaskDetails`.
- **Session JSONL is now the single source of truth for task results.**
  `RESULT.md` is no longer read for completion detection or result text —
  the final assistant message in `~/.pi/agent/sessions/.../<id>.jsonl`
  is the authoritative result. This removes mid-write `EACCES` and
  "stale truncated `RESULT.md`" failure modes entirely.
- **Completion detection is gated on `stopReason`.** `hasAgentFinished()`
  in `src/session-text.ts` only treats an assistant message as final when
  its `stopReason` is `stop`, `endTurn`, `length`, `error`, or `aborted`.
  `toolUse` mid-turn streaming text is correctly ignored.
- **Background polling is hardened.**
  - `checkInFlight` guard prevents overlapping poll ticks (no more
    double-completion races on the `backgroundTasks` map).
  - `MAX_POLL_ERRORS = 3` per-task counter absorbs transient filesystem
    errors; a single rejected `readFile` no longer orphans a task.
  - Try/catch around `checkTaskCompletion()` keeps the interval alive on
    one-off failures.
- **Reordered completion check flow.** Session JSONL is consulted before
  pane liveness, so `remain-on-exit` panes no longer block detection.

### Added

- `renderCall` / `renderResult` / task-complete renderers with **Ctrl+O
  expand/collapse** (via `keyHint("app.tools.expand")`) on the `task`
  tool. Foreground results show stats + preview; expanded shows the full
  result text. The keybinding hint falls back to `Ctrl+O` if the
  `app.tools.expand` keybinding is not registered.
- **Foreground real-time tool-call progress.** The foreground `execute`
  path now polls the session file and emits `_onUpdate` callbacks while
  waiting, so the parent pane shows a live `${n} tool calls` count
  alongside the spawned subagent pane.

### Fixed

- The "scout - Description" / "scout — Description" duplicate header in
  foreground results: `renderResult` no longer re-renders the header
  that `renderCall` already rendered.
- The `( to expand)` empty-keybinding hint: now falls back to a plain
  `Ctrl+O to expand` label when `keyText("app.tools.expand")` is empty.

### Verified

- `npm run typecheck` passes
- `npm run build` passes
- `npm run smoke` passes
- `npm pack --dry-run` succeeds

## [0.1.6] — 2026-06-25

### Changed

- Per-task data is now in flat files at the top of `.pi/artifacts/`.
  No per-task subdirs, no `<task-id>` paths. The pikit canonical
  files (TODO.md, PLAN.md, PROGRESS.md, DECISIONS.md) are flat at the
  same level; pi-task files now sit alongside them.
- Refined the task TUI widget and background completion rendering:
  foreground/background task stats now use consistent colors, background
  completion summaries use a padded themed result block, completed
  background widgets no longer duplicate the main-pane completion, and
  final tool-call counts now match the live widget count.

### Layout

- `.pi/artifacts/TASKS.md` — one `### <task-id>` block per task, with
  H4 subsections for `#### Metadata` (JSON) and `#### Result`.
- `.pi/artifacts/task-sessions.json` — registry mapping
  `conversation_id` to `{ task_id, session_file }`. Renamed from
  the v0.1.5 `task-conversations.json`.
- The subagent's session is auto-saved by pi at
  `~/.pi/agent/sessions/<cwd>/<session-id>.jsonl`. pi-task reads
  the last assistant message from there to populate `#### Result`
  in `TASKS.md`. The subagent's final assistant message IS the
  result; no separate result file is required.

### Removed

- `.pi/artifacts/task-<id>/` per-task subdirs (and the
  `metadata.json` + `SESSION.md` + `sessions/` files inside them).
  All per-task data lives in `TASKS.md` blocks now.
- `.pi/artifacts/task-conversations.json` — replaced by
  `task-sessions.json`.
- The `taskArtifactName(taskId)` / `taskIdFromArtifactName(name)`
  helpers and the `getArtifactsDir(piDir)` / `getTaskDir(piDir)` /
  `getTaskRunsDir(piDir)` helpers.

### Verified

- `npm test` passes
- `npm run typecheck` passes
- `npm run build` passes
- `npm run smoke` passes

## [0.1.4] — 2026-06-21

### Fixed

- Detect the current tmux pane size before launching a task pane and choose
  the split direction based on available space: side-by-side for wide panes,
  stacked for narrow panes.
- Target the exact pane that was measured when running `tmux split-window`,
  avoiding focus races where a different pane could be split.
- Apply the same pane-size-aware split logic to the subagent tmux helper.

### Verified

- `npm test` passes
- `npm run typecheck` passes
- `npm run build` passes
- `npm run smoke` passes
- `npm pack --dry-run` succeeds
- Real tmux integration check passed for narrow `120x40` and wide `200x40`
  sessions.

[0.1.4]: https://github.com/heyhuynhgiabuu/pi-task/releases/tag/v0.1.4

## [0.1.3] — 2026-06-21

### Fixed

- Replaced tmux task startup via `send-keys` with direct
  `split-window <command>` execution so long, quoted `pi ...` launch
  commands are not truncated or interrupted by terminal input buffering.
- Hardened tmux steering/follow-up text injection by using tmux buffers
  (`load-buffer` + `paste-buffer`) instead of typing long text via
  `send-keys`.

### Verified

- `npm test` passes
- `npm run typecheck` passes
- `npm run build` passes
- `npm run smoke` passes
- Long task-tool tmux launch stress test passed with quotes, backticks,
  shell expansions, redirects, newlines, unicode, and long prompt text.

[0.1.3]: https://github.com/heyhuynhgiabuu/pi-task/releases/tag/v0.1.3

## [0.1.2] — 2025

### Fixed

- **Missing `pi.extensions` field in `package.json`.** Without it,
  the package was installed by `pi install` but pi's package loader
  didn't recognize it as an extension, so the `task` tool was never
  registered.

  Added:

  ```json
  "pi": {
    "extensions": [
      "./dist/index.js"
    ]
  }
  ```

### Verified

- `npm run build` succeeds
- `npm test` 1/1 pass
- `tsc --noEmit` clean
- `npm view @heyhuynhgiabuu/pi-task@0.1.2 pi` returns
  `{ extensions: [ './dist/index.js' ] }`

  [0.1.2]: https://github.com/heyhuynhgiabuu/pi-task/releases/tag/v0.1.2

## [0.1.1] — 2025

### Fixed

- `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` moved
  from `peerDependencies` and `devDependencies` to `dependencies`. They
  are runtime imports (the dist imports `@earendil-works/pi-tui` for
  `Text` and `truncateToWidth`), so they need to ship in the npm
  tarball.

  Under `npm install --omit=dev` (the default used by `pi install`),
  peer dependencies are not auto-installed into the package's own
  `node_modules`, which caused the load error:

  ```
  pi loading extension "@heyhuynhgiabuu/pi-task"
    Cannot find package '@earendil-works/pi-tui'
  ```

### Changed

- Pinned `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`
  to `^0.79.0` (was `*`).
- Removed redundant `devDependencies` entries that overlapped with the
  new `dependencies`.

### Verified

- `npm run build` succeeds
- `npm test` 1/1 pass (the helper test)
- `tsc --noEmit` clean
- The dist `dist/index.js` references `@earendil-works/pi-tui`
  (the correct, current package name)

## [0.1.0] and earlier

See the git history: `git log --oneline -- CHANGELOG.md`.

    [0.1.1]: https://github.com/heyhuynhgiabuu/pi-task/releases/tag/v0.1.1
    [0.1.4]: https://github.com/heyhuynhgiabuu/pi-task/releases/tag/v0.1.4
    [0.1.5]: https://github.com/heyhuynhgiabuu/pi-task/releases/tag/v0.1.5
  [0.2.0]: https://github.com/heyhuynhgiabuu/pi-task/releases/tag/v0.2.0
  [0.1.6]: https://github.com/heyhuynhgiabuu/pi-task/releases/tag/v0.1.6
  [Keep a Changelog]: https://keepachangelog.com/
  [Semantic Versioning]: https://semver.org/
