import { createDefaultHerdrTerminalBackend } from "./herdr.js";
import { hasTmux } from "./tmux.js";
import {
  selectTerminalBackend,
  type ExecutionBackendKind,
  type RequestedBackendKind,
  type TerminalBackend,
} from "./terminalBackend.js";

let durableAvailability: Promise<boolean> | undefined;

/** Probe (once) whether the optional pi-durable packages are importable. */
function isDurableBackendAvailable(): Promise<boolean> {
  durableAvailability ??= import("@earendil-works/pi-durable")
    .then(() => true)
    .catch(() => false);
  return durableAvailability;
}

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

export async function resolveTaskBackend(
  options: {
    allowAcpSession?: boolean;
    /** `taskBackend` from pi settings — explicit opt-in persisted across
     * restarts. The PI_TASK_BACKEND env var overrides it. */
    settingsBackend?: string;
  } = {},
): Promise<TaskBackendResolution> {
  const legacyRequestedBackend = process.env.PI_TASK_USE_TMUX_BACKEND === "1"
    ? "tmux"
    : process.env.PI_TASK_USE_SDK_BACKEND === "1"
      ? "sdk"
      : undefined;
  // Blank env values are treated as unset so they cannot shadow the setting.
  const envRaw = process.env.PI_TASK_BACKEND;
  const envBackend = envRaw?.trim() ? envRaw : undefined;
  const settingsBackend = typeof options.settingsBackend === "string"
    ? options.settingsBackend.trim().toLowerCase()
    : undefined;
  const requestedBackend = (
    legacyRequestedBackend ?? envBackend ?? settingsBackend ?? "auto"
  ).trim().toLowerCase();
  if (!["auto", "sdk", "durable", "tmux", "herdr"].includes(requestedBackend)) {
    const source = requestedBackend === envRaw?.trim().toLowerCase()
      ? `PI_TASK_BACKEND=${requestedBackend}`
      : `taskBackend=${requestedBackend} (settings)`;
    return {
      ok: false,
      kind: "invalid",
      requestedBackend,
      error: `Invalid ${source}. Expected auto, sdk, durable, tmux, or herdr.`,
    };
  }
  // The durable backend needs its optional framework packages at runtime;
  // they are dev-only for the spike, so probe before committing to it.
  if (requestedBackend === "durable" && !(await isDurableBackendAvailable())) {
    return {
      ok: false,
      kind: "unavailable",
      requestedBackend,
      error:
        "Durable backend requires the optional pi-durable packages. Install them with: npm install @earendil-works/pi-durable @earendil-works/chord",
    };
  }

  const herdrBackend = createDefaultHerdrTerminalBackend();
  const isAcp = process.env.PI_ACP === "1" && options.allowAcpSession !== false;
  // A visible herdr pane is the most observable way to run a task, so automatic tasks
  // prefer it whenever it exists — including when this process is an ACP child.
  const hasHerdr =
    requestedBackend === "herdr" || requestedBackend === "auto"
      ? await herdrBackend.available()
      : false;
  // tmux only matters when herdr is absent and ACP is not about to claim the task.
  const tmuxAvailable =
    requestedBackend === "tmux" || (requestedBackend === "auto" && !hasHerdr && !isAcp)
      ? hasTmux()
      : false;
  const selectedBackend = selectTerminalBackend({
    requested: requestedBackend as RequestedBackendKind,
    hasHerdr,
    hasTmux: tmuxAvailable,
    isAcp,
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
