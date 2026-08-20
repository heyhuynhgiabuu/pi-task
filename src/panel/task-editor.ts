/**
 * Custom editor wrapper for the task panel, Claude Code / pi-subtask style:
 * pressing down on an empty prompt moves selection into the task rows below
 * the editor; up/down navigate, enter opens the transcript view, x stops or
 * dismisses, escape returns to typing. While a transcript view is open, typing
 * is routed to the viewed task (steering) and pageUp/pageDown scroll.
 *
 * The editor steps aside when another extension owns a custom editor
 * (getEditorComponent() is taken): the widget stays display-only in that case.
 */

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";

import {
  dispatchPanelKey,
  selectAt,
  type PanelSelection,
  type PanelViewState,
  type TaskPanelRow,
} from "./panel-core.js";

export interface TaskPanelHost {
  /** Current panel state (selection + open view). */
  panelState(): PanelViewState;
  /** Rows in focused order (running first, then finished). */
  panelRows(): TaskPanelRow[];
  /** Apply a selection move. */
  onSelect(selection: PanelSelection): void;
  /** Enter on a task row opens its transcript; null returns to main. */
  onEnter(taskId: string | null): void;
  /** x on a task row: stop a running task, dismiss a finished one. */
  onStop(taskId: string): void;
  /** Send a follow-up prompt to the viewed task. */
  onSteer(text: string): void;
  /** Scroll the open transcript view. */
  onScrollView(delta: number): void;
  /** Close the transcript view back to the conversation. */
  onExitView(): void;
  requestRender(): void;
}

export class TaskPanelEditor extends CustomEditor {
  private readonly host: TaskPanelHost;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    host: TaskPanelHost,
  ) {
    super(tui, theme, keybindings);
    this.host = host;
  }

  override handleInput(data: string): void {
    const host = this.host;
    const state = host.panelState();
    const rows = host.panelRows();
    const viewOpen = state.viewTaskId !== null;

    if (viewOpen) {
      if (state.selection !== null) {
        // Navigation keys move the selection; anything else returns focus to
        // the editor so typing (and Enter-to-steer) targets the viewed task.
        const action = dispatchPanelKey(data, state.selection, rows, "view");
        if (action.kind === "select") {
          host.onSelect(action.selection);
          return;
        }
        if (action.kind === "clear") {
          host.onSelect(null);
          host.requestRender();
          return;
        }
        if (action.kind === "enter") {
          host.onSelect(null);
          host.onEnter(action.taskId);
          return;
        }
        if (action.kind === "stop") {
          host.onStop(action.taskId);
          return;
        }
        host.onSelect(null);
        host.requestRender();
        super.handleInput(data);
        return;
      }
      if (matchesKey(data, "escape")) {
        host.onExitView();
        return;
      }
      if (matchesKey(data, "pageUp")) {
        host.onScrollView(-10);
        return;
      }
      if (matchesKey(data, "pageDown")) {
        host.onScrollView(10);
        return;
      }
      if (
        matchesKey(data, "down") &&
        this.getText() === "" &&
        rows.length > 0
      ) {
        // Enter navigation at the top (main); one more down + enter returns
        // to the conversation.
        host.onSelect(selectAt(rows, 0));
        host.requestRender();
        return;
      }
      if (matchesKey(data, "return")) {
        const text = (this.getExpandedText?.() ?? this.getText()).trim();
        if (!text) return;
        if (text.startsWith("/")) {
          // Built-in commands still act on the main session.
          super.handleInput(data);
          return;
        }
        this.setText("");
        host.onSteer(text);
        return;
      }
      super.handleInput(data);
      return;
    }

    if (state.selection === null) {
      if (
        matchesKey(data, "down") &&
        this.getText() === "" &&
        rows.length > 0
      ) {
        host.onSelect(selectAt(rows, 0));
        host.requestRender();
        return;
      }
      super.handleInput(data);
      return;
    }

    const action = dispatchPanelKey(data, state.selection, rows, "panel");
    switch (action.kind) {
      case "select":
        host.onSelect(action.selection);
        return;
      case "clear":
        host.onSelect(null);
        host.requestRender();
        return;
      case "enter":
        host.onSelect(null);
        host.onEnter(action.taskId);
        return;
      case "stop":
        host.onStop(action.taskId);
        return;
      case "unhandled":
        // Any other key returns focus to the editor and types normally.
        host.onSelect(null);
        host.requestRender();
        super.handleInput(data);
        return;
    }
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    const viewedId = this.host.panelState().viewTaskId;
    if (viewedId && lines.length > 0) {
      // Label the input border with the viewed task so it is clear where
      // typed messages go (pi-subtask's @subtask-name marker). The border is
      // ANSI-colored, so truncation must be visible-width aware (raw slice
      // would split escape sequences and can over-width pi's renderer).
      const label = ` @${viewedId} `;
      const labelWidth = visibleWidth(label);
      if (visibleWidth(lines[0]!) >= labelWidth + 4) {
        lines[0] = truncateToWidth(lines[0]!, width - labelWidth - 2, "") + label + "──";
      }
    }
    return lines;
  }
}