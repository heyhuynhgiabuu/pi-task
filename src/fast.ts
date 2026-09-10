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
 * It registers no command, keeps no state, and writes no configuration: the
 * flag is the whole interface.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerTaskFastModeBridge } from "./fast-mode.js";

export default function fastExtension(pi: ExtensionAPI): void {
  pi.registerFlag("fast", {
    description: "Use the priority service tier for this session and its delegated children",
    type: "boolean",
    default: false,
  });

  // Read at session_start rather than at load time: the flag value is only
  // settled once the session is running, and installing after every extension
  // has loaded is what lets this bridge take precedence over a globally
  // installed pi-codex-fast without touching that extension's configuration.
  pi.on("session_start", () => {
    if (pi.getFlag("fast") !== true) return;
    registerTaskFastModeBridge(pi);
  });
}
