/**
 * Parent-side fast mode.
 *
 * `--fast` on the parent already reaches its children — that is what
 * `resolveTaskFastMode` decides — but the parent's own model calls were
 * untouched, because the provider bridge in `fast-mode.ts` is installed only in
 * a child. That is what "task-local" means there. This entry point installs the
 * same bridge for the session that passes the flag, so one flag covers the
 * parent and everything it delegates to.
 *
 * `index.ts` owns the shared `--fast` flag; this entry only consumes it. It
 * registers no flag or command, keeps no state, and writes no configuration.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerTaskFastModeBridge } from "./fast-mode.js";

export default function fastExtension(pi: ExtensionAPI): void {
  // Read at session_start rather than at load time: the shared flag value is
  // settled once the session is running. The main entry point is the sole
  // owner of `--fast`, so loading both package entries cannot create a flag
  // conflict.
  pi.on("session_start", () => {
    if (pi.getFlag("fast") !== true) return;
    registerTaskFastModeBridge(pi);
  });
}
