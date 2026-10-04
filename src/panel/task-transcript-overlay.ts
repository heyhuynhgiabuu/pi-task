/**
 * Full-screen modal transcript view for one task, shown via
 * `ctx.ui.custom({ overlay: true })`. It masks the main conversation so only
 * ONE transcript is on screen (the above-editor pane this replaces left the
 * parent log visible), owns scroll keys — ↑↓/pgup/pgdn toward older lines —
 * and receives mouse-wheel events before the main transcript's own scroll
 * (pi-tui dispatches wheel to overlays first). Every other key feeds the
 * embedded steer editor (a real CustomEditor, so the steer prompt edits like
 * the parent agent's input); enter submits it and esc returns to main.
 */

import {
  Box,
  CURSOR_MARKER,
  matchesKey,
  truncateToWidth,
  type Component,
} from "@earendil-works/pi-tui";

import type { TaskTranscriptPane } from "./task-pane.js";

const OVERLAY_BG_TOKEN = "customMessageBg";
const ARROW_SCROLL = 3;
const PAGE_SCROLL = 10;

/** Reapply the overlay surface after SGR resets that clear a cell background. */
function restoreOverlayBackground(line: string, bgStart: string): string {
  return line.replace(/\x1b\[([0-9;]*)m/g, (sequence, parameters: string) => {
    const codes = parameters === "" ? [0] : parameters.split(";").map(Number);
    for (let index = 0; index < codes.length; index++) {
      const code = codes[index];
      if (code === 0 || code === 49) return `${sequence}${bgStart}`;
      // Skip extended color parameters: RGB channels may themselves be 0 or 49.
      if (code === 38 || code === 48 || code === 58) {
        if (codes[index + 1] === 5) index += 2;
        else if (codes[index + 1] === 2) index += 4;
      }
    }
    return sequence;
  });
}

/** Crop oversized editor output around its hardware-cursor marker. */
function fitEditorViewport(lines: string[], maxRows: number): string[] {
  if (maxRows <= 0) return [];
  if (lines.length <= maxRows) return lines;

  const cursorRow = lines.findIndex((line) => line.includes(CURSOR_MARKER));
  const maxStart = lines.length - maxRows;
  const start =
    cursorRow < 0
      ? maxStart
      : Math.min(maxStart, Math.max(0, cursorRow - Math.floor(maxRows / 2)));
  return lines.slice(start, start + maxRows);
}

/** Theme surface the overlay paints with: a solid mask needs `bg`. */
export interface TaskTranscriptOverlayTheme {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
}

/** The embedded steer input: the full parent-editor surface, narrowed. */
export interface SteerEditorLike {
  handleInput(data: string): void;
  render(width: number): string[];
  getText(): string;
  setText(text: string): void;
  dispose?(): void;
}

export interface TaskTranscriptOverlayHost {
  taskId: string;
  /** Enter on a non-empty editor: send the text to the viewed task. */
  onSteer(text: string): void;
  /** esc: close the overlay and return to the main conversation. */
  onClose(): void;
  requestRender(): void;
}

interface WheelLike {
  type: string;
  wheelDelta?: number;
}

export interface TaskTranscriptOverlayOptions {
  pane: TaskTranscriptPane;
  host: TaskTranscriptOverlayHost;
  theme: TaskTranscriptOverlayTheme | null;
  editor: SteerEditorLike;
  terminalRows: () => number;
}

export class TaskTranscriptOverlay implements Component {
  private readonly pane: TaskTranscriptPane;
  private readonly host: TaskTranscriptOverlayHost;
  private readonly theme: TaskTranscriptOverlayTheme | null;
  private readonly editor: SteerEditorLike;
  private readonly terminalRows: () => number;
  private readonly box: Box;
  /** Raw background escape for the panel fill (reset stripped). */
  private readonly bgStart: string;

  constructor(options: TaskTranscriptOverlayOptions) {
    this.pane = options.pane;
    this.host = options.host;
    this.theme = options.theme;
    this.editor = options.editor;
    this.terminalRows = options.terminalRows;
    this.bgStart = this.theme?.bg ? this.theme.bg(OVERLAY_BG_TOKEN, "").replace("\x1b[49m", "") : "";
    this.box = new Box(
      1,
      0,
      this.theme?.bg ? (text) => this.theme!.bg(OVERLAY_BG_TOKEN, text) : undefined,
    );
    this.box.addChild({
      render: (width: number) => this.renderBody(width),
      invalidate: () => this.pane.invalidate(),
    });
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.host.onClose();
      return;
    }
    // Pane semantics: positive delta scrolls back toward older lines. Scroll
    // keys are overlay-level and never reach the steer editor.
    if (matchesKey(data, "up")) {
      this.pane.scrollBy(ARROW_SCROLL);
      this.host.requestRender();
      return;
    }
    if (matchesKey(data, "down")) {
      this.pane.scrollBy(-ARROW_SCROLL);
      this.host.requestRender();
      return;
    }
    if (matchesKey(data, "pageUp")) {
      this.pane.scrollBy(PAGE_SCROLL);
      this.host.requestRender();
      return;
    }
    if (matchesKey(data, "pageDown")) {
      this.pane.scrollBy(-PAGE_SCROLL);
      this.host.requestRender();
      return;
    }
    if (matchesKey(data, "return")) {
      const text = this.editor.getText().trim();
      if (text) {
        this.editor.setText("");
        this.host.onSteer(text);
      }
      this.host.requestRender();
      return;
    }
    // Everything else edits the steer prompt (full parent-editor behavior:
    // cursor movement, deletion, history keys the host editor supports).
    this.editor.handleInput(data);
    this.host.requestRender();
  }

  /** Wheel over the overlay scrolls the transcript, not the main log. */
  handleMouse(event: WheelLike): { handled: boolean } | undefined {
    if (event.type !== "wheel" || !event.wheelDelta) return undefined;
    // pi-tui sends negative deltas for wheel-up; pane positive = older.
    this.pane.scrollBy(-event.wheelDelta);
    return { handled: true };
  }

  render(width: number): string[] {
    return this.box.render(width);
  }

  invalidate(): void {
    this.box.invalidate();
  }

  dispose(): void {
    this.pane.dispose();
    this.editor.dispose?.();
  }

  private renderBody(width: number): string[] {
    const fg = (color: string, text: string) =>
      this.theme ? this.theme.fg(color, text) : text;
    const hint = truncateToWidth(
      fg(
        "dim",
        ` @${this.host.taskId} — ↑↓ scroll · pgup/pgdn page · steer below · esc back to main`,
      ),
      width,
      "…",
    );
    // Re-apply the panel background after every ANSI reset inside editor
    // lines: the editor's cursor/fg resets would otherwise punch holes in
    // the fill.
    let editorLines = this.editor.render(width);
    const terminalRows = Math.max(0, Math.floor(this.terminalRows()));
    // Keep the editor (and its cursor) before transcript content when the
    // terminal is too short for the normal hint + transcript + input layout.
    const hintLines =
      terminalRows > 0 && editorLines.length + 1 <= terminalRows ? [hint] : [];
    editorLines = fitEditorViewport(
      editorLines,
      Math.max(0, terminalRows - hintLines.length),
    );
    const paneBudget = Math.max(
      0,
      terminalRows - hintLines.length - editorLines.length,
    );
    const paneLines = this.pane.render(width, paneBudget);
    const fillerRows = Math.max(0, paneBudget - paneLines.length);
    const lines = [
      ...hintLines,
      ...paneLines,
      ...Array.from({ length: fillerRows }, () => ""),
      ...editorLines,
    ];
    return this.bgStart === ""
      ? lines
      : lines.map((line) => restoreOverlayBackground(line, this.bgStart));
  }
}
