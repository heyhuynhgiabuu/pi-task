import { createDefaultHerdrTerminalBackend } from "./herdr.js";
import { hasTmux } from "./tmux.js";
import {
  selectTerminalBackend,
  type ExecutionBackendKind,
  type RequestedBackendKind,
  type TerminalBackend,
} from "./terminalBackend.js";

export type TaskBackendResolution =
  | {
      ok: true;
      requestedBackend: RequestedBackendKind;
      selectedBackend: ExecutionBackendKind;
      herdrBackend: TerminalBackend;
    }
  | {
      ok: false;
      kind: "invalid" | "unavailable";
      requestedBackend: string;
      error: string;
    };

export async function resolveTaskBackend(): Promise<TaskBackendResolution> {
  const legacyRequestedBackend = process.env.PI_TASK_USE_TMUX_BACKEND === "1"
    ? "tmux"
    : process.env.PI_TASK_USE_SDK_BACKEND === "1"
      ? "sdk"
      : undefined;
  const requestedBackend = (
    legacyRequestedBackend ?? process.env.PI_TASK_BACKEND ?? "auto"
  ).trim().toLowerCase();
  if (!["auto", "sdk", "tmux", "herdr"].includes(requestedBackend)) {
    return {
      ok: false,
      kind: "invalid",
      requestedBackend,
      error: `Invalid PI_TASK_BACKEND=${requestedBackend}. Expected auto, sdk, tmux, or herdr.`,
    };
  }

  const herdrBackend = createDefaultHerdrTerminalBackend();
  const hasHerdr = requestedBackend === "auto" || requestedBackend === "herdr"
    ? await herdrBackend.available()
    : false;
  const selectedBackend = selectTerminalBackend({
    requested: requestedBackend as RequestedBackendKind,
    hasHerdr,
    hasTmux: hasTmux(),
  });
  if (!selectedBackend) {
    const error = requestedBackend === "herdr"
      ? "HerdR backend requires Pi to run inside an active HerdR pane with HERDR_SOCKET_PATH set. Start Pi from HerdR; `herdr integration install pi` is optional."
      : `Requested ${requestedBackend} backend is unavailable.`;
    return { ok: false, kind: "unavailable", requestedBackend, error };
  }

  return {
    ok: true,
    requestedBackend: requestedBackend as RequestedBackendKind,
    selectedBackend,
    herdrBackend,
  };
}
