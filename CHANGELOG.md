# Changelog

All notable changes to `@heyhuynhgiabuu/pi-task` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `.editorconfig` (root) — enforces `indent_style = space`,
  `indent_size = 2`, `end_of_line = lf`, `charset = utf-8` so future
  edits and automated tools stay aligned with the existing 2-space
  convention.
- `.gitignore` now excludes `.atl/` (Gentle AI / Pi runtime state).
- `getSessionTerminalState` now returns the raw `stopReason` alongside
  the terminal state, so callers can distinguish `error` from `length`
  without re-walking the jsonl.

### Changed

- `TaskDetails.phase` value `"aborted"` renamed to `"cancelled"` to
  match `TaskCompletionStatus`. Consumers that read
  `details.phase === "aborted"` should treat both as user-cancellation.
- Subagent completion detection now consults the most recent assistant
  `stopReason` in the session jsonl. A subagent whose pi turn ends
  cleanly (`stopReason: "stop"`) but whose tmux pane is still open is
  now reported as `completed` instead of being polled to the 30-minute
  timeout. `error` / `length` map to `failed`.
- `killAgentPane` now guards with `paneExists` before issuing
  `kill-pane` (prevents killing a recycled pane id) and accepts
  `paneId: string | undefined` for the SDK (no-pane) path.
- `splitWindowPane` now passes the command to `tmux split-window`
  directly instead of using `send-keys`, eliminating a race where the
  shell prompt could be unready and drop characters.
- `readRegistry` returns `[]` for non-array JSON, hardening against a
  partially-written or hand-edited `task-registry.json`.

### Removed

- `tmuxSteerPane` export (subagent follow-up / steer path is no
  longer supported).
- `buildTmuxSendKeysArgs` and `OUTPUT_FORMAT_GUIDE` from
  `src/helpers.ts` (replaced by the direct `split-window` path and a
  single canonical `TASK_RESULT_XML_INSTRUCTIONS` constant).
- Duplicate tmux helpers (`tmuxCmd`, `hasTmux`, `paneExists`,
  `getCurrentPaneId`, `splitWindowPane`, `killAgentPane`) that lived
  in `src/index.ts`. `src/subagent/tmux.ts` is now the single source
  of truth.

### Fixed

- `waitCompletion` was reading `<taskDir>/sessions/<name>` (a
  non-existent nested path), so the session-text fallback never fired
  and a subagent could only complete via `RESULT.md`. Callers now
  pass `<taskDir>/sessions` directly; the path is centralised in
  `resolveSessionDir(taskDir)`.
- The `pane-alive` branch of `checkTaskCompletion` is now
  dependency-injectable (`TaskCompletionOptions.paneExists`) so the
  regression test is deterministic on every CI, not just machines
  with a `tmux` binary on `PATH`.

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

[0.1.2]: https://github.com/buddingnewinsights/pi-task/releases/tag/v0.1.2

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

[0.1.1]: https://github.com/buddingnewinsights/pi-task/releases/tag/v0.1.1
