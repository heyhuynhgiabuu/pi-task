/**
 * Delivery guard for background task results: records which conversation
 * spawned each task and refuses to deliver a completion into a different
 * conversation or branch. Adopted from the pi-subtask pattern (parent session
 * id + leaf id checks) so a result can never land in a conversation that did
 * not spawn the task. Durable records can restore the parent after restart.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface TaskParentContext {
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

  /** Restore a parent context loaded from durable task state after restart. */
  restore(taskId: string, parent: TaskParentContext): void {
    this.parents.set(taskId, { ...parent });
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
    return ownerAllowsResult(session, {
      ownerSessionId: parent.sessionId,
      ownerLeafId: parent.leafId,
    });
  }
}

/**
 * Owner identity recorded on a task's durable state. `ownerLeafId` null means
 * the branch check is disabled, exactly as in `DeliveryGuard`.
 */
export interface TaskOwnerIdentity {
  ownerSessionId?: string;
  ownerLeafId?: string | null;
}

/**
 * One owner rule for both paths: a completion delivered into a conversation
 * and a result injected into a child prompt must come from the same session
 * and branch that spawned the task. An unowned (legacy) task never blocks —
 * nothing was recorded to check against.
 */
export function ownerAllowsResult(
  session: SessionView,
  owner: TaskOwnerIdentity,
): boolean {
  const ownerSessionId = owner.ownerSessionId;
  if (ownerSessionId === undefined || ownerSessionId === "") return true;
  if (session.getSessionId() !== ownerSessionId) return false;
  const leafId = owner.ownerLeafId ?? null;
  if (leafId !== null) {
    const branchIds = new Set(session.getBranch().map((e) => e.id));
    if (!branchIds.has(leafId)) return false;
  }
  return true;
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