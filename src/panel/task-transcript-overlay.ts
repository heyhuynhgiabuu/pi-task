/**
 * Full-screen modal transcript view for one task, shown via
 * `ctx.ui.custom({ overlay: true })`. It masks the main conversation so only
 * ONE transcript is on screen (the above-editor pane this replaces left the
 * parent log visible), owns scroll keys — ↑↓/pgup/pgdn toward older lines —
 * and receives mouse-wheel events before the main transcript's own scroll
 * (pi-tui dispatches wheel to overlays first). Scrolling and the configured
 * tool-expand key stay overlay-level; other editing keys feed the embedded
 * steer editor (a real CustomEditor); enter steers the viewed child and esc
 * returns to main.
 *
 * Layout, top to bottom, mirroring pi's own screen: transcript, the compact
 * child status row, the editor (whose top border carries the working indicator
 * through CustomEditor's native `embedWorkingStatus`), then a footer with the
 * child's recorded identity/backend/model/thinking/cwd and the key hints.
 */

import {
  backgroundAnsi,
  Box,
  compositeTuiLine,
  CURSOR_MARKER,
  Loader,
  matchesKey,
  rgbColor,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Color,
  type Component,
  type Editor,
  type Focusable,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  type TerminalColorMode,
} from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";

import type { TaskActivity } from "../task-activity.js";
import { formatChildMetadata, type ChildUsageMetadata } from "./child-metadata.js";
import {
  footerRows,
  taskFooterSegments,
  taskStatusLine,
  type TaskContextInfo,
} from "./task-context.js";
import type { TaskTranscriptPane } from "./task-pane.js";
import {
  createChildHistoryPicker,
  createChildSelector,
  type ChildHistoryPickerComponent,
  type ChildSelectorComponent,
} from "./child-selectors.js";
import type {
  ChildBuiltinSelectorData,
  ChildHistoryOption,
  ChildHistoryPickerData,
  ChildSessionInfo,
} from "../types.js";

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
const SESSION_INFO_HINTS = "\u2191\u2193 scroll \u00b7 pgup/pgdn page \u00b7 esc back";

type SgrBackgroundEffect = "reset" | "set" | undefined;

/** The last background-affecting operation in an SGR sequence, if any. */
function sgrBackgroundEffect(parameters: string): SgrBackgroundEffect {
  const codes = parameters === "" ? [0] : parameters.split(";").map(Number);
  let effect: SgrBackgroundEffect;
  for (let index = 0; index < codes.length; index++) {
    const code = codes[index];
    if (code === 0 || code === 49) {
      effect = "reset";
    } else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
      effect = "set";
    } else if (code === 38 || code === 48 || code === 58) {
      // Skip extended color payloads: RGB channels and palette indices can be 0 or 49.
      const mode = codes[index + 1];
      if (mode === 5 && codes[index + 2] !== undefined) {
        if (code === 48) effect = "set";
        index += 2;
      } else if (mode === 2 && codes[index + 4] !== undefined) {
        if (code === 48) effect = "set";
        index += 4;
      }
    }
  }
  return effect;
}

