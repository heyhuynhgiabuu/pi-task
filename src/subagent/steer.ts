import type { TerminalHandle } from "../types.js";
import { createSyncHerdrControl } from "./herdr.js";
import { probePane, tmuxSteerPane } from "./tmux.js";

export type SteerResult =
	| { ok: true }
	| { ok: false; reason: "no_pane" | "pane_dead" | "backend_unavailable" | "inject_failed" };

/** Send follow-up prompt to a running tmux subagent (background steer). */
export function steerRunningBackgroundTask(
	paneId: string | null | undefined,
	prompt: string,
	handle?: TerminalHandle,
): SteerResult {
	const text = prompt.trim();
	if (!text) return { ok: false, reason: "no_pane" };
	if (handle?.backend === "herdr") {
		try {
			createSyncHerdrControl().send(handle, text);
			return { ok: true };
		} catch {
			return { ok: false, reason: "inject_failed" };
		}
	}
	if (!paneId) return { ok: false, reason: "no_pane" };
	const probe = probePane(paneId);
	if (probe.state === "unavailable") return { ok: false, reason: "backend_unavailable" };
	if (probe.state === "missing") return { ok: false, reason: "pane_dead" };
	try {
		tmuxSteerPane(paneId, text);
		return { ok: true };
	} catch {
		return { ok: false, reason: "inject_failed" };
	}
}