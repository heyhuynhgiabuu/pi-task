import { Box, matchesKey, type Component } from "@earendil-works/pi-tui";

import {
  dispatchPanelKey,
  selectAt,
  type PanelSelection,
  type TaskPanelRow,
} from "./panel-core.js";
import { renderTaskPanel } from "../task-widget.js";

/** Theme surface the overlay paints with: a solid background needs `bg`. */
export interface TaskOverlayTheme {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
}

/** Same panel background pi paints behind extension custom messages. */
const OVERLAY_BG_TOKEN = "customMessageBg";

/**
 * Keyboard contract between the overlay component and the widget controller.
 * Rows are pulled fresh on every render/input so the overlay mirrors live
 * polling updates without owning any task state.
 */
export interface TaskOverlayHost {
  /** Fresh rows (running first, then finished). */
  getRows(): TaskPanelRow[];
  now(): number;
  /** x on a row: stop a running task, dismiss a finished one. */
  onStop(taskId: string): void;
  /** Select an agent; null returns to the main conversation. */
  onOpen(taskId: string | null): void;
  /** esc: close the overlay. */
  onClose(): void;
  requestRender(): void;
}

export interface TaskOverlayOptions {
  mode?: "tasks" | "agents";
  /** Currently shown task; null means the main conversation. */
  shownTaskId?: string | null;
  /** Read the shown task live while the overlay is open. */
  getShownTaskId?: () => string | null;
}

/**
 * Centered task-browser/agent-switcher overlay. A plain pi-tui Component (no
 * editor): it owns the keyboard while visible, so typing cannot steer tasks
 * here — enter hands the selected row to the live below-editor view. In agent
 * mode, escape cancels without changing the shown transcript. Unhandled keys
 * are swallowed so stray typing cannot leak into the conversation under it.
 */
export class TaskOverlay implements Component {
  private selection: PanelSelection;
  private readonly theme: TaskOverlayTheme | null;
  private readonly mode: "tasks" | "agents";
  private readonly getShownTaskId: () => string | null;
  private selectionFollowsShown = true;
  private box: Box;

  constructor(
    private host: TaskOverlayHost,
    theme: TaskOverlayTheme | null = null,
    options: TaskOverlayOptions = {},
  ) {
    this.theme = theme;
    this.mode = options.mode ?? "tasks";
    this.getShownTaskId = options.getShownTaskId ?? (() => options.shownTaskId ?? null);
    const rows = host.getRows();
    if (this.mode === "agents") {
      this.selection = this.selectionForShown(rows);
    } else {
      this.selection = rows.length > 0 ? selectAt(rows, 1) : "main";
    }
    this.box = new Box(
      1,
      1,
      theme ? (text) => theme.bg(OVERLAY_BG_TOKEN, text) : undefined,
    );
    this.box.addChild({
      render: (width) => this.renderBody(width),
      invalidate: () => {},
    });
  }

  handleInput(data: string): void {
    const rows = this.host.getRows();
    this.reconcile(rows);
    this.syncSelectionToShown(rows);
    // dispatchPanelKey maps escape and top-up to the same "clear" action; the
    // overlay must close only on escape, so both are handled before dispatch.
    if (matchesKey(data, "escape")) {
      this.host.onClose();
      return;
    }
    if (matchesKey(data, "return")) {
      const taskId =
        this.selection !== null && this.selection !== "main"
          ? this.selection.taskId
          : null;
      if (this.mode === "agents") this.host.onOpen(taskId);
      else if (taskId) this.host.onOpen(taskId);
      return;
    }
    const action = dispatchPanelKey(data, this.selection, rows, "panel");
    switch (action.kind) {
      case "select":
        this.selection = action.selection;
        if (this.mode === "agents") this.selectionFollowsShown = false;
        this.host.requestRender();
        return;
      case "stop":
        if (this.mode === "tasks") this.host.onStop(action.taskId);
        return;
      case "clear":
      case "enter":
      case "unhandled":
        // Top-up stays; enter-on-main and stray keys are swallowed.
        return;
    }
  }

  render(width: number): string[] {
    return this.box.render(width);
  }

  /** Component contract: the body rebuilds from live rows each render. */
  invalidate(): void {
    this.box.invalidate();
  }

  private renderBody(width: number): string[] {
    const rows = this.host.getRows();
    this.reconcile(rows);
    this.syncSelectionToShown(rows);
    return renderTaskPanel({
      rows,
      selection: this.selection,
      viewTaskId: null,
      now: this.host.now(),
      width,
      theme: this.theme,
      hint:
        this.mode === "agents"
          ? `Switch to: ${rows.length + 1} agents — ↑↓ select · enter switch · esc close`
          : `tasks (${rows.length}) — ↑↓ select · enter open · x stop/dismiss · esc close`,
      ...(this.mode === "agents"
        ? { shownTaskId: this.getShownTaskId(), showTaskIds: true }
        : {}),
    });
  }

  private selectionForShown(rows: readonly TaskPanelRow[]): PanelSelection {
    const shownTaskId = this.getShownTaskId();
    const index = shownTaskId
      ? rows.findIndex((row) => row.id === shownTaskId) + 1
      : 0;
    return selectAt(rows, Math.max(0, index));
  }

  private syncSelectionToShown(rows: readonly TaskPanelRow[]): void {
    if (this.mode === "agents" && this.selectionFollowsShown) {
      this.selection = this.selectionForShown(rows);
    }
  }

  /** Follow rows that vanish (finished rows dismissed, tasks removed). */
  private reconcile(rows: readonly TaskPanelRow[]): void {
    if (this.selection !== null && this.selection !== "main") {
      const exists = rows.some(
        (r) => r.id === (this.selection as { taskId: string }).taskId,
      );
      if (!exists) {
        this.selection = rows.length > 0 ? selectAt(rows, 1) : "main";
      }
    }
  }
}