/** Whether a legacy theme result contains an explicit background color. */
function hasExplicitBackground(style: string): boolean {
  for (const match of style.matchAll(/\x1b\[([0-9;]*)m/g)) {
    if (sgrBackgroundEffect(match[1] ?? "") === "set") return true;
  }
  return false;
}

/** Reapply the overlay surface only when the final SGR operation cleared its background. */
function restoreOverlayBackground(line: string, bgStart: string): string {
  return line.replace(/\x1b\[([0-9;]*)m/g, (sequence, parameters: string) =>
    sgrBackgroundEffect(parameters) === "reset" ? `${sequence}${bgStart}` : sequence,
  );
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

/** Fill the complete overlay viewport while keeping the editor's cursor row visible. */
function fillEditorViewport(lines: string[], maxRows: number): string[] {
  const visible = fitEditorViewport(lines, maxRows);
  return visible.length >= maxRows
    ? visible
    : [...visible, ...Array.from({ length: maxRows - visible.length }, () => "")];
}

/** Theme surface the overlay paints with: a solid mask needs `bg`. */
export interface TaskTranscriptOverlayTheme {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  /** Concrete, terminal-resolved Pi theme colors (optional for lightweight host mocks). */
  colors?: { customMessageBg: Color };
  /** ANSI encoding for concrete theme colors. */
  getColorMode?(): TerminalColorMode;
  /** Used only when a legacy theme exposes terminal-default background. */
  appearance?: "dark" | "light";
}

/** The embedded steer input: the full parent-editor surface, narrowed. */
export interface SteerEditorLike
  extends Pick<Editor, "handleInput" | "render" | "getText" | "setText"> {
  setAutocompleteProvider?: Editor["setAutocompleteProvider"];
  /** Public pi-tui state used to route selection keys while a menu is open. */
  isShowingAutocomplete?: Editor["isShowingAutocomplete"];
  /** Public Editor submit callback. */
  onSubmit?: Editor["onSubmit"];
  /** Public editor change callback; the host can preserve per-child drafts. */
  onChange?: Editor["onChange"];
  /** Focus flag propagated to the editor when a child selector opens/closes. */
  focused?: boolean;
  dispose?(): void;
  /**
   * `CustomEditor.setWorkingStatusIndicator`: draws the indicator inside the
   * editor's top border. Editors without it get a detached working row instead.
   */
  setWorkingStatusIndicator?(indicator: TaskWorkingIndicator | undefined): void;
}

export interface TaskTranscriptOverlayMessage {
  message: string;
  level: "info" | "warning" | "error";
}

export interface TaskTranscriptOverlayHost {
  taskId: string;
  /** Enter on a non-empty editor: send the text to the viewed task. */
  onSteer(text: string): void;
  /** Historical parent-scoped transcript mode: browsing only, never steering. */
  readOnly?(): boolean;
  /** Latest ephemeral child command result/denial; never part of the transcript. */
  notice?(): TaskTranscriptOverlayMessage | undefined;
  /** Browse one selected project-database durable child transcript without resuming it. */
  onResumeHistory?(taskId: string): void;
  /** Navigate one adjacent owner-scoped child; eligibility is rechecked after async reads. */
  onNavigateSibling?(direction: -1 | 1, stillEligible: () => boolean): void | Promise<void>;
  /** Cancel any pending sibling read after typing, Esc, close, or another view change. */
  onCancelSiblingNavigation?(): void;
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
  /** Cumulative usage and current context measured from this child only. */
  childMetadata?(): ChildUsageMetadata | undefined;
}

const OVERLAY_HORIZONTAL_PADDING = 1;
const AUTOCOMPLETE_ROUTING_KEYBINDINGS = [
  "tui.select.cancel",
  "tui.select.up",
  "tui.select.down",
  "tui.editor.pageUp",
  "tui.editor.pageDown",
] as const;

type ExpandKeybindings = Pick<KeybindingsManager, "matches">;

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
  /** The same Pi keybindings used by the host editor. */
  keybindings?: ExpandKeybindings;
}

export class TaskTranscriptOverlay implements Component, Focusable {
  private readonly pane: TaskTranscriptPane;
  private readonly host: TaskTranscriptOverlayHost;
  private readonly theme: TaskTranscriptOverlayTheme | null;
  private readonly editor: SteerEditorLike;
  private readonly terminalRows: () => number;
  private readonly box: Box;
  /** Current explicit surface shared by panel fill and restored SGR resets. */
  private bgStart = "";
  private readonly ui: TUI | undefined;
  private readonly keybindings: ExpandKeybindings | undefined;
  /** Search selector currently borrowing this child's editor view. */
  private childSelector: ChildSelectorComponent | undefined;
  private childHistoryPicker: ChildHistoryPickerComponent | undefined;
  private childHistoryView:
    | { pane: TaskTranscriptPane; option: ChildHistoryOption; metadata?: ChildUsageMetadata }
    | undefined;
  /** Read-only child session details temporarily replace the transcript/editor. */
  private childSessionInfo: ChildSessionInfo | undefined;
  private childSessionInfoScroll = 0;
  /**
   * Scoped compositing override installed while this fullscreen overlay is
   * open, so parent transcript image rows cannot punch a default-background
   * hole in the overlay (pi-tui 1.0.4 `compositeTuiLine` keeps image base
   * lines and drops the overlay's line for that row). The original method is
   * restored on dispose. TS-private but a stable prototype method in pi-tui;
   * the cast is the documented boundary escape.
   */
  private overriddenComposite:
    | { target: object; original: (base: string, line: string, col: number, w: number, total: number) => string }
    | undefined;
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
  /** One sibling load at a time; invalidated separately from the underlying read. */
  private siblingNavigationPending = false;
  private siblingNavigationSerial = 0;
  /** Guards the double dispose: Pi disposes the component we dispose on close. */
  private disposed = false;
  private overlayFocused = true;

  /** The custom overlay is the TUI focus target and delegates it to its editor. */
  get focused(): boolean {
    return this.overlayFocused;
  }

  set focused(value: boolean) {
    this.overlayFocused = value;
    this.syncEditorFocus();
  }

  private syncEditorFocus(): void {
    this.editor.focused = this.overlayFocused &&
      !this.childSelector &&
      !this.childHistoryPicker &&
      !this.childSessionInfo &&
      !this.childHistoryView &&
      !this.host.readOnly?.();
  }

  constructor(options: TaskTranscriptOverlayOptions) {
    this.pane = options.pane;
    this.host = options.host;
    this.theme = options.theme;
    this.editor = options.editor;
    this.terminalRows = options.terminalRows;
    this.ui = options.ui;
    this.keybindings = options.keybindings;
    this.syncEditorFocus();
    this.editor.onSubmit = (submittedText) => {
      const text = submittedText.trim();
      if (text) this.host.onSteer(text);
    };
    this.box = new Box(
      OVERLAY_HORIZONTAL_PADDING,
      0,
      this.theme ? (text) => this.paintOverlayBackground(text) : undefined,
    );
    this.box.addChild({
      render: (width: number) => this.renderBody(width),
      invalidate: () => {
        this.pane.invalidate();
        this.childHistoryView?.pane.invalidate();
      },
    });
    this.installImageRowOverride();
  }

  /**
   * While a fullscreen child overlay is visible, every row it covers must end
   * up with the overlay's opaque surface — including rows whose parent line is
   * a terminal-image escape (kitty/iTerm2). pi-tui keeps image base lines and
   * drops the overlay line for that row, leaving a default-background hole
   * that shows the terminal's blur. This override composites the overlay over
   * an empty base for such rows and is reverted in dispose.
   */
  private installImageRowOverride(): void {
    const target = this.ui as unknown as
      | {
          compositeLineAt?: (
            baseLine: string,
            overlayLine: string,
            startCol: number,
            overlayWidth: number,
            totalWidth: number,
          ) => string;
        }
      | undefined;
    if (typeof target?.compositeLineAt !== "function") return;
    const original = target.compositeLineAt.bind(target);
    target.compositeLineAt = (
      baseLine: string,
      overlayLine: string,
      startCol: number,
      overlayWidth: number,
      totalWidth: number,
    ): string => {
      if (baseLine.includes("\x1b_G") || baseLine.includes("\x1b]1337;")) {
        // Image rows are replaced by the overlay's own (opaque) row.
        return compositeTuiLine("", overlayLine, startCol, overlayWidth, totalWidth);
      }
      return original(baseLine, overlayLine, startCol, overlayWidth, totalWidth);
    };
    this.overriddenComposite = { target: target as object, original };
  }

  private restoreImageRowOverride(): void {
    const overridden = this.overriddenComposite;
    if (!overridden) return;
    this.overriddenComposite = undefined;
    const target = overridden.target as {
      compositeLineAt?: unknown;
    };
    if (target.compositeLineAt === undefined) return;
    target.compositeLineAt = overridden.original;
  }

  /** Replace the child editor with its read-only session information screen. */
  openChildSessionInfo(info: ChildSessionInfo): boolean {
    this.cancelSiblingNavigation();
    this.closeChildHistoryPicker();
    this.closeChildHistoryTranscript();
    this.childSelector?.dispose();
    this.childSelector = undefined;
    this.childSessionInfo = info;
    this.childSessionInfoScroll = 0;
    this.syncEditorFocus();
    this.clearIndicator();
    this.box.invalidate();
    this.host.requestRender();
    return true;
  }

  private closeChildSessionInfo(): void {
    if (!this.childSessionInfo) return;
    this.childSessionInfo = undefined;
    this.childSessionInfoScroll = 0;
    this.syncEditorFocus();
    this.box.invalidate();
    this.host.requestRender();
  }

  /** Open the project-database durable-child history picker; selection only browses. */
  openChildHistoryPicker(data: ChildHistoryPickerData): boolean {
    if (!this.ui) return false;
    this.cancelSiblingNavigation();
    this.closeChildSessionInfo();
    this.closeChildHistoryTranscript();
    this.childSelector?.dispose();
    this.childSelector = undefined;
    this.childHistoryPicker?.dispose();
    this.childHistoryPicker = createChildHistoryPicker({
      tui: this.ui,
      theme: this.theme,
      rows: this.terminalRows(),
      data,
      onSelect: (taskId) => {
        this.closeChildHistoryPicker();
        this.host.onResumeHistory?.(taskId);
      },
      onCancel: () => this.closeChildHistoryPicker(),
    });
    this.syncEditorFocus();
    this.clearIndicator();
    this.box.invalidate();
    this.host.requestRender();
    return true;
  }

  private closeChildHistoryPicker(): void {
    const picker = this.childHistoryPicker;
    if (!picker) return;
    this.childHistoryPicker = undefined;
    picker.dispose();
    this.syncEditorFocus();
    this.box.invalidate();
    this.host.requestRender();
  }

  /** Show a separately hydrated historical transcript inside this child view. */
  openChildHistoryTranscript(
    pane: TaskTranscriptPane,
    option: ChildHistoryOption,
    metadata?: ChildUsageMetadata,
  ): boolean {
    this.cancelSiblingNavigation();
    this.closeChildSessionInfo();
    this.closeChildHistoryPicker();
    this.childSelector?.dispose();
    this.childSelector = undefined;
    this.closeChildHistoryTranscript();
    this.childHistoryView = { pane, option, ...(metadata ? { metadata } : {}) };
    this.syncEditorFocus();
    this.clearIndicator();
    this.box.invalidate();
    this.host.requestRender();
    return true;
  }

  private closeChildHistoryTranscript(): void {
    const view = this.childHistoryView;
    if (!view) return;
    this.childHistoryView = undefined;
    view.pane.dispose();
    this.syncEditorFocus();
    this.box.invalidate();
    this.host.requestRender();
  }

  /** Replace the child editor with an in-view child-only selector. */
  openChildSelector(data: ChildBuiltinSelectorData): boolean {
    if (!this.ui) return false;
    this.cancelSiblingNavigation();
    this.closeChildSessionInfo();
    this.closeChildHistoryPicker();
    this.closeChildHistoryTranscript();
    this.childSelector?.dispose();
    this.childSelector = createChildSelector({
      tui: this.ui,
      theme: this.theme,
      rows: this.terminalRows(),
      data,
      onSelect: (command) => {
        this.closeChildSelector();
        this.host.onSteer(command);
      },
      onCancel: () => this.closeChildSelector(),
    });
    this.syncEditorFocus();
    this.clearIndicator();
    this.box.invalidate();
    this.host.requestRender();
    return true;
  }

  private closeChildSelector(): void {
    const selector = this.childSelector;
    if (!selector) return;
    this.childSelector = undefined;
    selector.dispose();
    this.syncEditorFocus();
    this.box.invalidate();
    this.host.requestRender();
  }

  handleInput(data: string): void {
    const horizontalDirection = this.horizontalArrowDirection(data);
    if (this.siblingNavigationPending) {
      // Repeated plain arrows do not start concurrent reads. Any other key
      // invalidates the pending selection before native/editor handling.
      if (horizontalDirection !== undefined) return;
      this.cancelSiblingNavigation();
    }
    if (this.childSelector) {
      this.childSelector.handleInput(data);
      this.host.requestRender();
      return;
    }
    if (this.childHistoryPicker) {
      this.childHistoryPicker.handleInput(data);
      this.host.requestRender();
      return;
    }
    if (this.childSessionInfo) {
      if (matchesKey(data, "escape")) {
        this.closeChildSessionInfo();
      } else if (matchesKey(data, "up")) {
        this.scrollChildSessionInfo(-ARROW_SCROLL);
      } else if (matchesKey(data, "down")) {
        this.scrollChildSessionInfo(ARROW_SCROLL);
      } else if (matchesKey(data, "pageUp")) {
        this.pageChildSessionInfo(-1);
      } else if (matchesKey(data, "pageDown")) {
        this.pageChildSessionInfo(1);
      }
      return;
    }
    if (this.childHistoryView) {
      const pane = this.childHistoryView.pane;
      if (matchesKey(data, "escape")) {
        this.closeChildHistoryTranscript();
      } else if (this.keybindings?.matches(data, "app.tools.expand")) {
        pane.toggleToolsExpanded?.();
        this.host.requestRender();
      } else if (matchesKey(data, "up")) {
        pane.scrollBy(ARROW_SCROLL);
        this.host.requestRender();
      } else if (matchesKey(data, "down")) {
        pane.scrollBy(-ARROW_SCROLL);
        this.host.requestRender();
      } else if (matchesKey(data, "pageUp")) {
        this.pageChildHistoryTranscript(-1);
      } else if (matchesKey(data, "pageDown")) {
        this.pageChildHistoryTranscript(1);
      }
      return;
    }
    if (horizontalDirection !== undefined && this.host.onNavigateSibling && this.canNavigateSibling()) {
      this.startSiblingNavigation(horizontalDirection);
      return;
    }
    if (this.host.readOnly?.()) {
      if (matchesKey(data, "escape")) {
        this.host.onClose();
      } else if (this.keybindings?.matches(data, "app.tools.expand")) {
        this.pane.toggleToolsExpanded?.();
        this.host.requestRender();
      } else if (matchesKey(data, "up")) {
        this.pane.scrollBy(ARROW_SCROLL);
        this.host.requestRender();
      } else if (matchesKey(data, "down")) {
        this.pane.scrollBy(-ARROW_SCROLL);
        this.host.requestRender();
      } else if (matchesKey(data, "pageUp")) {
        this.pane.scrollBy(PAGE_SCROLL);
        this.host.requestRender();
      } else if (matchesKey(data, "pageDown")) {
        this.pane.scrollBy(-PAGE_SCROLL);
        this.host.requestRender();
      }
      return;
    }
    const autocompleteActive = this.editor.isShowingAutocomplete?.() ?? false;
    if (
      matchesKey(data, "escape") &&
      !(autocompleteActive && this.keybindings?.matches(data, "tui.select.cancel"))
    ) {
      this.host.onClose();
      return;
    }
    if (this.keybindings?.matches(data, "app.tools.expand")) {
      this.pane.toggleToolsExpanded?.();
      this.host.requestRender();
      return;
    }
    // Match the key actions the native Editor handles while its completion list
    // is active. In particular, select-up/down may be remapped away from arrows.
    // Its pageUp/pageDown actions also belong to the editor, not this pane.
    if (
      autocompleteActive &&
      AUTOCOMPLETE_ROUTING_KEYBINDINGS.some((action) => this.keybindings?.matches(data, action))
    ) {
      this.editor.handleInput(data);
      this.host.requestRender();
      return;
    }
    // Pane semantics: positive delta scrolls back toward older lines. Scroll
    // keys are overlay-level and never reach the steer editor unless the native
    // completion menu above owns one of its selection/navigation bindings.
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
      // Let Pi's editor accept the selected item first. Slash completion may
      // then submit through the native onSubmit callback; file/argument
      // completion only fills the editor and remains unsubmitted.
      if (this.editor.isShowingAutocomplete?.()) {
        this.editor.handleInput(data);
        this.host.requestRender();
        return;
      }
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

  /** Wheel scrolls the transcript; clicks are forwarded only to native tool rows. */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.childSelector) {
      const result = this.childSelector.handleMouse?.({
        ...event,
        x: event.x - OVERLAY_HORIZONTAL_PADDING,
        width: Math.max(1, event.width - OVERLAY_HORIZONTAL_PADDING * 2),
      });
      if (result?.handled) this.host.requestRender();
      return result;
    }
    if (this.childHistoryPicker) {
      const result = this.childHistoryPicker.handleMouse?.({
        ...event,
        x: event.x - OVERLAY_HORIZONTAL_PADDING,
        width: Math.max(1, event.width - OVERLAY_HORIZONTAL_PADDING * 2),
      });
      if (result?.handled) this.host.requestRender();
      return result;
    }
    if (this.childSessionInfo) {
      if (event.type !== "wheel" || !event.wheelDelta) return undefined;
      // pi-tui sends negative deltas for wheel-up; negative info offset returns toward the heading.
      this.scrollChildSessionInfo(event.wheelDelta * ARROW_SCROLL);
      return { handled: true };
    }
    if (this.childHistoryView) {
      if (event.type !== "wheel" || !event.wheelDelta) return undefined;
      this.childHistoryView.pane.scrollBy(-event.wheelDelta);
      this.host.requestRender();
      return { handled: true };
    }
    if (event.type === "wheel" && event.wheelDelta) {
      // pi-tui sends negative deltas for wheel-up; pane positive = older.
      this.pane.scrollBy(-event.wheelDelta);
      return { handled: true };
    }
    // Press/drag/release/move remain with the host so selection keeps working.
    if (event.type !== "click" || event.button !== "left") return undefined;
    // The overlay paints through a Box with one cell of horizontal padding on
    // either side. Match Box.handleMouse's bounds and coordinates before the
    // pane routes this row to the tool component.
    if (
      event.x < OVERLAY_HORIZONTAL_PADDING ||
      event.x >= event.width - OVERLAY_HORIZONTAL_PADDING
    ) {
      return undefined;
    }
    const hit = this.pane.hitTest?.(event.y);
    if (!hit) return undefined;
    const nativeEvent: TuiMouseEvent = {
      ...event,
      x: event.x - OVERLAY_HORIZONTAL_PADDING,
      y: hit.y,
      width: Math.max(1, event.width - OVERLAY_HORIZONTAL_PADDING * 2),
      height: hit.height,
    };
    const result = hit.dispatchMouse
      ? hit.dispatchMouse(nativeEvent)
      : hit.component.handleMouse?.(nativeEvent);
    if (!result?.handled) return undefined;
    this.host.requestRender();
    return result;
  }

  render(width: number): string[] {
    // Theme colors can resolve after a terminal report or change with appearance.
    this.bgStart = this.resolveOverlayBackground();
    return this.box.render(width);
  }

  private resolveOverlayBackground(): string {
    if (!this.theme) return "";
    const colorMode = this.theme.getColorMode?.() ?? "truecolor";
    const resolvedColor = this.theme.colors?.customMessageBg;
    if (resolvedColor) return backgroundAnsi(resolvedColor, colorMode);

    const legacySurface = this.theme.bg?.(OVERLAY_BG_TOKEN, "").replace(/\x1b\[49m/g, "") ?? "";
    if (legacySurface && hasExplicitBackground(legacySurface)) return legacySurface;

    if (this.theme.appearance) {
      const fallbackColor = this.theme.appearance === "dark" ? rgbColor(0, 0, 0) : rgbColor(255, 255, 255);
      return backgroundAnsi(fallbackColor, colorMode);
    }
    return "";
  }

  private paintOverlayBackground(text: string): string {
    return this.bgStart === "" ? text : `${this.bgStart}${text}\x1b[49m`;
  }

  invalidate(): void {
    this.box.invalidate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancelSiblingNavigation();
    this.disposed = true;
    this.overlayFocused = false;
    this.syncEditorFocus();
    this.restoreImageRowOverride();
    this.childSelector?.dispose();
    this.childSelector = undefined;
    this.childHistoryPicker?.dispose();
    this.childHistoryPicker = undefined;
    this.childHistoryView?.pane.dispose();
    this.childHistoryView = undefined;
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

  private childMetadataLine(metadata: ChildUsageMetadata, width: number): string {
    const display = formatChildMetadata(metadata);
    const context = truncateToWidth(display.context, width, "…");
    const usage = display.usage.join(" ");
    const usageWidth = Math.max(0, width - visibleWidth(context) - (usage ? 1 : 0));
    const usageText = usage && usageWidth > 0
      ? truncateToWidth(usage, usageWidth, "…")
      : "";
    const contextText = this.color(display.contextColor ?? "dim", context);
    return usageText
      ? `${this.color("dim", usageText)} ${contextText}`
      : contextText;
  }

  private childSummaryLine(label: string, metadata: ChildUsageMetadata, width: number, color = "dim"): string {
    const stats = this.childMetadataLine(metadata, width);
    const labelWidth = Math.max(0, width - visibleWidth(stats) - 3);
    if (!label || labelWidth === 0) return stats;
    return `${this.color(color, truncateToWidth(label, labelWidth, "…"))} · ${stats}`;
  }

  private horizontalArrowDirection(data: string): -1 | 1 | undefined {
    if (matchesKey(data, "left")) return -1;
    if (matchesKey(data, "right")) return 1;
    return undefined;
  }

  /** The read-only transcript has no editor; its root arrows remain browse keys. */
  private canNavigateSibling(): boolean {
    if (this.disposed || this.childSelector || this.childHistoryPicker || this.childSessionInfo || this.childHistoryView) {
      return false;
    }
    if (this.host.readOnly?.()) return true;
    return this.editor.focused === true &&
      this.editor.getText() === "" &&
      !(this.editor.isShowingAutocomplete?.() ?? false);
  }

  private startSiblingNavigation(direction: -1 | 1): void {
    const navigate = this.host.onNavigateSibling;
    if (!navigate || !this.canNavigateSibling() || this.siblingNavigationPending) return;
    this.siblingNavigationPending = true;
    const serial = ++this.siblingNavigationSerial;
    const stillEligible = () =>
      serial === this.siblingNavigationSerial &&
      this.siblingNavigationPending &&
      this.canNavigateSibling();
    this.host.requestRender();
    void Promise.resolve()
      .then(() => navigate(direction, stillEligible))
      .catch(() => {
        // The controller reports failures in the current overlay's notice row.
      })
      .finally(() => {
        if (serial !== this.siblingNavigationSerial) return;
        this.siblingNavigationPending = false;
        this.host.requestRender();
      });
  }

  private cancelSiblingNavigation(): void {
    if (!this.siblingNavigationPending) return;
    this.siblingNavigationPending = false;
    this.siblingNavigationSerial++;
    this.host.onCancelSiblingNavigation?.();
    this.host.requestRender();
  }

  private scrollChildSessionInfo(delta: number): void {
    this.childSessionInfoScroll = Math.max(0, this.childSessionInfoScroll + delta);
    this.box.invalidate();
    this.host.requestRender();
  }

  private pageChildSessionInfo(direction: number): void {
    const rows = this.terminalRows();
    const pageRows = Math.max(1, (Number.isFinite(rows) ? Math.floor(rows) : 0) - 3);
    this.scrollChildSessionInfo(direction * pageRows);
  }

  private pageChildHistoryTranscript(direction: number): void {
    const view = this.childHistoryView;
    if (!view) return;
    const rows = this.terminalRows();
    const pageRows = Math.max(1, (Number.isFinite(rows) ? Math.floor(rows) : 0) - 3);
    view.pane.scrollBy(direction * pageRows);
    this.host.requestRender();
  }

  private sessionInfoLines(info: ChildSessionInfo): string[] {
    const lines = ["Session"];
    const field = (label: string, value: string | undefined) => {
      if (value !== undefined && value !== "") lines.push(`${label}: ${value}`);
    };
    field("Session ID", info.sessionId);
    field("Name", info.sessionName);
    field("Storage", info.storagePath);
    if (info.model || info.thinkingLevel || info.cwd) {
      lines.push("", "Child configuration");
      field("Model", info.model);
      field("Thinking", info.thinkingLevel);
      field("Working directory", info.cwd);
    }
    if (info.counts) {
      lines.push("", `Activity (${info.counts.scope})`);
      field("User messages", String(info.counts.userMessages));
      field("Assistant messages", String(info.counts.assistantMessages));
      field("Tool calls", String(info.counts.toolCalls));
      field("Tool results", String(info.counts.toolResults));
      field("Total messages", String(info.counts.totalMessages));
    }
    if (info.tokens) {
      lines.push("", "Usage (recorded)");
      field("Input tokens", info.tokens.input.toLocaleString("en-US"));
      field("Output tokens", info.tokens.output.toLocaleString("en-US"));
      field("Cache read", info.tokens.cacheRead.toLocaleString("en-US"));
      field("Cache write", info.tokens.cacheWrite.toLocaleString("en-US"));
      field("Total tokens", info.tokens.total.toLocaleString("en-US"));
      if (info.cost !== undefined) field("Cost", `$${info.cost.toFixed(4)}`);
    }
    if (info.contextUsage) {
      lines.push("");
      const { tokens, contextWindow, percent } = info.contextUsage;
      field(
        "Current context",
        tokens === null
          ? `unknown of ${contextWindow.toLocaleString("en-US")} tokens`
          : `${tokens.toLocaleString("en-US")} / ${contextWindow.toLocaleString("en-US")} tokens${percent === null ? "" : ` (${percent.toFixed(1)}%)`}`,
      );
    }
    if (lines.length === 1) lines.push("No additional child-session details were recorded.");
    return lines;
  }

  private renderReadOnlyHistory(width: number, rows: number): string[] {
    this.clearIndicator();
    if (rows <= 0) return [];
    const info = this.host.context?.();
    const taskLabel = info
      ? `#${info.taskId} · ${info.agentType} · ${info.status ?? "status unavailable"}`
      : `#${this.host.taskId}`;
    const titleLabel = `Persisted child transcript · ${taskLabel} · read-only`;
    const footer = this.color("dim", truncateToWidth("↑↓ scroll · pgup/pgdn page · esc back · read-only", width, "…"));
    const metadata = this.host.childMetadata?.();
    const title = metadata
      ? this.childSummaryLine(titleLabel, metadata, width, "accent")
      : this.color("accent", truncateToWidth(titleLabel, width, "…"));
    if (rows === 1) return [title];
    if (rows === 2) return [title, footer];
    const transcriptRows = Math.max(0, rows - 2);
    const transcript = this.pane.render(width, transcriptRows).slice(0, transcriptRows);
    const lines = [
      title,
      ...transcript,
      ...Array.from({ length: Math.max(0, transcriptRows - transcript.length) }, () => ""),
      footer,
    ].slice(0, rows);
    return this.bgStart === "" ? lines : lines.map((line) => restoreOverlayBackground(line, this.bgStart));
  }

  private renderChildHistoryTranscript(width: number, rows: number): string[] {
    const view = this.childHistoryView;
    if (!view || rows <= 0) return [];
    const titleLabel = `Historical child transcript · #${view.option.taskId} · ${view.option.sessionName} · ${view.option.status} · read-only`;
    const title = view.metadata
      ? this.childSummaryLine(titleLabel, view.metadata, width, "accent")
      : this.color("accent", truncateToWidth(titleLabel, width, "…"));
    const footer = truncateToWidth("↑↓ scroll · pgup/pgdn page · esc back to child", width, "…");
    if (rows === 1) return [title];
    if (rows === 2) return [title, this.color("dim", footer)];
    const transcriptRows = Math.max(0, rows - 2);
    const transcript = view.pane.render(width, transcriptRows).slice(0, transcriptRows);
    const filler = Math.max(0, transcriptRows - transcript.length);
    const lines = [
      title,
      ...transcript,
      ...Array.from({ length: filler }, () => ""),
      this.color("dim", footer),
    ];
    return lines.slice(0, rows).map((line) =>
      this.bgStart === "" ? line : restoreOverlayBackground(line, this.bgStart),
    );
  }

  private renderChildSessionInfo(width: number, rows: number): string[] {
    if (rows <= 0) return [];
    const info = this.childSessionInfo;
    if (!info) return [];
    const wrapped = this.sessionInfoLines(info).flatMap((line) =>
      line === "" ? [""] : wrapTextWithAnsi(line, Math.max(1, width)),
    );
    const title = this.color("accent", truncateToWidth("Child Session Info", width, "…"));
    const footer = this.color("dim", truncateToWidth(SESSION_INFO_HINTS, width, "…"));
    if (rows === 1) return [this.bgStart === "" ? title : restoreOverlayBackground(title, this.bgStart)];
    const contentRows = Math.max(1, rows - 2);
    const maxStart = Math.max(0, wrapped.length - contentRows);
    this.childSessionInfoScroll = Math.min(this.childSessionInfoScroll, maxStart);
    const content = wrapped.slice(this.childSessionInfoScroll, this.childSessionInfoScroll + contentRows);
    const lines = [title, ...content, footer];
    while (lines.length < rows) lines.splice(lines.length - 1, 0, "");
    return lines.slice(0, rows).map((line) => this.bgStart === "" ? line : restoreOverlayBackground(line, this.bgStart));
  }

  /** Preserve the original compact layout for hosts that have no child stats. */
  private renderBodyWithoutMetadata(
    width: number,
    rows: number,
    info: TaskContextInfo | undefined,
    activity: TaskActivity | undefined,
    notice: { level: "info" | "warning" | "error"; message: string } | undefined,
  ): string[] {
    const editorLines = fitEditorViewport(this.editor.render(width), rows);
    let remaining = Math.max(0, rows - editorLines.length);
    const workingLines = this.workingRowLines(width, activity, remaining > 1);
    remaining -= workingLines.length;

    const noticeLines: string[] = [];
    if (notice && remaining > 1) {
      const marker = notice.level === "error" ? "! " : notice.level === "warning" ? "⚠ " : "✓ ";
      const message = `${marker}${notice.message.replace(/\s+/g, " ").trim()}`;
      noticeLines.push(this.color(
        notice.level === "error" ? "error" : "accent",
        truncateToWidth(message, width, "…"),
      ));
      remaining -= 1;
    }

    const footerLines: string[] = [];
    if (info) {
      for (const row of footerRows(taskFooterSegments(info), KEY_HINTS, width)) {
        if (remaining <= 1) break;
        footerLines.push(this.color("dim", truncateToWidth(row, width, "…")));
        remaining -= 1;
      }
    } else if (remaining > 1) {
      footerLines.push(this.color("dim", truncateToWidth(KEY_HINTS, width, "…")));
      remaining -= 1;
    }
    const statusLines: string[] = [];
    if (info && remaining > 1) {
      const phaseIsShownElsewhere = this.embedsWorkingStatus || workingLines.length > 0;
      statusLines.push(this.color(
        "dim",
        truncateToWidth(taskStatusLine(info, { includePhase: !phaseIsShownElsewhere }), width, "…"),
      ));
      remaining -= 1;
    }
    const paneLines = this.pane.render(width, remaining);
    const fillerRows = Math.max(0, remaining - paneLines.length);
    const lines = [
      ...paneLines,
      ...Array.from({ length: fillerRows }, () => ""),
      ...statusLines,
      ...noticeLines,
      ...workingLines,
      ...editorLines,
      ...footerLines,
    ];
    return this.bgStart === "" ? lines : lines.map((line) => restoreOverlayBackground(line, this.bgStart));
  }

  /**
   * Chrome order (top to bottom): transcript, optional command notice, child
   * combined child status/metadata row, working indicator/editor, identity footer.
   * Short terminals crop the editor around its cursor to retain the metadata
   * row and child identity whenever the viewport can fit them.
   */
  private renderBody(width: number): string[] {
    const terminalRows = this.terminalRows();
    const rows = Number.isFinite(terminalRows) ? Math.max(0, Math.floor(terminalRows)) : 0;
    if (this.childHistoryPicker) {
      this.childHistoryPicker.setViewportRows(rows);
      return fillEditorViewport(this.childHistoryPicker.render(width), rows).map((line) =>
        this.bgStart === "" ? line : restoreOverlayBackground(line, this.bgStart),
      );
    }
    if (this.childSelector) {
      this.childSelector.setViewportRows(rows);
      return fillEditorViewport(this.childSelector.render(width), rows).map((line) =>
        this.bgStart === "" ? line : restoreOverlayBackground(line, this.bgStart),
      );
    }
    if (this.childSessionInfo) return this.renderChildSessionInfo(width, rows);
    if (this.childHistoryView) return this.renderChildHistoryTranscript(width, rows);
    if (this.host.readOnly?.()) return this.renderReadOnlyHistory(width, rows);
    if (rows === 0) {
      this.clearIndicator();
      return [];
    }

    const info = this.host.context?.();
    const metadata = this.host.childMetadata?.();
    const activity = this.host.activity?.();
    const notice = this.host.notice?.();
    this.syncIndicator(activity);

    const metadataLine = metadata ? this.childMetadataLine(metadata, width) : undefined;
    if (metadataLine === undefined) {
      return this.renderBodyWithoutMetadata(width, rows, info, activity, notice);
    }
    const childFooter = info ? footerRows(taskFooterSegments(info), KEY_HINTS, width) : [];
    const metadataVisible = metadataLine !== undefined && rows >= 2;
    const identityVisible = Boolean(info && rows >= (metadataVisible ? 3 : 2));
    const fixedChromeRows = Number(metadataVisible) + Number(identityVisible);
    const editorLimit = Math.max(1, rows - fixedChromeRows - 1);
    const editorLines = fitEditorViewport(this.editor.render(width), editorLimit);
    let remaining = Math.max(0, rows - fixedChromeRows - editorLines.length);

    // Reserve one transcript row whenever the chrome permits; optional rows
    // yield before it, while the child stats, cursor, and identity stay visible.
    const rawWorkingLines = this.workingRowLines(width, activity, remaining > 1);
    const workingLines = rawWorkingLines.slice(0, remaining);
    remaining -= workingLines.length;

    const noticeLines: string[] = [];
    if (notice && remaining > 1) {
      const marker = notice.level === "error" ? "! " : notice.level === "warning" ? "⚠ " : "✓ ";
      noticeLines.push(
        this.color(
          notice.level === "error" ? "error" : "accent",
          truncateToWidth(`${marker}${notice.message.replace(/\s+/g, " ").trim()}`, width, "…"),
        ),
      );
      remaining -= 1;
    }

    const footerLines: string[] = [];
    if (identityVisible) {
      footerLines.push(this.color("dim", truncateToWidth(childFooter[0] ?? KEY_HINTS, width, "…")));
    }
    if (remaining > 1) {
      const nextFooter = identityVisible ? childFooter[1] : childFooter[0] ?? (!info ? KEY_HINTS : undefined);
      if (nextFooter) {
        footerLines.push(this.color("dim", truncateToWidth(nextFooter, width, "…")));
        remaining -= 1;
      }
    }

    const phaseIsShownElsewhere = this.embedsWorkingStatus || workingLines.length > 0;
    const summaryLabel = info ? taskStatusLine(info, { includePhase: !phaseIsShownElsewhere }) : "";
    const metadataLines = metadataVisible && metadata
      ? [this.childSummaryLine(summaryLabel, metadata, width)]
      : [];
    const paneLines = this.pane.render(width, remaining).slice(0, remaining);
    const fillerRows = Math.max(0, remaining - paneLines.length);
    const lines = [
      ...paneLines,
      ...Array.from({ length: fillerRows }, () => ""),
      ...noticeLines,
      ...metadataLines,
      ...workingLines,
      ...editorLines,
      ...footerLines,
    ];
    return this.bgStart === ""
      ? lines
      : lines.map((line) => restoreOverlayBackground(line, this.bgStart));
  }
}
