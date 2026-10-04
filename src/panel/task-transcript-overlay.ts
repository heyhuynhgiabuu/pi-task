/**
 * Full-screen modal transcript view for one task, shown via
 * `ctx.ui.custom({ overlay: true })`. It masks the main conversation so only
 * ONE transcript is on screen (the above-editor pane this replaces left the
 * parent log visible), owns scroll keys — ↑↓/pgup/pgdn toward older lines —
 * and receives mouse-wheel events before the main transcript's own scroll
 * (pi-tui dispatches wheel to overlays first). Every other key feeds the
 * embedded steer editor (a real CustomEditor, so the steer prompt edits like
 * the parent agent's input); enter submits it and esc returns to main.
 *
 * Layout, top to bottom, mirroring pi's own screen: transcript, the compact
 * child status row, the editor (whose top border carries the working indicator
 * through CustomEditor's native `embedWorkingStatus`), then a footer with the
 * child's recorded identity/backend/model/thinking/cwd and the key hints.
 */

import {
  Box,
  CURSOR_MARKER,
  Loader,
  matchesKey,
  truncateToWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";

import type { TaskActivity } from "../task-activity.js";
import {
  footerRows,
  taskFooterSegments,
  taskStatusLine,
  type TaskContextInfo,
} from "./task-context.js";
import type { TaskTranscriptPane } from "./task-pane.js";

/**
 * The editor's top-border working indicator. pi renders `StatusIndicator` (a
 * `Loader` subclass) inside `CustomEditor.renderTopBorder`; the class itself is
 * not exported, so this mirrors its two border methods on the public Loader.
 */
export class TaskWorkingIndicator extends Loader {
  /** Required by the `StatusIndicator` shape `CustomEditor` accepts. */
  readonly kind = "working" as const;

  constructor(
    ui: TUI,
    colorFn: (text: string) => string,
    message: string,
    messageColorFn: (text: string) => string = colorFn,
  ) {
    super(ui, colorFn, messageColorFn, message);
  }

  /** Spinner + message, trimmed for the editor's border row. */
  renderInBorder(width: number): string {
    const line = super.render(width + 2)[1] ?? "";
    return truncateToWidth(line.startsWith(" ") ? line.slice(1).trimEnd() : line.trimEnd(), width, "");
  }

  /** Spinner only, for borders too narrow for the message. */
  renderSpinnerInBorder(width: number): string {
    return truncateToWidth(this.getRenderedIndicator(), width, "");
  }

  dispose(): void {
    this.stop();
  }
}

const OVERLAY_BG_TOKEN = "customMessageBg";
const ARROW_SCROLL = 3;
const PAGE_SCROLL = 10;
/** Footer key hints; scroll/steer/close are overlay-level and never abort. */
const KEY_HINTS = "\u2191\u2193 scroll \u00b7 pgup/pgdn page \u00b7 enter steer \u00b7 esc back";

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
  /**
   * `CustomEditor.setWorkingStatusIndicator`: draws the indicator inside the
   * editor's top border. Editors without it get a detached working row instead.
   */
  setWorkingStatusIndicator?(indicator: TaskWorkingIndicator | undefined): void;
}

export interface TaskTranscriptOverlayHost {
  taskId: string;
  /** Enter on a non-empty editor: send the text to the viewed task. */
  onSteer(text: string): void;
  /** esc: close the overlay and return to the main conversation. */
  onClose(): void;
  requestRender(): void;
  /**
   * Phase of the viewed child right now, or undefined when it has settled.
   * Undefined hides the working indicator, so a finished/cancelled/failed child
   * never keeps a spinner moving.
   */
  activity?(): TaskActivity | undefined;
  /**
   * Everything the panel knows about the viewed child (identity, status,
   * backend, cwd, and any model/thinking level the child recorded). Absent
   * hosts get no status row, only the transcript, editor and key hints.
   */
  context?(): TaskContextInfo | undefined;
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
  /**
   * The TUI that repaints the overlay. pi's own `Loader` animates the working
   * indicator against it; without it the overlay stays static (headless use).
   */
  ui?: TUI;
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
  private readonly ui: TUI | undefined;
  /**
   * The view's one working indicator, created on first activity: it animates in
   * the editor's top border when the editor supports it, and as a row above the
   * editor otherwise.
   */
  private indicator: TaskWorkingIndicator | undefined;
  private indicatorMessage: string | undefined;
  private indicatorRunning = false;
  /** True while the editor's border carries the indicator. */
  private indicatorAttached = false;
  /** Guards the double dispose: Pi disposes the component we dispose on close. */
  private disposed = false;

  constructor(options: TaskTranscriptOverlayOptions) {
    this.pane = options.pane;
    this.host = options.host;
    this.theme = options.theme;
    this.editor = options.editor;
    this.terminalRows = options.terminalRows;
    this.ui = options.ui;
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
    if (this.disposed) return;
    this.disposed = true;
    this.clearIndicator();
    this.pane.dispose();
    this.editor.dispose?.();
  }

  /** True when the editor can carry the working indicator in its top border. */
  private get embedsWorkingStatus(): boolean {
    return (
      typeof this.editor.setWorkingStatusIndicator === "function" &&
      this.animatableUi !== undefined
    );
  }

