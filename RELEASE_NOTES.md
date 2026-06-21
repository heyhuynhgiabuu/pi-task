# Release notes

Human-readable release log for `@heyhuynhgiabuu/pi-task`.

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
