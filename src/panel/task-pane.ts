/**
 * Live transcript pane for the task panel: renders a task's transcript (from
 * its session JSONL) using pi's own message/tool components, with tailing and
 * pageUp/pageDown scroll-back. Modeled on pi-subtask's ForkPane. The widget is
 * placed above the editor and visually replaces the main conversation while
 * input routing is handled by TaskPanelEditor.
 */

import {
  DynamicBorder,
  getMarkdownTheme,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth, type TUI } from "@earendil-works/pi-tui";

import type { TranscriptItem } from "./transcript.js";

export interface TaskTranscriptPane {
  /** Scroll back/forward from the tail; clamps to the available content. */
  scrollBy(delta: number): void;
  render(width: number): string[];
  invalidate(): void;
  dispose(): void;
}

const PANE_HEADER_ROWS = 14;

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
  let itemCache = new WeakMap<TranscriptItem, { render(width: number): string[] }>();

  // Re-parse only when the source signature changed, so long sessions do not
  // re-read the JSONL and rebuild every component on each TUI repaint. Stable
  // item objects keep the component WeakMap hitting between renders.
  function getItems(): TranscriptItem[] {
    const sig = opts.sig();
    if (sig !== lastSig) {
      lastSig = sig;
      cachedItems = opts.read();
    }
    return cachedItems;
  }

  function itemLines(item: TranscriptItem, width: number): string[] {
    if (item.type === "system") {
      return [theme.fg("dim", truncateToWidth(item.text, width, "…"))];
    }
    let comp = itemCache.get(item);
    if (!comp) {
      if (item.type === "user") {
        comp = new UserMessageComponent(item.text, getMarkdownTheme());
      } else if (item.type === "assistant") {
        comp = {
          render: (w: number) => {
            const markdown = new Markdown(
              item.text.trim() || "…",
              1,
              0,
              getMarkdownTheme(),
            );
            const thinking = item.thinking
              ? [theme.fg("dim", truncateToWidth(item.thinking, w, "…"))]
              : [];
            return [...thinking, ...markdown.render(w)];
          },
        };
      } else {
        const tool = new ToolExecutionComponent(
          item.name,
          item.toolCallId,
          item.args,
          {},
          undefined,
          tui,
          opts.cwd,
        );
        tool.markExecutionStarted();
        if (item.result !== undefined) {
          tool.updateResult({
            content: [{ type: "text", text: item.result }],
            isError: Boolean(item.isError),
          });
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
    render(width: number): string[] {
      const items = getItems();
      const body: string[] = [];
      for (const item of items) body.push(...itemLines(item, width));

      const rows = tui.terminal.rows;
      const maxBody = Math.max(6, rows - PANE_HEADER_ROWS);
      const visibleCount = Math.min(maxBody, Math.max(1, body.length));
      scrollBack = Math.max(
        0,
        Math.min(scrollBack, Math.max(0, body.length - visibleCount)),
      );
      const end = body.length - scrollBack;
      const visible = body.slice(Math.max(0, end - visibleCount), end);

      const lines: string[] = [];
      lines.push(
        ...new DynamicBorder((str) => theme.fg("border", str)).render(width),
      );
      if (end - visibleCount > 0) {
        lines.push(
          theme.fg("dim", ` ↑ ${end - visibleCount} more line(s) (pageUp)`),
        );
      } else {
        lines.push("");
      }
      for (const line of visible) lines.push(line);
      if (scrollBack > 0) {
        lines.push(
          theme.fg("dim", ` ↓ ${scrollBack} more line(s) (pageDown)`),
        );
      }
      return lines;
    },
    invalidate() {
      // Components cache theme colors internally; rebuild on theme change.
      itemCache = new WeakMap();
    },
    dispose() {
      itemCache = new WeakMap();
    },
  };
}