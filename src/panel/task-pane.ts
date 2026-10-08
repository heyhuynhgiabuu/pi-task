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
import {
  truncateToWidth,
  type Component,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

import { authoritativeDurationMs, type TranscriptItem } from "./transcript.js";

/** What a row of the pane's last render maps to, for native mouse routing. */
export interface TaskTranscriptPaneHit {
  /** The native pi component that owns the row (a tool component). */
  component: Pick<Component, "handleMouse">;
  /** Row inside that component's own rendered block. */
  y: number;
  /** Rows the component occupies in the pane. */
  height: number;
  /** Forward through pi's native handler, retaining this pane's expansion state. */
  dispatchMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
}

export interface TaskTranscriptPane {
  /** Scroll back/forward from the tail; clamps to the available content. */
  scrollBy(delta: number): void;
  /** Render within an optional maximum number of pane rows. */
  render(width: number, availableRows?: number): string[];
  invalidate(): void;
  dispose(): void;
  /**
   * Row of the pane's last render → the tool component that owns it, so the
   * overlay can forward a click with native coordinates (it has no layout
   * geometry of its own). Chrome rows, non-tool rows, and rows outside the
   * transcript window return undefined, leaving them to the host.
   */
  hitTest?(row: number): TaskTranscriptPaneHit | undefined;
  /** Expand or collapse every tool row; returns the state now in effect. */
  toggleToolsExpanded?(): boolean;
}

/** Component shape the pane caches: renders lines, optionally handles mouse. */
interface CachedComponent extends Pick<Component, "render" | "handleMouse"> {
  setExpanded?(expanded: boolean): void;
}

/** pi marks prompt boundaries with OSC 133; meaningless inside this modal. */
const OSC133_MARKER = /\x1b\]133;[^\x07\x1b]*(?:\x07|\x1b\\)/g;
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
    /** Effective `outputPad` setting: horizontal padding of transcript rows. */
    outputPad?: number;
    /** Optional initial expansion state for this child view; never mutates the host. */
    toolsExpanded?: boolean;
  },
): TaskTranscriptPane {
  let scrollBack = 0;
  let lastSig: string | null = null;
  let cachedItems: TranscriptItem[] = [];
  let cachedBody:
    | {
        sig: string;
        width: number;
        lines: string[];
        /** Line span of every item in `lines`, for row → component routing. */
        spans: Array<{ start: number; count: number; item: TranscriptItem }>;
      }
    | null = null;
  let toolsExpanded = opts.toolsExpanded ?? false;
  /** Per-call overrides are kept across live transcript object replacement. */
  const toolExpansionOverrides = new Map<string, boolean>();
  let toolComponents = new Set<CachedComponent>();
  /** Geometry of the last render, so a click row maps back to a body line. */
  let lastFrame:
    | { lines: number; bodyTop: number; windowStart: number; visibleCount: number }
    | undefined;
  const renderDefinitions = toolRenderDefinitions(opts.cwd);
  let itemCache = new WeakMap<TranscriptItem, CachedComponent>();

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
        comp = new UserMessageComponent(item.text, getMarkdownTheme(), opts.outputPad);
      } else if (item.type === "assistant") {
        comp = new AssistantMessageComponent(
          assistantMessageForTranscript(item),
          undefined,
          undefined,
          undefined,
          opts.outputPad,
        );
      } else {
        const tool = new ToolExecutionComponent(
          item.name,
          item.toolCallId,
          item.args,
          { outputPad: opts.outputPad },
          renderDefinitions.get(item.name),
          tui,
          opts.cwd,
        );
        // Settled items must not synthesize a duration: markExecutionStarted
        // stamps startedAt=now, so a completed tool would render "Took 0.0s".
        // Only live items start the ticker; settled items show the
        // authoritative `durationMs` or nothing (0 is a valid duration).
        const durationMs = authoritativeDurationMs(item.durationMs);
        if (item.inProgress === true) {
          tool.markExecutionStarted();
        } else if (durationMs !== undefined) {
          // COMPAT SHIM (pi-coding-agent 1.0.4): `ToolExecutionComponent` has no
          // public duration input, and the built-in shell renderer computes
          // "Took" from private `rendererState.startedAt/endedAt`. Seed them
          // from authoritative `durationMs` ONLY (never call/result timestamp
          // deltas) so the real duration renders now. Newer pi forwards
          // `durationMs` via updateResult below; remove this shim after the
          // minimum supported pi does.
          const state = (tool as unknown as {
            rendererState?: { startedAt?: number; endedAt?: number };
          }).rendererState;
          if (state) {
            state.startedAt = 0;
            state.endedAt = durationMs;
          }
        }
        // Expansion belongs to this view, never the host's interactive mode.
        tool.setExpanded(toolExpansionOverrides.get(item.toolCallId) ?? toolsExpanded);
        if (item.result !== undefined || item.inProgress === false) {
          // `durationMs` is public on newer pi's updateResult; 1.0.4 typings omit
          // it, so pass through a widened local (excess-property check is literal-only).
          const result: Parameters<typeof tool.updateResult>[0] & { durationMs?: number } = {
            content: [{ type: "text", text: item.result ?? "" }],
            // Pi's renderers read `details` (edit draws its diff from it); the
            // projections keep it on the item, so hand it over unchanged.
            ...(item.details === undefined ? {} : { details: item.details }),
            isError: Boolean(item.isError),
            ...(durationMs === undefined ? {} : { durationMs }),
          };
          tool.updateResult(result, item.inProgress ?? false);
        }
        comp = tool;
      }
      itemCache.set(item, comp);
    }
    // pi's Assistant/UserMessageComponents prefix OSC 133 semantic-prompt
    // markers to their first line; this view left-pads every row by one cell,
    // so the marker reaches the terminal at column 1 and spec-compliant
    // terminals (OSC 133;A = fresh line: CR + index when x != 0) abandon the
    // rest of the row at default background — the grey blur band under tool
    // blocks. Semantic prompts are meaningless inside this modal.
    return comp.render(width).map((line) => line.replace(OSC133_MARKER, ""));
  }

  function invalidateRenderedBody(): void {
    cachedBody = null;
    lastFrame = undefined;
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
        const liveToolCalls = new Set(
          cachedItems.flatMap((item) => (item.type === "tool" ? [item.toolCallId] : [])),
        );
        for (const toolCallId of toolExpansionOverrides.keys()) {
          if (!liveToolCalls.has(toolCallId)) toolExpansionOverrides.delete(toolCallId);
        }
        invalidateRenderedBody();
      }
      // Body lines depend only on (items, width): reuse them across repaint
      // ticks (the live view re-renders every ~700 ms) unless the transcript
      // grew or the width changed.
      if (!cachedBody || cachedBody.sig !== sig || cachedBody.width !== width) {
        const body: string[] = [];
        const spans: Array<{ start: number; count: number; item: TranscriptItem }> = [];
        for (const item of cachedItems) {
          const start = body.length;
          const lines = itemLines(item, width);
          body.push(...lines);
          spans.push({ start, count: lines.length, item });
        }
        cachedBody = { sig, width, lines: body, spans };
        toolComponents = new Set(
          spans.flatMap((span) => {
            if (span.item.type !== "tool") return [];
            const component = itemCache.get(span.item);
            return component ? [component] : [];
          }),
        );
      }
      const body = cachedBody.lines;

      const rows = tui.terminal.rows;
      const borderLines = new DynamicBorder((str) => theme.fg("border", str)).render(width);
      const boundedRows =
        availableRows === undefined ? undefined : Math.max(0, Math.floor(availableRows));
      if (boundedRows === 0) {
        lastFrame = undefined;
        return [];
      }

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
      lastFrame = {
        lines: lines.length,
        bodyTop: showChrome ? borderLines.length + 1 : 0,
        windowStart: Math.max(0, end - visibleCount),
        visibleCount,
      };
      return lines;
    },
    hitTest(row: number) {
      const frame = lastFrame;
      const body = cachedBody;
      if (!frame || !body || row < 0 || row >= frame.lines) return undefined;
      const bodyRow = row - frame.bodyTop;
      if (bodyRow < 0 || bodyRow >= frame.visibleCount) return undefined;
      const index = frame.windowStart + bodyRow;
      const span = body.spans.find((entry) => index >= entry.start && index < entry.start + entry.count);
      if (!span || span.item.type !== "tool") return undefined;
      const toolItem = span.item;
      const component = itemCache.get(toolItem);
      if (!component?.handleMouse) return undefined;
      return {
        component,
        y: index - span.start,
        height: span.count,
        dispatchMouse(event) {
          const result = component.handleMouse?.(event);
          if (result?.handled && event.type === "click" && event.button === "left") {
            const currentExpansion =
              toolExpansionOverrides.get(toolItem.toolCallId) ?? toolsExpanded;
            toolExpansionOverrides.set(toolItem.toolCallId, !currentExpansion);
            // The native component retained its own new state; rebuild lines
            // from that same component so its per-tool toggle remains visible.
            invalidateRenderedBody();
          }
          return result;
        },
      };
    },
    toggleToolsExpanded() {
      toolsExpanded = !toolsExpanded;
      toolExpansionOverrides.clear();
      for (const component of toolComponents) component.setExpanded?.(toolsExpanded);
      // Tool rows change height, so the cached lines must be rebuilt.
      invalidateRenderedBody();
      return toolsExpanded;
    },
    invalidate() {
      // Components cache theme colors internally; rebuild on theme change.
      itemCache = new WeakMap();
      invalidateRenderedBody();
    },
    dispose() {
      itemCache = new WeakMap();
      invalidateRenderedBody();
      toolComponents.clear();
      toolExpansionOverrides.clear();
    },
  };
}