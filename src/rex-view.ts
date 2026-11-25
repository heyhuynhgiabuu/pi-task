/**
 * Detached Rex mirror viewer entry point (`dist/rex-view.js`) and its
 * append-only delta renderer. Imports only Node built-ins and type-only
 * definitions so it runs directly under `node` from a split Rex pane without
 * resolving extension peer dependencies. The Pi TUI viewer (`rex-view-tui`) is
 * the one module that loads Pi packages; it is imported dynamically and only
 * when the pane is a terminal, and the text log here is the fallback.
 */

import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { LiveTranscriptSnapshot } from "./panel/rex-snapshot.js";
import type { TranscriptItem } from "./panel/transcript.js";

export type Osc7501State = "idle" | "working" | "done" | "error" | "blocked";

/** Terminal statuses: the viewer exits and the pane closes. `finished` is an outcome pi-task never recorded (delivery it suppressed). */
export const TERMINAL_STATUSES = new Set([
  "done",
  "finished",
  "cancelled",
  "aborted",
  "failed",
  "timeout",
]);

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** The OSC 7501 state a terminal status reports: `finished` (an unrecorded outcome) is idle, not success. */
export function terminalOscState(status: string): Osc7501State {
  return status === "done" ? "done" : status === "finished" ? "idle" : "error";
}

export function formatOsc7501(state: Osc7501State, app = "pi-task"): string {
  return `\x1b]7501;state=${state}:app=${app}\x1b\\`;
}

