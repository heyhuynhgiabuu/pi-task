/**
 * Parent-side fast mode setup.
 *
 * `--fast` on the parent already reaches its children — that is what
 * `resolveTaskFastMode` decides — but the parent's own model calls were
 * untouched, because the provider bridge in `fast-mode.ts` was installed only
 * in a child. This helper installs the same bridge for the parent session.
 * The caller must be the extension that owns the `fast` flag because Pi scopes
 * `getFlag()` to that extension.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerTaskFastModeBridge } from "./fast-mode.js";

export function registerParentFastMode(pi: ExtensionAPI): void {
  let fastModeBridgeInstalled = false;
  // Read at session_start rather than at load time: the flag value is settled
  // once the session is running.
  pi.on("session_start", () => {
    if (fastModeBridgeInstalled || pi.getFlag("fast") !== true) return;
    fastModeBridgeInstalled = true;
    registerTaskFastModeBridge(pi);
  });
}
