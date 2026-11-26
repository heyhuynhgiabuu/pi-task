/**
 * Pi TUI mode of the Rex mirror viewer (`dist/rex-view-tui.js`): a standalone
 * pi-tui app that renders the child's snapshot with pi-task's own transcript
 * pane, the rendering `/task list` then Enter shows inside the parent Pi.
 *
 * This is the only module that loads Pi packages for the viewer. `rex-view`
 * imports it dynamically and falls back to the plain-text log when it cannot be
 * loaded, and `src/index.ts` never imports it, so the parent Pi process does not
 * pay for it. Keys, footer state and mouse routing are pure exported functions.
 */

import {
  matchesKey,
  ProcessTerminal,
  truncateToWidth,
  TuiAltScreen,
  type Component,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

import type { LiveTranscriptSnapshot } from "./panel/rex-snapshot.js";
import { createTaskTranscriptPane, type TaskTranscriptPane } from "./panel/task-pane.js";
import {
  followSnapshotFile,
  isTerminalStatus,
  sanitizeMirrorText,
  terminalOscState,
  type Osc7501State,
  type SnapshotFollower,
} from "./rex-view.js";

/** Rows an arrow key and a page key move; the same steps the transcript overlay uses. */
export const ARROW_SCROLL = 3;
export const PAGE_SCROLL = 10;
/** Title and detail rows above the pane. */
const HEADER_ROWS = 2;
const FOOTER_ROWS = 1;
const OWNER_CHECK_MS = 3_000;
const KEY_HINT = "↑↓ PgUp PgDn scroll · t tools · q close";

export type ViewerAction =
  | { type: "scroll"; delta: number }
  | { type: "toggleTools" }
  | { type: "close" };

/** Pane semantics: a positive scroll delta moves toward older lines. */
export function mapViewerKey(data: string): ViewerAction | undefined {
  if (matchesKey(data, "up")) return { type: "scroll", delta: ARROW_SCROLL };
  if (matchesKey(data, "down")) return { type: "scroll", delta: -ARROW_SCROLL };
  if (matchesKey(data, "pageUp")) return { type: "scroll", delta: PAGE_SCROLL };
  if (matchesKey(data, "pageDown")) return { type: "scroll", delta: -PAGE_SCROLL };
  if (matchesKey(data, "t")) return { type: "toggleTools" };
  if (matchesKey(data, "q") || matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
    return { type: "close" };
  }
  return undefined;
}

export interface ViewerFooter {
  text: string;
  tone: "dim" | "success" | "error" | "warning";
  osc: Osc7501State;
}

/**
 * What the footer says and which OSC 7501 state the pane reports. A settled
 * outcome stands whether or not the parent is still alive; only a task that is
 * still `running` in the snapshot can be orphaned.
 */
export function viewerFooter(status: string, parentAlive: boolean): ViewerFooter {
  if (!isTerminalStatus(status)) {
    return parentAlive
      ? { text: "running", tone: "dim", osc: "working" }
      : { text: "parent Pi exited; the transcript is no longer updating", tone: "warning", osc: "idle" };
  }
  const osc = terminalOscState(status);
  if (status === "done") return { text: "done", tone: "success", osc };
  if (status === "finished") return { text: "finished (outcome not recorded)", tone: "warning", osc };
  return { text: status, tone: "error", osc };
}

/** Whether a process exists; EPERM means it exists but belongs to someone else. An unknown owner is never reported dead. */
export function isProcessAlive(
  pid: number | undefined,
  kill: (pid: number, signal?: string | number) => unknown = process.kill,
): boolean {
  if (pid === undefined) return true;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Wheel scrolls the pane; a left click on a tool row goes to that row's native
 * handler. Same routing as the transcript overlay, minus the overlay's one-cell
 * Box padding: this host draws the pane edge to edge, so x and width pass through.
 * `paneTop` is the screen row the pane starts on.
 */
export function routeViewerMouse(
  pane: TaskTranscriptPane,
  event: TuiMouseEvent,
  paneTop: number,
): TuiMouseEventResult | undefined {
  if (event.type === "wheel" && event.wheelDelta) {
    // pi-tui sends negative deltas for wheel-up; pane positive = older.
    pane.scrollBy(-event.wheelDelta);
    return { handled: true };
  }
  if (event.type !== "click" || event.button !== "left") return undefined;
  const paneRow = event.y - paneTop;
  if (paneRow < 0) return undefined;
  const hit = pane.hitTest?.(paneRow);
  if (!hit) return undefined;
  const nativeEvent: TuiMouseEvent = {
    ...event,
    y: hit.y,
    height: hit.height,
  };
  const result = hit.dispatchMouse
    ? hit.dispatchMouse(nativeEvent)
    : hit.component.handleMouse?.(nativeEvent);
  return result?.handled ? result : undefined;
}

export interface RexViewHost {
  tui: Pick<TUI, "requestRender"> & { terminal: Pick<TUI["terminal"], "rows" | "setProgramStatus"> };
  theme: Theme;
  onClose(): void;
  /** Checks the parent's liveness; defaults to signal 0 on the snapshot's `ownerPid`. */
  isOwnerAlive?(pid: number | undefined): boolean;
}

/** Header, transcript pane, footer; fed by `update` with each new snapshot. Closes itself through the host once the snapshot is terminal. */
export class RexViewComponent implements Component {
  /** Page and arrow keys belong to this component, not to the alt-screen's own scrolling. */
  readonly capturesViewportInput = true;
  private snapshot: LiveTranscriptSnapshot;
  private parentAlive = true;
  private reportedStatus = "";
  private readonly pane: TaskTranscriptPane;

  /** The pane needs the task id and cwd, which only a snapshot carries, so the first one builds the view. */
  constructor(
    private readonly host: RexViewHost,
    initial: LiveTranscriptSnapshot,
  ) {
    this.snapshot = initial;
    this.pane = createTaskTranscriptPane(host.tui as TUI, host.theme, {
      taskId: initial.taskId,
      cwd: initial.cwd ?? process.cwd(),
      sig: () => `${this.snapshot.revision}:${this.snapshot.updatedAt}`,
      read: () => this.snapshot.items,
      outputPad: 1,
    });
    this.refreshOwner();
    this.closeIfSettled();
  }

  update(snapshot: LiveTranscriptSnapshot): void {
    this.snapshot = snapshot;
    this.refreshOwner();
    this.closeIfSettled();
  }

  /** Re-checks whether the parent Pi is alive and reports the resulting state. */
  refreshOwner(): void {
    const isAlive = this.host.isOwnerAlive ?? isProcessAlive;
    this.parentAlive = isAlive(this.snapshot.ownerPid);
    this.reportStatus();
    this.host.tui.requestRender();
  }

  /**
   * A terminal outcome ends the mirror through the host's close, the same path
   * as `q`, so the Rex pane goes without a key press. Only the snapshot's status
   * decides: a parent that exited while the task still reads `running` keeps the
   * pane open with its warning, since the transcript may still be updating.
   */
  private closeIfSettled(): void {
    if (isTerminalStatus(this.snapshot.status)) this.host.onClose();
  }

  private reportStatus(): void {
    const footer = viewerFooter(this.snapshot.status, this.parentAlive);
    const key = `${footer.osc}:${footer.text}`;
    if (key === this.reportedStatus) return;
    this.reportedStatus = key;
    this.host.tui.terminal.setProgramStatus({
      state: footer.osc,
      app: "pi-task",
      message: footer.text,
    });
  }

  handleInput(data: string): void {
    const action = mapViewerKey(data);
    if (!action) return;
    if (action.type === "close") {
      this.host.onClose();
      return;
    }
    if (action.type === "scroll") this.pane.scrollBy(action.delta);
    else this.pane.toggleToolsExpanded?.();
    this.host.tui.requestRender();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return routeViewerMouse(this.pane, event, HEADER_ROWS);
  }

  render(width: number): string[] {
    const { theme } = this.host;
    const rows = this.host.tui.terminal.rows;
    const snapshot = this.snapshot;
    const line = (text: string) => truncateToWidth(sanitizeMirrorText(text), width, "…");

    const title = `${snapshot.agentType} [${snapshot.taskId}]${snapshot.description ? ` — ${snapshot.description}` : ""}`;
    const details = [snapshot.model ? `model: ${snapshot.model}` : "", snapshot.cwd ? `cwd: ${snapshot.cwd}` : ""]
      .filter(Boolean)
      .join(" · ");
    const lines = [theme.fg("accent", line(title)), theme.fg("dim", line(details))];

    const paneRows = Math.max(0, rows - HEADER_ROWS - FOOTER_ROWS);
    lines.push(...this.pane.render(width, paneRows));
    // The footer stays on the last row however short the transcript is.
    while (lines.length < rows - FOOTER_ROWS) lines.push("");
    lines.length = Math.min(lines.length, Math.max(0, rows - FOOTER_ROWS));

    const footer = viewerFooter(snapshot.status, this.parentAlive);
    lines.push(
      truncateToWidth(`${theme.fg(footer.tone, footer.text)}${theme.fg("dim", ` · ${KEY_HINT}`)}`, width, "…"),
    );
    return lines;
  }

  invalidate(): void {
    this.pane.invalidate();
  }

  dispose(): void {
    this.pane.dispose();
  }
}

/**
 * `initTheme()` builds the theme singleton, which the package index does not
 * export; the package's `exports` field blocks the deep specifier, so the
 * module is imported by the URL it resolves to. Whatever Pi version resolves
 * from here is the one used.
 */
async function loadTheme(): Promise<Theme> {
  const { initTheme } = await import("@earendil-works/pi-coding-agent");
  initTheme();
  const themeModuleUrl = new URL(
    "./modes/interactive/theme/theme.js",
    import.meta.resolve("@earendil-works/pi-coding-agent"),
  ).href;
  const { theme } = (await import(themeModuleUrl)) as { theme: Theme };
  return theme;
}

/**
 * Takes over the terminal and keeps following the snapshot. Resolves once the
 * screen is up; everything that can fail happens before that, so the caller can
 * still fall back to the text log. The pane closes by itself when the snapshot
 * reaches a terminal outcome, at the first read or on a later update; `q`
 * closes it earlier. The process then exits, which closes the Rex pane (the
 * launcher never asks Rex to keep it open).
 */
export async function runTuiViewer(snapshotPath: string): Promise<void> {
  const theme = await loadTheme();
  const terminal = new ProcessTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true });

  let view: RexViewComponent | undefined;
  let follower: SnapshotFollower | undefined;
  let ownerTimer: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    if (ownerTimer !== undefined) clearInterval(ownerTimer);
    follower?.stop();
    view?.dispose();
    try {
      terminal.setProgramStatus({ state: "clear" });
    } finally {
      tui.stop();
    }
    void terminal.drainInput(200, 30).finally(() => process.exit(0));
  };

  // Nothing is drawn until the first snapshot arrives. A failure while the
  // screen is being set up releases the terminal before it propagates, so the
  // caller can fall back to the text log on a usable terminal.
  try {
    tui.start();
    follower = followSnapshotFile(snapshotPath, (snapshot, stop) => {
      if (view) {
        view.update(snapshot);
      } else {
        view = new RexViewComponent({ tui, theme, onClose: close }, snapshot);
        // A first snapshot that is already terminal closes inside the constructor,
        // while this view is not yet assigned for `close` to dispose and not yet
        // attached: it is released here and nothing is added to the stopped TUI.
        if (closed) {
          view.dispose();
        } else {
          tui.addChild(view);
          tui.setFocus(view);
        }
      }
      // The first read runs before `followSnapshotFile` returns, so `close`
      // cannot reach the follower through its variable there; its own `stop`
      // ends it at once, before any watcher or poll timer exists.
      if (closed) stop();
    });
  } catch (error) {
    follower?.stop();
    tui.stop();
    throw error;
  }
  // Closed by the first read: nothing is left to check or signal.
  if (closed) return;
  ownerTimer = setInterval(() => view?.refreshOwner(), OWNER_CHECK_MS);
  process.on("SIGTERM", close);
  process.on("SIGHUP", close);
}