  /**
   * Put the child's current phase on the working indicator, or clear it when the
   * child has settled. pi's native placement is the editor's own top border
   * (`CustomEditor.embedWorkingStatus`); an editor that cannot embed it gets the
   * detached row above the editor instead.
   */
  private syncIndicator(activity: TaskActivity | undefined): void {
    const ui = this.animatableUi;
    if (!activity || !ui) {
      this.clearIndicator();
      return;
    }
    // `ui` is known to exist, so this only asks whether the editor can carry it.
    const embed = this.embedsWorkingStatus;
    this.indicator ??= embed
      ? new TaskWorkingIndicator(ui, (text) => this.color("accent", text), activity.label)
      : new TaskWorkingIndicator(
          ui,
          (frame) => this.color("accent", frame),
          activity.label,
          (text) => this.color("muted", text),
        );
    if (this.indicatorMessage !== activity.label) {
      this.indicatorMessage = activity.label;
      this.indicator.setMessage(activity.label);
    }
    if (!this.indicatorRunning) {
      this.indicatorRunning = true;
      this.indicator.start();
    }
    if (embed && !this.indicatorAttached) {
      this.indicatorAttached = true;
      this.editor.setWorkingStatusIndicator?.(this.indicator);
    }
  }

  /**
   * Detached working row, flush against the editor's top border (the Loader's
   * own leading spacer is dropped). Empty while the border carries the
   * indicator, and stopped when no row is left for it.
   */
  private workingRowLines(
    width: number,
    activity: TaskActivity | undefined,
    room: boolean,
  ): string[] {
    if (this.indicatorAttached || !activity) return [];
    if (!room) {
      this.clearIndicator();
      return [];
    }
    const lines = this.indicator?.render(width) ?? [];
    return lines[0] === "" ? lines.slice(1) : lines;
  }

  /** Detach the border indicator and stop the animation. */
  private clearIndicator(): void {
    if (this.indicatorAttached) {
      this.indicatorAttached = false;
      this.editor.setWorkingStatusIndicator?.(undefined);
    }
    if (this.indicatorRunning) {
      this.indicatorRunning = false;
      this.indicator?.dispose();
    }
  }

  /**
   * pi's `Loader` animates through the injected TUI. A host that provides no
   * repaint request (partial fakes, headless callers) gets a static panel
   * instead of an animation that would throw inside the render pass.
   */
  private get animatableUi(): TUI | undefined {
    const ui = this.ui as { requestRender?: unknown } | undefined;
    return ui && typeof ui.requestRender === "function" ? (ui as TUI) : undefined;
  }

  private color(token: string, text: string): string {
    return this.theme ? this.theme.fg(token, text) : text;
  }

  /**
   * Chrome order (top to bottom): transcript, compact child status row, editor
   * (with the working indicator in its top border), footer.
   *
   * Rows are allocated in priority order: the editor (it is the input), then the
   * detached working row, then one transcript row, then the footer facts, the
   * child status row, and the key hints. Chrome is only added while a transcript
   * row survives, so nothing is ever clipped off the bottom of the frame.
   */
  private renderBody(width: number): string[] {
    const rows = Math.max(0, Math.floor(this.terminalRows()));
    const info = this.host.context?.();
    const activity = this.host.activity?.();
    this.syncIndicator(activity);

    // The editor is the input: it keeps its rows up to the terminal height and
    // is cropped only when the terminal is shorter than the editor itself.
    const editorLines = fitEditorViewport(this.editor.render(width), rows);
    let remaining = Math.max(0, rows - editorLines.length);
    // The detached working row sits flush above the editor, so it is placed
    // before the footer/status chrome.
    const workingLines = this.workingRowLines(width, activity, remaining > 1);
    remaining -= workingLines.length;

    const footerLines: string[] = [];
    if (info) {
      for (const row of footerRows(taskFooterSegments(info), KEY_HINTS, width)) {
        if (remaining <= 1) break;
        footerLines.push(this.color("dim", truncateToWidth(row, width, "\u2026")));
        remaining -= 1;
      }
    } else if (remaining > 1) {
      footerLines.push(this.color("dim", truncateToWidth(KEY_HINTS, width, "\u2026")));
      remaining -= 1;
    }
    const statusLines: string[] = [];
    if (info && remaining > 1) {
      // The phase is stated once: in the editor's border, or in the detached
      // working row when the editor cannot carry it. Only if neither exists
      // does the status row name it.
      const phaseIsShownElsewhere = this.embedsWorkingStatus || workingLines.length > 0;
      statusLines.push(
        this.color(
          "dim",
          truncateToWidth(
            taskStatusLine(info, { includePhase: !phaseIsShownElsewhere }),
            width,
            "\u2026",
          ),
        ),
      );
      remaining -= 1;
    }
    const paneLines = this.pane.render(width, remaining);
    const fillerRows = Math.max(0, remaining - paneLines.length);
    const lines = [
      ...paneLines,
      ...Array.from({ length: fillerRows }, () => ""),
      ...statusLines,
      ...workingLines,
      ...editorLines,
      ...footerLines,
    ];
    return this.bgStart === ""
      ? lines
      : lines.map((line) => restoreOverlayBackground(line, this.bgStart));
  }
}
