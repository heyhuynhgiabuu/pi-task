import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildAcpTaskSessionData } from "../helpers.js";

type ChildSession = {
  subscribe(cb: (event: Record<string, unknown>) => void): () => void;
};

/**
 * Call `onReady` once the child session has a transcript on disk, then stop watching.
 * The transcript is the precondition for a client to be able to load the child at all.
 *
 * The transcript check is deferred to a microtask, so `stop()` must also invalidate
 * checks that are already queued: a stopped watcher never calls back.
 */
export function watchChildSessionReady(
  session: ChildSession,
  sessionPath: string,
  onReady: () => void,
): () => void {
  let stopped = false;
  let unsubscribe: (() => void) | undefined;

  const stop = () => {
    stopped = true;
    unsubscribe?.();
    unsubscribe = undefined;
  };

  try {
    unsubscribe = session.subscribe((event) => {
      if (event.type !== "message_end" && event.type !== "entry_appended") return;
      queueMicrotask(() => {
        // The owner may have stopped the watcher after this check was queued.
        if (stopped || !existsSync(sessionPath)) return;
        stop();
        onReady();
      });
    });
  } catch {
    // Session linking is auxiliary; task execution does not depend on event subscriptions.
  }

  return stop;
}

/**
 * Link a running child session to its parent `task` tool call.
 *
 * The link is persisted only as a session entry: pi records `appendEntry` custom
 * entries in the parent session JSONL immediately (the live `entry_appended`
 * channel) and keeps them for history replay, where the ACP adapter reads
 * `{ type: "custom", customType: "task-session", data }`. A hidden custom message
 * is deliberately NOT sent, because an empty custom message can project as an
 * empty user turn for some providers. Linking is best-effort: it must never break
 * task execution.
 */
export function sendAcpTaskSessionLink(
  pi: ExtensionAPI,
  params: { taskId: string; sessionId: string; piToolCallId?: string },
): void {
  const data = buildAcpTaskSessionData(params.taskId, params.sessionId, params.piToolCallId);

  try {
    pi.appendEntry("task-session", data);
  } catch {
    // Linking is auxiliary.
  }
}
