import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { join } from "node:path";

import { formatMs } from "../helpers.js";
import { renderTaskWidget, renderTaskPanel, type ThemeLike } from "../task-widget.js";
import { ignoreStaleExtensionCtx } from "../stale-ctx.js";
import type { BackgroundTask } from "../types.js";
import {
  isPanelFocused,
  panelRows as orderPanelRows,
  pruneFinishedEntries,
  type PanelSelection,
  type PanelViewState,
  type TaskPanelRow,
} from "../panel/panel-core.js";
import {
  readTaskTranscript,
  transcriptSignature,
  type TranscriptItem,
} from "../panel/transcript.js";
import { TaskPanelEditor, type TaskPanelHost } from "../panel/task-editor.js";
import {
  createTaskTranscriptPane,
  type TaskTranscriptPane,
} from "../panel/task-pane.js";

export interface TaskWidgetControllerDeps {
  /** Steer a running task; returns an error message or null on success. */
  steerTask: (task: BackgroundTask, text: string) => string | null;
  /** Stop a running task's terminal resource; error message or null on success. */
  stopTask: (task: BackgroundTask) => string | null;
  /** Clock for linger/ordering logic (test seam; defaults to Date.now). */
  now?: () => number;
}

export interface TaskWidgetController {
  ensureTaskWidget(targetCtx: ExtensionContext): void;
  /** Install the panel editor wrapper without registering the task widget. */
  ensurePanelEditor(targetCtx: ExtensionContext): void;
  requestRender(): void;
  clearTaskWidgetIfIdle(): void;
  /** Latest extension context the widget was registered with (may be null). */
  getContext(): ExtensionContext | null;
  /** Keep a just-finished task visible in the panel for its linger window. */
  noteTaskFinished(id: string, task: BackgroundTask, now?: number): void;
  dispose(): void;
}

interface FinishedTask {
  task: BackgroundTask;
  finishedAt: number;
}

