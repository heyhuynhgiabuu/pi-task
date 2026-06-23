# Release notes

Human-readable release log for `@heyhuynhgiabuu/pi-task`.

## 0.1.6

### What changed

- Per-task data lives in flat files at the top of `.pi/artifacts/`.
  No per-task subdirs, no `<task-id>` paths.
- The subagent's session is auto-saved by pi at
  `~/.pi/agent/sessions/<cwd>/<session-id>.jsonl`. pi-task does not
  maintain its own session storage.
- Task widget rendering is now split into a dedicated module for easier
  maintenance.
- Foreground and background widgets now use consistent colors for
  duration/tool-call stats.
- Background completion results now use a padded themed main-pane block
  and no longer duplicate completed-widget notifications.
- Final foreground tool-call counts now match the live widget count.

### Layout

```
.pi/artifacts/
├── TODO.md              pikit canonical (untouched)
├── PLAN.md              pikit canonical (untouched)
├── PROGRESS.md          pikit canonical (untouched)
├── DECISIONS.md         pikit canonical (untouched)
├── TASKS.md             pi-task: all task data, ### blocks per task
└── task-sessions.json   pi-task: conversation_id → { task_id, session_file }
```

No `.pi/task-runs/`. No `.pi/artifacts/task-<id>/` subdirs. No
CONTEXT.md (the prompt is in the CLI arg). No SESSION.md. No
RESULT.md (the subagent's final assistant message IS the result;
pi-task reads it from the auto-saved session file).

### How it works

1. Parent launches `pi --name <task_id> "<prompt>"` in a tmux pane
   (interactive TUI) — or `pi --mode json` if tmux is unavailable
2. Subagent works, user watches (in tmux mode)
3. Subagent's final assistant message IS the result. The prompt
   tells the subagent to end with a clear summary.
4. Parent reads the last assistant message from the auto-saved
   session file (tmux mode) or from the JSON event stream (SDK mode)
5. Parent embeds the result in `TASKS.md` as a `#### Result` block
6. Parent updates `task-sessions.json` with the session file path
7. For resume, parent uses `pi --session <session_file>` to continue

## 0.1.2 — 2025

### Fixed

- **Missing `pi.extensions` field in `package.json`.** Without it, the
  package was installed into `.pi/npm/node_modules/` by `pi install`
  but pi's package loader didn't recognize it as an extension, so the
  `task` tool was never registered. The previous fix (moving deps to
  `dependencies`) made the package loadable, but the package also
  needed to declare itself as a pi extension.

  Added:

  ```json
  "pi": {
    "extensions": [
      "./dist/index.js"
    ]
  }
  ```

### What you need to do

After this version is installed, the `task` tool becomes available to
the LLM in pi. Verify by:

1. Start pi
2. The status bar / extension list shows `@heyhuynhgiabuu/pi-task`
3. The LLM can call the `task` tool

## 0.1.1 — 2025

### Fixed

- **`Cannot find package '@earendil-works/pi-tui'`** on `pi install`.
  `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` were
  declared as `peerDependencies` and `devDependencies`, but the dist
  has a runtime `import { Text, truncateToWidth } from
"@earendil-works/pi-tui"`. With `npm install --omit=dev` (the
  default used by `pi install`), peer deps are recorded but not
  installed into the package's own `node_modules`. They are now
  declared in `dependencies` and pinned to `^0.79.0`.

## 0.1.0

Initial release.
