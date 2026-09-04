/**
 * Delivery guard for background task results: records which conversation
 * spawned each task and refuses to deliver a completion into a different
 * conversation or branch. Adopted from the pi-subtask pattern (parent session
 * id + leaf id checks) so a result can never land in a conversation that did
 * not spawn the task. In-memory only: no durable schema change.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

interface TaskParentContext {
  sessionId: string;
  leafId: string | null;
}

export interface SessionView {
  getSessionId(): string;
  getLeafId(): string | null;
  getBranch(): Array<{ id: string }>;
}

export class DeliveryGuard {
  private readonly parents = new Map<string, TaskParentContext>();

  /** Record the conversation that spawned a task. */
  track(taskId: string, session: SessionView): void {
    this.parents.set(taskId, {
      sessionId: session.getSessionId(),
      leafId: session.getLeafId(),
    });
  }

  /** Drop the record once the task is settled or removed. */
  forget(taskId: string): void {
    this.parents.delete(taskId);
  }

  /**
   * True when a result for `taskId` should still be delivered into the
   * conversation `session` points at. Untracked tasks (legacy callers) always
   * deliver. A changed session id, or a `/tree` move onto a branch that does
   * not descend from the spawn point, refuses delivery.
   */
  allows(session: SessionView, taskId: string): boolean {
    const parent = this.parents.get(taskId);
    if (!parent) return true;
    // Spawned in a context without a session manager: nothing to verify
    // against, so never block delivery on that account.
    if (parent.sessionId === "") return true;
    if (session.getSessionId() !== parent.sessionId) return false;
    if (parent.leafId !== null) {
      const branchIds = new Set(session.getBranch().map((e) => e.id));
      if (!branchIds.has(parent.leafId)) return false;
    }
    return true;
  }
}

const NOOP_SESSION: SessionView = {
  getSessionId: () => "",
  getLeafId: () => null,
  getBranch: () => [],
};

/**
 * Narrow adapter for a full ExtensionContext. Contexts without a session
 * manager (mocks, headless test harnesses) degrade to a permissive no-op so
 * a missing manager never breaks task spawning or delivery.
 */
export function sessionViewOf(ctx: ExtensionContext): SessionView {
  const sm = ctx?.sessionManager;
  if (!sm) return NOOP_SESSION;
  return {
    getSessionId: () => sm.getSessionId(),
    getLeafId: () => sm.getLeafId(),
    getBranch: () => sm.getBranch() as Array<{ id: string }>,
  };
}