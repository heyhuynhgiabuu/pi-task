# Changelog

All notable changes to `@heyhuynhgiabuu/pi-task` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
[Keep a Changelog]: https://keepachangelog.com/
[Semantic Versioning]: https://semver.org/