/** Child and tool text is untrusted: without this, an escape sequence in a transcript could spoof the OSC 7501 state or rewrite the pane. Line feeds and tabs are the only controls kept. */
export function sanitizeMirrorText(text: string): string {
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

interface TrackedItemState {
  type: TranscriptItem["type"];
  timestamp: string;
  textSnapshot: string;
  thinkingSnapshot: string;
  toolCallId: string;
  printedTextLen: number;
  printedThinkingLen: number;
  thinkingStarted: boolean;
  thinkingClosed: boolean;
  callPrinted: boolean;
  resultPrinted: boolean;
}

export interface MirrorRenderState {
  headerPrinted: boolean;
  tracked: TrackedItemState[];
  openLine: boolean;
  lastOscState?: Osc7501State;
  terminalEmitted: boolean;
}

export interface MirrorRenderDelta {
  text: string;
  osc: string;
  done: boolean;
}

export function createMirrorRenderState(): MirrorRenderState {
  return {
    headerPrinted: false,
    tracked: [],
    openLine: false,
    terminalEmitted: false,
  };
}

function itemsMatch(prev: TrackedItemState, next: TranscriptItem): boolean {
  if (prev.type !== next.type) return false;
  switch (next.type) {
    case "tool":
      // DurableTranscript re-stamps a settled call with the toolResult entry's time, which
      // differs from the call's, so a call with an id is identified by id and name only.
      if (prev.toolCallId || next.toolCallId) {
        return prev.toolCallId === next.toolCallId && prev.textSnapshot === next.name;
      }
      return prev.textSnapshot === next.name && prev.timestamp === next.timestamp;
    default:
      break;
  }
  if (prev.timestamp && next.timestamp && prev.timestamp !== next.timestamp) {
    return false;
  }
  switch (next.type) {
    case "assistant":
      return (
        next.text.startsWith(prev.textSnapshot) &&
        (next.thinking ?? "").startsWith(prev.thinkingSnapshot)
      );
    case "user":
    case "system":
      return next.text === prev.textSnapshot;
  }
}

/**
 * The tracked item behind each new item, or undefined when the item is new. The
 * transcript only appends, loses items from its head when trimmed, or loses one
 * in place (the empty assistant item DurableTranscript splices out once a turn
 * settles without text). So a mismatch never means "everything after is new":
 * the first later tracked item that matches realigns, and only an item with no
 * match at all counts as new.
 */
function alignTracked(
  prev: readonly TrackedItemState[],
  next: readonly TranscriptItem[],
): Array<TrackedItemState | undefined> {
  const aligned: Array<TrackedItemState | undefined> = [];
  let from = 0;
  for (const item of next) {
    let match = -1;
    for (let k = from; k < prev.length; k++) {
      if (itemsMatch(prev[k]!, item)) {
        match = k;
        break;
      }
    }
    if (match === -1) {
      aligned.push(undefined);
      continue;
    }
    aligned.push(prev[match]);
    from = match + 1;
  }
  return aligned;
}

function newTrackedItem(item: TranscriptItem): TrackedItemState {
  return {
    type: item.type,
    timestamp: item.timestamp,
    textSnapshot: item.type === "tool" ? item.name : item.text,
    thinkingSnapshot: item.type === "assistant" ? item.thinking ?? "" : "",
    toolCallId: item.type === "tool" ? item.toolCallId : "",
    printedTextLen: 0,
    printedThinkingLen: 0,
    thinkingStarted: false,
    thinkingClosed: false,
    callPrinted: false,
    resultPrinted: false,
  };
}

function formatHeader(snapshot: LiveTranscriptSnapshot): string {
  const desc = snapshot.description ? ` — ${snapshot.description}` : "";
  const lines = [`── ${snapshot.agentType} [${snapshot.taskId}]${desc}`];
  const details: string[] = [];
  if (snapshot.model) details.push(`model: ${snapshot.model}`);
  if (snapshot.cwd) details.push(`cwd: ${snapshot.cwd}`);
  if (details.length > 0) lines.push(`   ${details.join(" · ")}`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function formatToolCall(item: Extract<TranscriptItem, { type: "tool" }>): string {
  const args = item.args ?? {};
  if (item.name === "bash") {
    const cmd = String(args.command ?? "").split("\n")[0]?.slice(0, 120) ?? "";
    return cmd ? `▸ $ ${cmd}` : "▸ bash";
  }
  const file = args.file_path ?? args.path ?? args.file;
  if (typeof file === "string" && file.length > 0) {
    return `▸ ${item.name} ${file}`;
  }
  const keys = Object.keys(args);
  if (keys.length > 0) {
    return `▸ ${item.name} ${JSON.stringify(args).slice(0, 120)}`;
  }
  return `▸ ${item.name}`;
}

function formatToolResult(item: Extract<TranscriptItem, { type: "tool" }>): string {
  const duration = item.durationMs !== undefined ? ` (${item.durationMs}ms)` : "";
  const raw = (item.result ?? "").trimEnd();
  if (item.isError) {
    if (!raw) return `  ✗ error${duration}`;
    const lines = raw.split("\n");
    return lines.length === 1
      ? `  ✗ error: ${lines[0]}${duration}`
      : `  ✗ error${duration}:\n${lines.map((l) => `    ${l}`).join("\n")}`;
  }
  if (!raw) return `  ✓ done${duration}`;
  const lines = raw.split("\n");
  return lines.length === 1
    ? `  ✓ ${lines[0]}${duration}`
    : `  ✓${duration}\n${lines.map((l) => `    ${l}`).join("\n")}`;
}

export function renderMirrorDelta(
  state: MirrorRenderState,
  snapshot: LiveTranscriptSnapshot,
): MirrorRenderDelta {
  const chunks: string[] = [];
  const flushOpenLine = () => {
    if (state.openLine) {
      chunks.push("\n");
      state.openLine = false;
    }
  };

  if (!state.headerPrinted) {
    chunks.push(formatHeader(snapshot));
    state.headerPrinted = true;
  }

  const items = snapshot.items ?? [];
  const aligned = alignTracked(state.tracked, items);
  const nextTracked: TrackedItemState[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const entry = aligned[i] ?? newTrackedItem(item);
    nextTracked.push(entry);

    switch (item.type) {
      case "user": {
        entry.textSnapshot = item.text;
        if (entry.printedTextLen === 0) {
          flushOpenLine();
          chunks.push(`> ${item.text}\n`);
          entry.printedTextLen = item.text.length;
        }
        break;
      }
      case "system": {
        entry.textSnapshot = item.text;
        if (entry.printedTextLen === 0) {
          flushOpenLine();
          chunks.push(`[system] ${item.text}\n`);
          entry.printedTextLen = item.text.length;
        }
        break;
      }
      case "assistant": {
        const thinking = item.thinking ?? "";
        entry.thinkingSnapshot = thinking;
        entry.textSnapshot = item.text;

        if (thinking.length > entry.printedThinkingLen) {
          if (!entry.thinkingStarted) {
            flushOpenLine();
            chunks.push("[thinking] ");
            entry.thinkingStarted = true;
          }
          const delta = thinking.slice(entry.printedThinkingLen);
          chunks.push(delta);
          entry.printedThinkingLen = thinking.length;
          state.openLine = !delta.endsWith("\n");
          entry.thinkingClosed = !state.openLine;
        }

        if (item.text.length > entry.printedTextLen) {
          if (entry.thinkingStarted && !entry.thinkingClosed) {
            flushOpenLine();
            entry.thinkingClosed = true;
          } else if (entry.printedTextLen === 0) {
            flushOpenLine();
          }
          const delta = item.text.slice(entry.printedTextLen);
          chunks.push(delta);
          entry.printedTextLen = item.text.length;
          if (item.streaming) {
            state.openLine = !delta.endsWith("\n");
          } else {
            if (!delta.endsWith("\n")) chunks.push("\n");
            state.openLine = false;
          }
        } else if (!item.streaming && state.openLine) {
          flushOpenLine();
          if (entry.thinkingStarted) entry.thinkingClosed = true;
        }
        break;
      }
      case "tool": {
        entry.textSnapshot = item.name;
        entry.toolCallId = item.toolCallId;
        // A live tool slot arrives before its arguments, and a call line prints once.
        if (!entry.callPrinted && (Object.keys(item.args ?? {}).length > 0 || item.inProgress === false)) {
          flushOpenLine();
          chunks.push(`${formatToolCall(item)}\n`);
          entry.callPrinted = true;
        }
        const settled =
          !item.inProgress &&
          (item.result !== undefined || item.inProgress === false || item.isError === true);
        if (settled && !entry.resultPrinted) {
          flushOpenLine();
          chunks.push(`${formatToolResult(item)}\n`);
          entry.resultPrinted = true;
        }
        break;
      }
    }
  }

  state.tracked = nextTracked;

  const terminal = isTerminalStatus(snapshot.status);
  let osc = "";
  if (terminal) {
    if (!state.terminalEmitted) {
      flushOpenLine();
      chunks.push(`\n[${snapshot.status}]\n`);
      state.terminalEmitted = true;
    }
    const targetOsc = terminalOscState(snapshot.status);
    if (state.lastOscState !== targetOsc) {
      osc = formatOsc7501(targetOsc);
      state.lastOscState = targetOsc;
    }
  } else if (state.lastOscState !== "working") {
    osc = formatOsc7501("working");
    state.lastOscState = "working";
  }

  return {
    text: chunks.join(""),
    osc,
    done: terminal,
  };
}

function readSnapshotBestEffort(snapshotPath: string): LiveTranscriptSnapshot | undefined {
  try {
    if (!existsSync(snapshotPath)) return undefined;
    const raw = readFileSync(snapshotPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    const record = parsed as Partial<LiveTranscriptSnapshot>;
    if (typeof record.taskId !== "string" || !Array.isArray(record.items)) return undefined;
    return record as LiveTranscriptSnapshot;
  } catch {
    return undefined;
  }
}

export interface SnapshotFollower {
  stop(): void;
}

/**
 * Reads the snapshot now and again whenever the file changes (a directory watch
 * with a polling fallback). Both viewer modes follow the file through this.
 * `onSnapshot` receives each new snapshot and a `stop` that is safe to call
 * from inside the first, synchronous read.
 */
export function followSnapshotFile(
  snapshotPath: string,
  onSnapshot: (snapshot: LiveTranscriptSnapshot, stop: () => void) => void,
): SnapshotFollower {
  let lastStatSig = "";
  let watcher: FSWatcher | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    try {
      watcher?.close();
    } catch {
      // Ignore close failures on exit.
    }
    if (pollTimer !== undefined) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
  };

  const checkFile = (force = false) => {
    if (stopped) return;
    let sig = "";
    try {
      const stats = statSync(snapshotPath);
      sig = `${stats.ino}:${stats.mtimeMs}:${stats.size}`;
    } catch {
      return;
    }
    if (!force && sig === lastStatSig) return;
    const snapshot = readSnapshotBestEffort(snapshotPath);
    if (!snapshot) return;
    lastStatSig = sig;
    onSnapshot(snapshot, stop);
  };

  checkFile(true);
  if (stopped) return { stop };

  const targetName = basename(snapshotPath);
  try {
    watcher = watch(dirname(snapshotPath), (_eventType, filename) => {
      if (!filename || filename === targetName) {
        checkFile(false);
      }
    });
    watcher.on("error", () => {
      // Keep polling even if fs.watch fails.
    });
  } catch {
    // Directory may not exist yet or watch may be unsupported; poll timer still runs.
  }

  pollTimer = setInterval(() => checkFile(false), 100);
  return { stop };
}

/** The plain-text log mode: appends new transcript text until the task reaches a terminal status. */
export function runViewer(snapshotPath: string): void {
  const state = createMirrorRenderState();
  const follower = followSnapshotFile(snapshotPath, (snapshot, stop) => {
    const delta = renderMirrorDelta(state, snapshot);
    if (delta.text) process.stdout.write(sanitizeMirrorText(delta.text));
    if (delta.osc) process.stdout.write(delta.osc);
    if (delta.done) stop();
  });

  const onSignal = () => {
    follower.stop();
    process.exit(0);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

export interface ViewerStartDeps {
  /** Loads the Pi TUI viewer; the default imports `./rex-view-tui.js`. */
  loadTui?: () => Promise<Pick<typeof import("./rex-view-tui.js"), "runTuiViewer">>;
  hasTty?: () => boolean;
  runLog?: (snapshotPath: string) => void;
  /** Receives why the Pi view was not used; the entry point prints it to stderr. */
  note?: (message: string) => void;
}

/**
 * Starts the Pi TUI viewer when the pane is a terminal and the Pi packages
 * load; otherwise the text log runs. The Pi packages are only ever imported by
 * `rex-view-tui`, so the log mode keeps working where they are absent.
 */
export async function startViewer(
  snapshotPath: string,
  deps: ViewerStartDeps = {},
): Promise<"tui" | "log"> {
  const hasTty = deps.hasTty ?? (() => Boolean(process.stdin.isTTY && process.stdout.isTTY));
  const runLog = deps.runLog ?? runViewer;
  if (hasTty()) {
    try {
      const tui = await (deps.loadTui ?? (() => import("./rex-view-tui.js")))();
      await tui.runTuiViewer(snapshotPath);
      return "tui";
    } catch (error) {
      // The log needs nothing the TUI needs: any failure to start it falls back.
      deps.note?.(
        `rex-view: the Pi view is unavailable (${error instanceof Error ? error.message : String(error)}); showing the text log.`,
      );
    }
  }
  runLog(snapshotPath);
  return "log";
}

function isDirectEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectEntry()) {
  const snapshotPath = process.argv[2];
  if (!snapshotPath) {
    process.stderr.write("Usage: rex-view <snapshot-path>\n");
    process.exit(1);
  }
  void startViewer(snapshotPath, {
    note: (message) => process.stderr.write(`${message}\n`),
  });
}
