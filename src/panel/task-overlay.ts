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
  /** enter on a row: close the overlay and open the live transcript view. */
  onOpen(taskId: string): void;
  /** esc: close the overlay. */
  onClose(): void;
  requestRender(): void;
}

/**
 * Centered /task overlay. A plain pi-tui Component (no editor): it owns the
 * keyboard while visible, so typing cannot steer tasks here — enter hands the
 * row to the live below-editor view, where typing steers. esc is the only way
 * out, and unhandled keys are swallowed so stray typing cannot leak into the
 * conversation under the modal.
 */
export class TaskOverlay implements Component {
  private selection: PanelSelection;
  private readonly theme: TaskOverlayTheme | null;
  private box: Box;

  constructor(
    private host: TaskOverlayHost,
    theme: TaskOverlayTheme | null = null,
  ) {
    this.theme = theme;
    const rows = host.getRows();
    this.selection = rows.length > 0 ? selectAt(rows, 1) : "main";
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
      if (taskId) this.host.onOpen(taskId);
      return;
    }
    const action = dispatchPanelKey(data, this.selection, rows, "panel");
    switch (action.kind) {
      case "select":
        this.selection = action.selection;
        this.host.requestRender();
        return;
      case "stop":
        this.host.onStop(action.taskId);
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
    return renderTaskPanel({
      rows,
      selection: this.selection,
      viewTaskId: null,
      now: this.host.now(),
      width,
      theme: this.theme,
      hint: `tasks (${rows.length}) — ↑↓ select · enter open · x stop/dismiss · esc close`,
    });
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
