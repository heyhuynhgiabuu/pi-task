/**
 * Live transcript pane for the task panel: renders a task's transcript (from
 * its session JSONL) using pi's own message/tool components, with tailing and
 * scroll-back. Shown inside the full-screen TaskTranscriptOverlay modal
 * (src/panel/task-transcript-overlay.ts), which owns keyboard and mouse-wheel
 * routing; this pane only owns scroll state and rendering.
 */

import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  AssistantMessageComponent,
  DynamicBorder,
  getMarkdownTheme,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { truncateToWidth, type TUI } from "@earendil-works/pi-tui";

import type { TranscriptItem } from "./transcript.js";

export interface TaskTranscriptPane {
  /** Scroll back/forward from the tail; clamps to the available content. */
  scrollBy(delta: number): void;
  /** Render within an optional maximum number of pane rows. */
  render(width: number, availableRows?: number): string[];
  invalidate(): void;
  dispose(): void;
}

const PANE_HEADER_ROWS = 14;
/**
 * Per-tool renderers for the tools SDK children actually call, so tool calls
 * render compactly like pi's main transcript (`$ command`, `read <path>`,
 * `grep /pat/ in dir`) instead of the generic name + pretty-JSON fallback.
 * Unknown tools (codemode, extensions) keep the generic fallback.
 */
function toolRenderDefinitions(cwd: string): Map<string, any> {
  const defs: Array<[string, any]> = [
    ["bash", createBashToolDefinition(cwd)],
    ["read", createReadToolDefinition(cwd)],
    ["edit", createEditToolDefinition(cwd)],
    ["write", createWriteToolDefinition(cwd)],
    ["grep", createGrepToolDefinition(cwd)],
    ["find", createFindToolDefinition(cwd)],
    ["ls", createLsToolDefinition(cwd)],
  ];
  return new Map(defs);
}

function assistantMessageForTranscript(
  item: Extract<TranscriptItem, { type: "assistant" }>,
): AssistantMessage {
  const content: AssistantMessage["content"] = [];
  if (item.thinking?.trim()) {
    content.push({ type: "thinking", thinking: item.thinking });
  }
  if (item.text.trim()) {
    content.push({ type: "text", text: item.text });
  }
  const parsedTimestamp = Date.parse(item.timestamp);
  return {
    role: "assistant",
    content,
    // TranscriptItem intentionally omits provider metadata; AssistantMessageComponent
    // only consumes content and stop state when rendering historical messages.
    api: "openai-completions",
    provider: "pi-task",
    model: "transcript",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Number.isFinite(parsedTimestamp) ? parsedTimestamp : 0,
  };
}

export function createTaskTranscriptPane(
  tui: TUI,
  theme: Theme,
  opts: {
    taskId: string;
    cwd: string;
    /** Cheap change signature; when it changes the transcript is re-read. */
    sig(): string;
    /** Full (expensive) transcript read. */
    read(): TranscriptItem[];
  },
): TaskTranscriptPane {
  let scrollBack = 0;
  let lastSig: string | null = null;
  let cachedItems: TranscriptItem[] = [];
  let cachedBody: { sig: string; width: number; lines: string[] } | null = null;
  const renderDefinitions = toolRenderDefinitions(opts.cwd);
  let itemCache = new WeakMap<TranscriptItem, { render(width: number): string[] }>();

  // Re-parse only when the source signature changed (checked in render), so
  // long sessions do not re-read the JSONL and rebuild every component on
  // each TUI repaint. Stable item objects keep the component WeakMap hitting
  // between renders.

  function itemLines(item: TranscriptItem, width: number): string[] {
    if (item.type === "system") {
      return [theme.fg("dim", truncateToWidth(item.text, width, "…"))];
    }
    let comp = itemCache.get(item);
    if (!comp) {
      if (item.type === "user") {
        comp = new UserMessageComponent(item.text, getMarkdownTheme());
      } else if (item.type === "assistant") {
        comp = new AssistantMessageComponent(assistantMessageForTranscript(item));
      } else {
        const tool = new ToolExecutionComponent(
          item.name,
          item.toolCallId,
          item.args,
          {},
          renderDefinitions.get(item.name),
          tui,
          opts.cwd,
        );
        tool.markExecutionStarted();
        if (item.result !== undefined || item.inProgress === false) {
          tool.updateResult(
            {
              content: [{ type: "text", text: item.result ?? "" }],
              isError: Boolean(item.isError),
            },
            item.inProgress ?? false,
          );
        }
        comp = tool;
      }
      itemCache.set(item, comp);
    }
    return comp.render(width);
  }

  return {
    scrollBy(delta: number) {
      scrollBack = Math.max(0, scrollBack + delta);
    },
    render(width: number, availableRows?: number): string[] {
      const sig = opts.sig();
      if (sig !== lastSig) {
        lastSig = sig;
        cachedItems = opts.read();
        cachedBody = null;
      }
      // Body lines depend only on (items, width): reuse them across repaint
      // ticks (the live view re-renders every ~700 ms) unless the transcript
      // grew or the width changed.
      if (!cachedBody || cachedBody.sig !== sig || cachedBody.width !== width) {
        const body: string[] = [];
        for (const item of cachedItems) body.push(...itemLines(item, width));
        cachedBody = { sig, width, lines: body };
      }
      const body = cachedBody.lines;

      const rows = tui.terminal.rows;
      const borderLines = new DynamicBorder((str) => theme.fg("border", str)).render(width);
      const boundedRows =
        availableRows === undefined ? undefined : Math.max(0, Math.floor(availableRows));
      if (boundedRows === 0) return [];

      // Reserve both navigation hints when the overlay supplies a viewport, so
      // scrolling changes the text window rather than making the pane overflow.
      const chromeRows = borderLines.length + 2;
      const showChrome = boundedRows === undefined || boundedRows > chromeRows;
      const defaultBodyRows = Math.max(6, rows - PANE_HEADER_ROWS);
      const visibleCount = Math.min(
        body.length,
        boundedRows === undefined
          ? defaultBodyRows
          : Math.max(0, boundedRows - (showChrome ? chromeRows : 0)),
      );
      scrollBack = Math.max(
        0,
        Math.min(scrollBack, Math.max(0, body.length - visibleCount)),
      );
      const end = body.length - scrollBack;
      const visible = body.slice(Math.max(0, end - visibleCount), end);

      const lines: string[] = [];
      if (showChrome) {
        lines.push(...borderLines);
        lines.push(
          end - visibleCount > 0
            ? theme.fg("dim", ` ↑ ${end - visibleCount} more line(s) (pageUp)`)
            : "",
        );
      }
      lines.push(...visible);
      if (showChrome && (boundedRows !== undefined || scrollBack > 0)) {
        lines.push(
          scrollBack > 0
            ? theme.fg("dim", ` ↓ ${scrollBack} more line(s) (pageDown)`)
            : "",
        );
      }
      return lines;
    },
    invalidate() {
      // Components cache theme colors internally; rebuild on theme change.
      itemCache = new WeakMap();
      cachedBody = null;
    },
    dispose() {
      itemCache = new WeakMap();
      cachedBody = null;
    },
  };
}