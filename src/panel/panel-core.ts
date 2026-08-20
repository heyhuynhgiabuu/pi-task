/**
 * Pure panel logic for the interactive task widget: row ordering, selection
 * identity, and keyboard dispatch. No TUI or extension imports so the behavior
 * is unit-testable in isolation.
 *
 * Adapted from the pi-subtask panel model (gary149/pi-subtask): rows render
 * with a "main" row at index 0 followed by task rows; selection is tracked by
 * identity so the cursor follows a task when the list reorders, and a vanished
 * task self-corrects back to "main". Key dispatch mirrors the SubtaskEditor
 * routing: down on an empty prompt enters the panel, up/down navigate,
 * enter opens the task view, x stops or dismisses, escape returns to typing.
 */

import { matchesKey } from "@earendil-works/pi-tui";

/** Long enough to see a completion land, short enough to not linger forever. */
export const DONE_ROW_LINGER_MS = 5_000;
export const FAILED_ROW_LINGER_MS = 30_000;

export type TaskRowStatus =
  | "starting"
  | "running"
  | "done"
  | "cancelled"
  | "aborted"
  | "failed"
  | "timeout";

export interface TaskPanelRow {
  id: string;
  /** Agent type, capitalized for display. */
  agentType: string;
  /** Task description, truncated for the row. */
  description: string;
  status: TaskRowStatus;
  startedAt: number;
  finishedAt?: number;
  /** Latest tool-call summary while running. */
  activity?: string;
}

/** Selection identity: "main" is the editor row, a task id selects a task row. */
export type PanelSelection = "main" | { taskId: string } | null;

export interface PanelViewState {
  selection: PanelSelection;
  /** Task whose transcript view is open (non-null while in the view). */
  viewTaskId: string | null;
}

export function initialPanelState(): PanelViewState {
  return { selection: null, viewTaskId: null };
}

/** Whether the panel is actively navigated or viewing a transcript. */
export function isPanelFocused(state: PanelViewState): boolean {
  return state.selection !== null || state.viewTaskId !== null;
}

/**
 * Running/starting tasks first in spawn order, then finished tasks newest
 * first. Finished rows age out of the idle widget (per-status linger) but stay
 * listed while the panel is focused or a view is open, so they stay resumable.
 */
export function panelRows(
  tasks: readonly TaskPanelRow[],
  now: number,
  focused: boolean,
): TaskPanelRow[] {
  const running = tasks
    .filter((t) => t.finishedAt === undefined)
    .sort((a, b) => a.startedAt - b.startedAt);
  const finished = tasks
    .filter((t) => t.finishedAt !== undefined)
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
  if (focused) return [...running, ...finished];
  const lingerFor = (t: TaskPanelRow) =>
    t.status === "done" ? DONE_ROW_LINGER_MS : FAILED_ROW_LINGER_MS;
  return [
    ...running,
    ...finished.filter((t) => now - (t.finishedAt ?? 0) < lingerFor(t)),
  ];
}

/**
 * Finished entries that survive the linger window. The task currently open in
 * the transcript view is always retained (pruning it would blank the open view
 * and break steering while it is watched). Pure so the expiry rule is
 * unit-testable.
 */
export interface FinishedEntry {
  id: string;
  task: { status?: string };
  finishedAt: number;
}

export function pruneFinishedEntries(
  entries: Iterable<FinishedEntry>,
  viewTaskId: string | null,
  now: number,
): FinishedEntry[] {
  return [...entries].filter((entry) => {
    if (entry.id === viewTaskId) return true;
    const linger =
      entry.task.status === "done"
        ? DONE_ROW_LINGER_MS
        : FAILED_ROW_LINGER_MS;
    return now - entry.finishedAt < linger;
  });
}

/**
 * Index of the selection within `rows`, where 0 is the implicit "main" row and
 * i >= 1 is rows[i - 1]. A vanished task self-corrects to "main" (returns 0).
 * Returns null when there is no selection.
 */
export function selectionIndex(
  sel: PanelSelection,
  rows: readonly TaskPanelRow[],
): number | null {
  if (sel === null) return null;
  if (sel === "main") return 0;
  const i = rows.findIndex((r) => r.id === sel.taskId);
  return i >= 0 ? i + 1 : 0;
}

/** Clamped selection move; index 0 selects the main row. */
export function selectAt(
  rows: readonly TaskPanelRow[],
  index: number,
): PanelSelection {
  const clamped = Math.max(0, Math.min(rows.length, index));
  return clamped === 0 ? "main" : { taskId: rows[clamped - 1]!.id };
}

export type PanelKeyAction =
  | { kind: "select"; selection: PanelSelection }
  | { kind: "clear" }
  /** Enter on a task row (opens its view) or on main (returns to conversation). */
  | { kind: "enter"; taskId: string | null }
  /** x on a task row: stop a running task, dismiss a finished one. */
  | { kind: "stop"; taskId: string }
  /** Not a panel key; the caller should forward the input to the editor. */
  | { kind: "unhandled" };

/**
 * Map a raw key event to a panel action. `mode` distinguishes panel navigation
 * (up at main exits navigation) from the transcript view (up at main holds so
 * one up + enter always returns to the conversation).
 */
export function dispatchPanelKey(
  data: string,
  sel: PanelSelection,
  rows: readonly TaskPanelRow[],
  mode: "panel" | "view",
): PanelKeyAction {
  const idx = selectionIndex(sel, rows) ?? 0;
  if (matchesKey(data, "up")) {
    if (idx === 0 && mode === "panel") return { kind: "clear" };
    return { kind: "select", selection: selectAt(rows, idx - 1) };
  }
  if (matchesKey(data, "down")) {
    return { kind: "select", selection: selectAt(rows, idx + 1) };
  }
  if (matchesKey(data, "escape")) return { kind: "clear" };
  if (matchesKey(data, "return")) {
    const taskId = idx > 0 ? rows[idx - 1]!.id : null;
    return { kind: "enter", taskId };
  }
  if (matchesKey(data, "x") && idx > 0) {
    return { kind: "stop", taskId: rows[idx - 1]!.id };
  }
  return { kind: "unhandled" };
}