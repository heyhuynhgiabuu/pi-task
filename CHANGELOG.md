# Changelog

All notable changes to `@heyhuynhgiabuu/pi-task` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