export function createTaskWidgetController(
  foregroundTasks: Map<string, BackgroundTask>,
  backgroundTasks: Map<string, BackgroundTask>,
  deps?: TaskWidgetControllerDeps,
): TaskWidgetController {
  let widgetCtx: ExtensionContext | null = null;
  let requestWidgetRender: (() => void) | null = null;
  let widgetTheme: ThemeLike | null = null;
  let panelState: PanelViewState = { selection: null, viewTaskId: null };
  const now = () => deps?.now?.() ?? Date.now();
  const finishedTasks = new Map<string, FinishedTask>();
  let activePane: TaskTranscriptPane | undefined;

  // ── Row building ──────────────────────────────────────────────────────────

  function latestActivity(task: BackgroundTask): string | undefined {
    const latest = task.recentCalls?.at(-1);
    if (!latest) return undefined;
    const detail = latest.detail ? ` ${latest.detail}` : "";
    return `${latest.name}${detail}`;
  }

  function allRows(): TaskPanelRow[] {
    const rows: TaskPanelRow[] = [];
    const push = (
      id: string,
      task: BackgroundTask,
      finishedAt: number | undefined,
    ) => {
      rows.push({
        id,
        agentType: task.agentType,
        description: task.description ?? "",
        status: finishedAt !== undefined ? (task.status ?? "done") : "running",
        startedAt: task.startedAt,
        finishedAt,
        activity: latestActivity(task),
      });
    };
    for (const [id, task] of foregroundTasks) push(id, task, undefined);
    for (const [id, task] of backgroundTasks) push(id, task, undefined);
    for (const [id, { task, finishedAt }] of finishedTasks)
      push(id, task, finishedAt);
    return rows;
  }

  function panelRows(): TaskPanelRow[] {
    return orderPanelRows(allRows(), now(), isPanelFocused(panelState));
  }

  function findTask(id: string): BackgroundTask | undefined {
    return (
      foregroundTasks.get(id) ??
      backgroundTasks.get(id) ??
      finishedTasks.get(id)?.task
    );
  }

  function transcriptDir(taskId: string, task: BackgroundTask): string {
    // Terminal children write per-task sessions; SDK children keep artifacts
    // flat (fall back to their recentCalls when no JSONL is found).
    return task.backend === "sdk"
      ? task.dir
      : join(task.dir, "sessions", taskId);
  }

  function itemsFor(taskId: string): TranscriptItem[] {
    try {
      const task = findTask(taskId);
      if (!task) return [];
      const dir = transcriptDir(taskId, task);
      const result = readTaskTranscript(dir, task.sessionName);
      if (result.found && result.items.length > 0) return result.items;
      // SDK children may not flush a session JSONL: show live tool activity.
      return (task.recentCalls ?? []).map((c) => ({
        type: "tool" as const,
        name: c.name,
        toolCallId: c.id ?? "",
        args: {},
        result: c.detail,
        timestamp: "",
      }));
    } catch {
      // A hostile/unreadable session dir must degrade to an empty transcript,
      // not throw inside the TUI render pass.
      return [];
    }
  }

  /** Cheap signature: the session JSONL's mtime+size, or live activity count. */
  function transcriptSig(taskId: string): string {
    try {
      const task = findTask(taskId);
      if (!task) return "";
      const fileSig = transcriptSignature(transcriptDir(taskId, task));
      if (fileSig !== "") return fileSig;
      const calls = task.recentCalls ?? [];
      const last = calls.at(-1);
      return `activity:${calls.length}:${last?.id ?? ""}`;
    } catch {
      return "";
    }
  }

  function reconcileSelection(): void {
    if (
      panelState.selection !== null &&
      panelState.selection !== "main"
    ) {
      const exists = panelRows().some(
        (r) => r.id === (panelState.selection as { taskId: string }).taskId,
      );
      if (!exists) panelState = { ...panelState, selection: null };
    }
  }

  function pruneFinished(): void {
    // The focused panel lists all retained finished rows (aging is a display
    // behavior of the idle widget, per panelRows' focused contract), so only
    // expire from the backing store when the panel is not focused.
    if (isPanelFocused(panelState)) return;
    const retained = pruneFinishedEntries(
      [...finishedTasks.entries()].map(([id, f]) => ({
        id,
        task: f.task,
        finishedAt: f.finishedAt,
      })),
      panelState.viewTaskId,
      now(),
    );
    if (retained.length !== finishedTasks.size) {
      finishedTasks.clear();
      for (const entry of retained) {
        finishedTasks.set(entry.id, {
          task: entry.task as BackgroundTask,
          finishedAt: entry.finishedAt,
        });
      }
    }
  }

  // ── View (transcript pane) ────────────────────────────────────────────────

  function openView(taskId: string): void {
    const ctx = widgetCtx;
    const task = findTask(taskId);
    if (!ctx || !task) return;
    panelState = { selection: null, viewTaskId: taskId };
    ignoreStaleExtensionCtx(() =>
      ctx.ui.setWidget(
        "task-transcript",
        (tui, theme) => {
          const pane = createTaskTranscriptPane(tui, theme, {
            taskId,
            cwd: task.cwd ?? ctx.cwd,
            sig: () => transcriptSig(taskId),
            read: () => itemsFor(taskId),
          });
          activePane = pane;
          return pane;
        },
        { placement: "aboveEditor" },
      ),
    );
    requestRender();
  }

  function closeView(): void {
    const ctx = widgetCtx;
    panelState = { ...panelState, viewTaskId: null, selection: null };
    activePane = undefined;
    if (ctx) {
      ignoreStaleExtensionCtx(() => ctx.ui.setWidget("task-transcript", undefined));
    }
    requestRender();
  }

  // ── Panel actions ─────────────────────────────────────────────────────────

  function steerViewedTask(text: string): void {
    const taskId = panelState.viewTaskId;
    const task = taskId ? findTask(taskId) : undefined;
    if (!taskId || !task) {
      widgetCtx?.ui.notify("No task is open in the transcript view", "error");
      return;
    }
    const error = deps?.steerTask(task, text);
    if (error) {
      widgetCtx?.ui.notify(`Could not steer task: ${error}`, "error");
    }
  }

  function stopTaskRow(taskId: string): void {
    if (finishedTasks.has(taskId)) {
      finishedTasks.delete(taskId);
      reconcileSelection();
      requestRender();
      return;
    }
    const task = findTask(taskId);
    if (!task) return;
    const error = deps?.stopTask(task);
    if (error) {
      widgetCtx?.ui.notify(error, "error");
    }
  }

  const host: TaskPanelHost = {
    panelState: () => panelState,
    panelRows: () => panelRows(),
    onSelect: (selection: PanelSelection) => {
      panelState = { ...panelState, selection };
      requestRender();
    },
    onEnter: (taskId: string | null) => {
      if (taskId) openView(taskId);
      else closeView();
    },
    onStop: (taskId: string) => stopTaskRow(taskId),
    onSteer: (text: string) => steerViewedTask(text),
    onScrollView: (delta: number) => activePane?.scrollBy(delta),
    onExitView: () => closeView(),
    requestRender,
  };

  // ── Widget ────────────────────────────────────────────────────────────────

  function renderWidget(width: number): string[] {
    try {
      // Expire finished rows that outlived their linger window; without this
      // the idle widget would keep a done/failed row forever once the task
      // maps are empty (nothing else re-invokes pruneFinished).
      pruneFinished();
      reconcileSelection();
      if (isPanelFocused(panelState)) {
        return renderTaskPanel({
          rows: panelRows(),
          selection: panelState.selection,
          viewTaskId: panelState.viewTaskId,
          now: now(),
          width,
          theme: widgetTheme,
        });
      }
      return renderTaskWidget({
        foregroundTasks: foregroundTasks.entries(),
        backgroundTasks: backgroundTasks.entries(),
        foregroundCount: foregroundTasks.size,
        backgroundCount: backgroundTasks.size,
        width,
        theme: widgetTheme,
        finishedTasks: [...finishedTasks.entries()].map(
          ([id, f]) => [id, f.task] as const,
        ),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const active = [
        ...Array.from(foregroundTasks.entries()),
        ...Array.from(backgroundTasks.entries()),
        ...Array.from(finishedTasks.entries()).map(([id, f]) => [id, f.task] as const),
      ];
      if (active.length === 0) return [];
      const [, task] = active[0]!;
      return [
        truncateToWidth(
          `${task.agentType}  • ${formatMs(Date.now() - task.startedAt)}  (render error: ${msg})`,
          Math.min(width, 120),
        ),
      ];
    }
  }

  function requestRender(): void {
    requestWidgetRender?.();
  }

  function getContext(): ExtensionContext | null {
    return widgetCtx;
  }

  function installEditor(targetCtx: ExtensionContext): void {
    // Keyboard access needs the editor wrapper; step aside if another
    // extension owns a custom editor (the widget stays display-only).
    if (targetCtx.hasUI && !targetCtx.ui.getEditorComponent()) {
      ignoreStaleExtensionCtx(() =>
        targetCtx.ui.setEditorComponent(
          (tui, theme, keybindings) =>
            new TaskPanelEditor(tui, theme, keybindings, host),
        ),
      );
    }
  }

  function ensureTaskWidget(targetCtx: ExtensionContext): void {
    if (targetCtx.mode !== "tui") return;
    installEditor(targetCtx);
    if (!widgetCtx) {
      widgetCtx = targetCtx;
      ignoreStaleExtensionCtx(() =>
        targetCtx.ui.setWidget(
          "task",
          (tui, theme) => {
            widgetTheme = theme ?? null;
            requestWidgetRender = () => tui.requestRender();
            return {
              render: (width: number) => renderWidget(width),
              invalidate: requestRender,
              dispose: () => {
                widgetTheme = null;
                requestWidgetRender = null;
              },
            };
          },
          // Rows live under the editor so down on an empty prompt enters the
          // panel (pi-subtask / Claude Code placement).
          { placement: "belowEditor" },
        ),
      );
    }
    requestRender();
  }

  function noteTaskFinished(
    id: string,
    task: BackgroundTask,
    finishedAt?: number,
  ): void {
    const completedAt = finishedAt ?? now();
    finishedTasks.set(id, { task, finishedAt: completedAt });
    pruneFinished();
    reconcileSelection();
    requestRender();
  }

  function clearTaskWidgetIfIdle(): void {
    pruneFinished();
    if (
      foregroundTasks.size > 0 ||
      backgroundTasks.size > 0 ||
      finishedTasks.size > 0 ||
      isPanelFocused(panelState)
    ) {
      requestRender();
      return;
    }
    if (widgetCtx) {
      const ctx = widgetCtx;
      ignoreStaleExtensionCtx(() => ctx.ui.setWidget("task", undefined));
      widgetCtx = null;
    }
    requestWidgetRender = null;
  }

  function dispose(): void {
    closeView();
    if (widgetCtx) {
      const ctx = widgetCtx;
      ignoreStaleExtensionCtx(() => ctx.ui.setWidget("task", undefined));
      widgetCtx = null;
    }
    widgetTheme = null;
    requestWidgetRender = null;
    finishedTasks.clear();
  }

  return {
    ensureTaskWidget,
    ensurePanelEditor: installEditor,
    requestRender,
    clearTaskWidgetIfIdle,
    getContext,
    noteTaskFinished,
    dispose,
  };
}