import type {
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { dirname, join } from "node:path";

import { formatMs } from "../helpers.js";
import {
  renderTaskWidget,
  renderTaskPanel,
  TASK_WIDGET_RENDER_MS,
  type ThemeLike,
  type WidgetTask,
} from "../task-widget.js";
import { taskActivity, type TaskActivity } from "../task-activity.js";
import { ignoreStaleExtensionCtx } from "../stale-ctx.js";
import type {
  BackgroundTask,
  ChildBuiltinCommand,
  ChildBuiltinCommandBackend,
  ChildBuiltinCommandResult,
} from "../types.js";
import {
  isPanelFocused,
  panelRows as orderPanelRows,
  pruneFinishedEntries,
  selectAt,
  type PanelSelection,
  type PanelViewState,
  type TaskPanelRow,
} from "../panel/panel-core.js";
import {
  MAX_TRANSCRIPT_ITEMS,
  readTaskSessionFile,
  readTaskTranscript,
  sessionFileSignature,
  transcriptActivity,
  transcriptSignature,
  type ChildSessionMeta,
  type TranscriptItem,
} from "../panel/transcript.js";
import type { TaskContextInfo } from "../panel/task-context.js";
import type { DurableChildAgent } from "../panel/durable-transcript.js";
import {
  CustomEditor,
  getSelectListTheme,
  type SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";
import {
  loadChildPromptTemplates,
  routeChildBuiltinCommand,
  type ChildPromptTemplateService,
} from "../panel/child-prompts.js";
import { TaskPanelEditor, type TaskPanelHost } from "../panel/task-editor.js";
import { TaskOverlay } from "../panel/task-overlay.js";
import {
  TaskTranscriptOverlay,
  type SteerEditorLike,
} from "../panel/task-transcript-overlay.js";
import {
  createTaskTranscriptPane,
  type TaskTranscriptPane,
} from "../panel/task-pane.js";
import {
  createTaskTranscriptSessionView,
  findTaskTranscriptViewLink,
  hasTaskTranscriptViewMarker,
  readPersistedPiSessionId,
} from "../panel/task-session-view.js";

/**
 * The steer prompt: a real CustomEditor (full editing like the main input)
 * whenever the host theme provides fg/bg, falling back to a minimal
 * accumulating input for degraded hosts/themes. The overlay routes
 * submit/scroll keys around whichever editor this returns.
 */
export function createSteerEditor(
  tui: import("@earendil-works/pi-tui").TUI,
  theme: unknown,
  keybindings: unknown,
  editorPaddingX = 0,
): SteerEditorLike {
  const t = theme as { fg?: unknown; bg?: unknown } | null | undefined;
  if (t && typeof t.fg === "function" && typeof t.bg === "function") {
    try {
      // Pi's general Theme has no borderColor/selectList — those come from the
      // editor-theme adapter (getSelectListTheme + the borderMuted token), the
      // same split pi's own interactive mode uses for its editors.
      const editorTheme = {
        // "border" (not the main editor's dimmer borderMuted): the steer input
        // floats over the overlay fill and needs the contrast.
        borderColor: (text: string) => (t.fg as (c: string, s: string) => string)("border", text),
        selectList: getSelectListTheme() as never,
      };
      const nativeEditor = new CustomEditor(
        tui,
        editorTheme as never,
        keybindings as never,
        // Native chrome: the working indicator renders inside the editor's top
        // border (pi's own streaming screen does the same). Harmless when no
        // indicator is set: the border renders unchanged.
        { embedWorkingStatus: true, paddingX: editorPaddingX },
      );
      const editor = nativeEditor as unknown as SteerEditorLike;
      // Autocomplete state and submit callback are public Editor APIs; the
      // overlay uses them to preserve native menu navigation and acceptance.
      return editor;
    } catch {
      // Theme not initialized / degraded host: fall through to the minimal input.
    }
  }
  return new MinimalSteerEditor(editorPaddingX);
}

class MinimalSteerEditor implements SteerEditorLike {
  private text = "";
  private readonly paddingX: number;

  constructor(paddingX: number) {
    this.paddingX = Number.isFinite(paddingX) ? Math.max(0, Math.floor(paddingX)) : 0;
  }

  handleInput(data: string): void {
    if (data === "\x7f") {
      const chars = [...this.text];
      chars.pop();
      this.text = chars.join("");
      return;
    }
    if (data >= " " && !data.startsWith("\x1b")) this.text += data;
  }

  render(width: number): string[] {
    return [truncateToWidth(`${" ".repeat(this.paddingX)}❯ ${this.text}`, width, "…")];
  }

  getText(): string {
    return this.text;
  }

  setText(text: string): void {
    this.text = text;
  }
}

export interface TaskWidgetControllerDeps {
  /** Effective host display settings used by Pi's own editor/transcript renderers. */
  getDisplaySettings?: () => { editorPaddingX?: number; outputPad?: 0 | 1 };
  /** Steer a running task; returns an error message or null on success. */
  steerTask: (
    task: BackgroundTask,
    taskId: string,
    text: string,
  ) => string | null | Promise<string | null>;
  /** Dispatch a verified Pi built-in only to the selected child's own session/backend. */
  runChildBuiltinCommand?: (
    task: BackgroundTask,
    taskId: string,
    command: ChildBuiltinCommand,
  ) => ChildBuiltinCommandResult | Promise<ChildBuiltinCommandResult>;
  /** Stop a running task's terminal resource; error message or null on success. */
  stopTask: (taskId: string, task: BackgroundTask) => string | null | Promise<string | null>;
  /** Current parent prompt/extension command descriptors; bodies stay in Pi's resource loader. */
  getCommands?: () => SlashCommandInfo[];
  /** Test seam for an isolated prompt resource directory. */
  getPromptAgentDir?: () => string;
  /** Whether a Pi session can be replaced without discarding task lifecycle state. */
  canReplaceSession?: () => boolean;
  /** Clock for linger/ordering logic (test seam; defaults to Date.now). */
  now?: () => number;
}

export interface TaskWidgetController {
  ensureTaskWidget(targetCtx: ExtensionContext): void;
  /** Install the panel editor wrapper without registering the task widget. */
  ensurePanelEditor(targetCtx: ExtensionContext): void;
  /**
   * Open the centered /task overlay: a ctx.ui.custom modal that browses the
   * session's tasks (↑↓ select, enter opens the live view, x stops,
   * esc closes). Returns false when the TUI is unavailable, so the caller can
   * fall back to a text listing.
   */
  openOverlay(targetCtx: ExtensionContext): Promise<boolean>;
  /** Open the main/subagent transcript switcher without changing views on cancel. */
  openAgentSwitcher(targetCtx: ExtensionCommandContext): Promise<boolean>;
  /** Toggle the compact progress widget; undefined means no TUI is available. */
  toggleTaskMonitor(targetCtx: ExtensionContext): boolean | undefined;
  /** Open a task's transcript view without requiring panel navigation. */
  openTaskView(taskId: string): void;
  /** Close the transcript view only if it still shows this task. */
  closeTaskView(taskId: string): void;
  /**
   * Replace one durable task's bounded transcript and cumulative tool-call
   * count. `agent` is the child conversation's own `pi.agent` state (model,
   * thinking level, cwd) when the live stream carries one.
   */
  setLiveTranscript(
    taskId: string,
    items: readonly TranscriptItem[],
    toolUses?: number,
    agent?: DurableChildAgent,
  ): void;
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
  let taskWidgetInstalled = false;
  let requestWidgetRender: (() => void) | null = null;
  let widgetTheme: ThemeLike | null = null;
  let panelState: PanelViewState = { selection: null, viewTaskId: null };
  let taskMonitorVisible = true;
  let agentsSwitcher = false;
  let panelEditorInstalled = false;
  /** The transcript the picker interrupted, so its row can keep a "(shown)" marker. */
  let switcherShownId: string | null = null;
  let switcherRestoreOverlayId: string | null = null;
  let agentsCommandContext: ExtensionCommandContext | undefined;
  let agentsParentSessionPath: string | undefined;
  let agentsParentSessionId: string | undefined;
  const now = () => deps?.now?.() ?? Date.now();
  const finishedTasks = new Map<string, FinishedTask>();
  const liveTranscripts = new Map<
    string,
    { items: TranscriptItem[]; revision: number; agent?: DurableChildAgent }
  >();
  /** Child session metadata (model/thinking) memoized by transcript signature. */
  const sessionMetaCache = new Map<string, { sig: string; meta?: ChildSessionMeta }>();
  const stoppingTaskIds = new Set<string>();
  let activePane: TaskTranscriptPane | undefined;
  /** The mounted overlay component, so closing the view stops its timers. */
  let activeOverlay: TaskTranscriptOverlay | undefined;
  /** Repaints the below-editor rows while at least one task is still running. */
  let animationTicker: ReturnType<typeof setInterval> | undefined;

  // ── Working indicators ───────────────────────────────────────────────────

  /** Phase of a task's child right now; undefined once it has settled. */
  function activityFor(taskId: string, task: BackgroundTask): TaskActivity | undefined {
    return taskActivity({
      items: liveTranscripts.get(taskId)?.items,
      recentCalls: task.recentCalls,
      status: task.status,
    });
  }

  /**
   * Child session metadata Pi persisted in its own JSONL (`model_change`,
   * `thinking_level_change`). Read lazily and memoized by the same cheap
   * signature the transcript pane uses, so an open panel re-reads only when the
   * child's session actually grows.
   */
  function sessionMetaFor(taskId: string, task: BackgroundTask): ChildSessionMeta | undefined {
    try {
      const sig = transcriptSig(taskId);
      const cached = sessionMetaCache.get(taskId);
      if (cached && cached.sig === sig) return cached.meta;
      const result =
        task.backend === "sdk" && task.sessionPath
          ? readTaskSessionFile(task.sessionPath)
          : readTaskTranscript(transcriptDir(taskId, task), task.sessionName);
      const meta = result.found ? result.meta : undefined;
      sessionMetaCache.set(taskId, { sig, meta });
      return meta;
    } catch {
      // A hostile/unreadable session dir must degrade to "no metadata", never
      // break the render pass.
      return undefined;
    }
  }

  /**
   * What the live child panel may state about the viewed child. Only recorded
   * facts: the task record, the child's durable `pi.agent` state, or its own
   * session metadata. Model/thinking stay absent when nothing recorded them.
   */
  function childContext(taskId: string): TaskContextInfo | undefined {
    const task = findTask(taskId);
    if (!task) return undefined;
    const durableAgent = liveTranscripts.get(taskId)?.agent;
    const meta = durableAgent ? undefined : sessionMetaFor(taskId, task);
    const rows = allRows();
    const index = rows.findIndex((row) => row.id === taskId);
    const end = rows[index]?.finishedAt ?? now();
    return {
      taskId,
      agentType: task.agentType,
      description: task.description,
      status: task.status,
      phaseLabel: activityFor(taskId, task)?.label,
      backend: task.backend,
      runtime: task.runtime,
      cwd: durableAgent?.cwd ?? task.cwd ?? widgetCtx?.cwd,
      model: durableAgent?.model ?? meta?.model ?? task.comparisonModel,
      thinkingLevel: durableAgent?.thinkingLevel ?? meta?.thinkingLevel,
      elapsedMs: Math.max(0, end - task.startedAt),
      toolUses: task.toolUses,
      taskIndex: index >= 0 ? index + 1 : undefined,
      taskCount: rows.length,
    };
  }

  function hasRunningTask(): boolean {
    for (const task of foregroundTasks.values()) {
      if (task.status === undefined || task.status === "running") return true;
    }
    for (const task of backgroundTasks.values()) {
      if (task.status === undefined || task.status === "running") return true;
    }
    return false;
  }

  /**
   * The rows animate a clock-derived frame, so they only need a repaint every
   * TASK_WIDGET_RENDER_MS. The ticker runs exactly while a running task is on
   * screen (no overlay owns the screen) and stops itself, so no timer outlives
   * the work it animates, a disposed widget, or a replaced session.
   */
  function syncAnimationTicker(): void {
    const wanted =
      taskWidgetInstalled &&
      taskMonitorVisible &&
      panelState.viewTaskId === null &&
      hasRunningTask();
    if (!wanted) {
      stopAnimationTicker();
      return;
    }
    if (animationTicker) return;
    animationTicker = setInterval(() => {
      if (!hasRunningTask()) {
        stopAnimationTicker();
        return;
      }
      requestRender();
    }, TASK_WIDGET_RENDER_MS);
    animationTicker.unref?.();
  }

  function stopAnimationTicker(): void {
    if (!animationTicker) return;
    clearInterval(animationTicker);
    animationTicker = undefined;
  }

  // ── Row building ──────────────────────────────────────────────────────────

  function latestActivity(task: BackgroundTask): string | undefined {
    const latest = task.recentCalls?.at(-1);
    if (!latest) return undefined;
    const detail = latest.detail ? ` ${latest.detail}` : "";
    return `${latest.name}${detail}`;
  }

  function retainedFinishedRows(): Array<[string, FinishedTask]> {
    return [...finishedTasks.entries()].filter(
      ([id]) => !foregroundTasks.has(id) && !backgroundTasks.has(id),
    );
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
    for (const [id, { task, finishedAt }] of retainedFinishedRows())
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
      const live = task.backend === "durable" ? liveTranscripts.get(taskId) : undefined;
      if (live) return live.items;
      // SDK children capture the exact session file when the session opens;
      // reading it directly beats scanning a sessions dir (the parent session
      // quotes task ids too) and beats the artifacts dir (no session there).
      if (task.backend === "sdk" && task.sessionPath) {
        const exact = readTaskSessionFile(task.sessionPath);
        if (exact.found && exact.items.length > 0) return exact.items;
      }
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
      const live = task.backend === "durable" ? liveTranscripts.get(taskId) : undefined;
      if (live) return `durable:${live.revision}`;
      if (task.backend === "sdk" && task.sessionPath) {
        const fileSig = sessionFileSignature(task.sessionPath);
        if (fileSig !== "") return fileSig;
      }
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
    // expire from the backing store when the panel is not focused. The /task
    // overlay browses the same rows, so browsing must not expire them either.
    if (isPanelFocused(panelState) || overlayOpen) return;
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
      const retainedIds = new Set(retained.map((entry) => entry.id));
      for (const id of finishedTasks.keys()) {
        if (
          !retainedIds.has(id) &&
          !foregroundTasks.has(id) &&
          !backgroundTasks.has(id)
        ) liveTranscripts.delete(id);
      }
      finishedTasks.clear();
      for (const entry of retained) {
        finishedTasks.set(entry.id, {
          task: entry.task as BackgroundTask,
          finishedAt: entry.finishedAt,
        });
      }
    }
  }

  // ── View (transcript overlay) ────────────────────────────────────────────



  // Generation guard: a stale overlay's cleanup must not clobber a newer
  // view opened after fast close/reopen sequences.
  let viewGeneration = 0;
  let transcriptOverlayDone: ((result?: unknown) => void) | undefined;
  let transcriptTicker: ReturnType<typeof setInterval> | undefined;

  /** Returns false when no widget context or task is available to render. */
  function openView(taskId: string): boolean {
    const ctx = widgetCtx;
    const task = findTask(taskId);
    if (!ctx || !task) return false;
    if (panelState.viewTaskId === taskId) return true;
    closeView();
    panelState = { selection: null, viewTaskId: taskId };
    syncAnimationTicker();
    const generation = ++viewGeneration;
    overlayOpen = true;
    const childCwd = task.cwd ?? ctx.cwd;
    const builtinBackend: ChildBuiltinCommandBackend = task.comparisonIndex !== undefined
      ? "none"
      : task.backend === "durable"
        ? "durable"
        : task.backend === "sdk"
          ? "sdk"
          : "terminal";
    let parentCommands: SlashCommandInfo[] = [];
    try {
      parentCommands = deps?.getCommands?.() ?? [];
    } catch {
      // Suggestions degrade to child-local prompts if the host command API is stale.
    }
    const promptTemplatesPromise: Promise<ChildPromptTemplateService | undefined> =
      task.runtime === "claude"
        ? Promise.resolve(undefined)
        : loadChildPromptTemplates({
            cwd: childCwd,
            parentCwd: ctx.cwd,
            parentProjectTrusted: ctx.isProjectTrusted?.() ?? false,
            parentCommands,
            backend: builtinBackend,
            agentDir: deps?.getPromptAgentDir?.(),
          }).catch((error: unknown) => {
            try {
              ctx.ui.notify(
                `Task prompt templates are unavailable: ${error instanceof Error ? error.message : String(error)}`,
                "warning",
              );
            } catch {
              // The transcript view remains usable with raw steering.
            }
            return undefined;
          });
    let displaySettings: { editorPaddingX?: number; outputPad?: 0 | 1 } | undefined;
    try {
      displaySettings = deps?.getDisplaySettings?.();
    } catch {
      // Display settings are optional; a stale/replaced context must not stop
      // the view from using Pi's defaults.
      displaySettings = undefined;
    }
    /** Phase of the viewed child, for the working row and the repaint policy. */
    const viewedActivity = () => {
      const viewed = findTask(taskId);
      return viewed ? activityFor(taskId, viewed) : undefined;
    };
    // Live streaming: the pane re-reads the session on signature change, so a
    // steady repaint tick turns JSONL growth into live transcript updates.
    // While the working indicator animates it already repaints every frame, so
    // this slower tick yields to it instead of drawing a second frame.
    clearInterval(transcriptTicker);
    transcriptTicker = setInterval(() => {
      if (viewedActivity()) return;
      requestRender();
    }, 700);
    transcriptTicker.unref?.();
    // A synchronous `ui.custom` failure leaves `overlay` unset, so the view is
    // honestly reported as not opened. The stale-ctx throw a replaced session
    // raises is just another such failure here.
    let overlay: Promise<unknown> | undefined;
    try {
      overlay = ctx.ui
        .custom(
          (tui, theme, keybindings, done) => {
            transcriptOverlayDone = done as (result?: unknown) => void;
            const pane = createTaskTranscriptPane(tui, theme, {
              taskId,
              cwd: childCwd,
              sig: () => transcriptSig(taskId),
              read: () => itemsFor(taskId),
              // Match the parent transcript's configured horizontal padding.
              outputPad: displaySettings?.outputPad ?? 1,
            });
            activePane = pane;
            const editor = createSteerEditor(
              tui,
              theme,
              keybindings,
              displaySettings?.editorPaddingX,
            );
            activeOverlay = new TaskTranscriptOverlay({
              pane,
              host: {
                taskId,
                onSteer: (text: string) =>
                  steerViewedTask(taskId, text, promptTemplatesPromise, generation, ctx, builtinBackend),
                onClose: () => done(undefined),
                requestRender,
                // The viewed child's live phase drives the animated working row.
                activity: viewedActivity,
                // Compact child status row + footer, from recorded facts only.
                context: () => childContext(taskId),
              },
              theme,
              editor,
              terminalRows: () => tui.terminal.rows,
              ui: tui,
              keybindings,
            });
            void promptTemplatesPromise.then((service) => {
              if (
                !service ||
                generation !== viewGeneration ||
                activeOverlay === undefined
              ) return;
              editor.setAutocompleteProvider?.(service.autocompleteProvider);
              requestRender();
            });
            return activeOverlay;
          },
          {
            overlay: true,
            overlayOptions: {
              anchor: "top-left",
              width: "100%",
              maxHeight: "100%",
              margin: 0,
            },
          },
        );
    } catch {
      // No overlay was created.
    }
    if (!overlay) {
      overlayOpen = false;
      clearInterval(transcriptTicker);
      transcriptTicker = undefined;
      if (panelState.viewTaskId === taskId) {
        panelState = { ...panelState, viewTaskId: null, selection: null };
      }
      syncAnimationTicker();
      requestRender();
      return false;
    }
    // Attach cleanup to the real overlay promise; a void-returning guard would
    // settle immediately and wipe the state of a view that is still up.
    void overlay
      .catch(() => {})
      .finally(() => {
        if (generation !== viewGeneration) return;
        clearInterval(transcriptTicker);
        transcriptTicker = undefined;
        transcriptOverlayDone = undefined;
        activePane = undefined;
        activeOverlay = undefined;
        if (panelState.viewTaskId === taskId) {
          panelState = { ...panelState, viewTaskId: null, selection: null };
        }
        overlayOpen = false;
        clearTaskWidgetIfIdle();
      });
    requestRender();
    return true;
  }

  function closeView(): void {
    panelState = { ...panelState, viewTaskId: null, selection: null };
    syncAnimationTicker();
    const done = transcriptOverlayDone;
    transcriptOverlayDone = undefined;
    activePane = undefined;
    // Pi disposes the component when the custom promise settles; disposing here
    // too stops the working indicator's timer as soon as the view closes.
    activeOverlay?.dispose();
    activeOverlay = undefined;
    clearInterval(transcriptTicker);
    transcriptTicker = undefined;
    if (done) done(undefined);
    requestRender();
  }

  function openTaskView(taskId: string): void {
    openView(taskId);
  }

  function closeTaskView(taskId: string): void {
    if (panelState.viewTaskId === taskId) closeView();
  }

  function clearAgentSwitcherState(): void {
    agentsSwitcher = false;
    switcherShownId = null;
    switcherRestoreOverlayId = null;
    agentsCommandContext = undefined;
    agentsParentSessionPath = undefined;
    agentsParentSessionId = undefined;
  }

  function notifyCommandContext(
    ctx: ExtensionCommandContext,
    message: string,
    level: "info" | "warning" | "error",
  ): void {
    ignoreStaleExtensionCtx(() => ctx.ui.notify(message, level));
  }

  async function switchSession(
    ctx: ExtensionCommandContext,
    sessionPath: string,
    message: string,
  ): Promise<boolean> {
    try {
      const result = await ctx.switchSession(sessionPath, {
        withSession: async (nextCtx) => nextCtx.ui.notify(message, "info"),
      });
      if (result.cancelled) {
        notifyCommandContext(ctx, "Session switch was cancelled.", "warning");
        return false;
      }
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      notifyCommandContext(ctx, `Could not switch sessions: ${detail}`, "error");
      return false;
    }
  }

  function switchToTaskSession(
    taskId: string,
    ctx: ExtensionCommandContext,
    restoreOverlayId: string | null,
    originalParentSessionPath?: string,
    originalParentSessionId?: string,
  ): void {
    const task = findTask(taskId);
    if (!task) {
      notifyCommandContext(ctx, `Task ${taskId} is no longer available.`, "warning");
      if (restoreOverlayId) openView(restoreOverlayId);
      return;
    }
    if (!ctx.model) {
      notifyCommandContext(ctx, "Select a model before opening a task transcript.", "warning");
      if (restoreOverlayId) openView(restoreOverlayId);
      return;
    }
    if (deps?.canReplaceSession && !deps.canReplaceSession()) {
      // Replacing the Pi session now would abort a live task and discard its
      // handles, but the transcript itself is still viewable. Degrade to the
      // live overlay for the selected task instead of refusing outright.
      const opened = openView(taskId);
      notifyCommandContext(
        ctx,
        opened
          ? "A Pi session snapshot is unavailable while tasks or completion notices are pending; showing the live transcript instead. Use /task list to steer running tasks."
          : "A Pi session snapshot is unavailable while tasks or completion notices are pending, and the live task view is not available. Use /task list.",
        opened ? "info" : "warning",
      );
      return;
    }

    const parentSessionPath =
      originalParentSessionPath ?? ctx.sessionManager.getSessionFile();
    const parentSessionId =
      originalParentSessionId ?? ctx.sessionManager.getHeader()?.id;
    if (!parentSessionPath || !parentSessionId) {
      notifyCommandContext(
        ctx,
        "Cannot open a child snapshot from an unsaved Pi session; there is no safe return path.",
        "warning",
      );
      if (restoreOverlayId) openView(restoreOverlayId);
      return;
    }

    const items = itemsFor(taskId);
    const result = createTaskTranscriptSessionView({
      taskId,
      cwd: task.cwd ?? ctx.cwd,
      sessionDir: dirname(parentSessionPath), // Keep generated sessions in Pi's trusted store, not task.dir.
      parentSessionPath,
      parentSessionId,
      model: {
        api: ctx.model.api,
        provider: ctx.model.provider,
        model: ctx.model.id,
      },
      items,
    });
    if (!result.ok) {
      const detail =
        result.error.kind === "empty-transcript"
          ? "The transcript contains no readable messages."
          : result.error.message;
      notifyCommandContext(ctx, `Could not open task transcript: ${detail}`, "error");
      if (restoreOverlayId) openView(restoreOverlayId);
      return;
    }

    if (panelState.viewTaskId !== null) closeView();
    void switchSession(
      ctx,
      result.sessionPath,
      `Opened a snapshot of ${taskId}; use /agents → main to return. Use /task list for the live, steerable view.`,
    ).then((switched) => {
      if (!switched && restoreOverlayId) openView(restoreOverlayId);
    });
  }

  function activateAgentTarget(taskId: string | null): void {
    const ctx = agentsCommandContext;
    const parentSessionPath = agentsParentSessionPath;
    const parentSessionId = agentsParentSessionId;
    const restoreOverlayId = switcherRestoreOverlayId;
    clearAgentSwitcherState();
    if (!ctx) {
      widgetCtx?.ui.notify("The /agents session context is no longer available.", "warning");
      return;
    }
    if (typeof ctx.switchSession !== "function") {
      notifyCommandContext(ctx, "/agents needs Pi's session-switch command API.", "warning");
      if (restoreOverlayId) openView(restoreOverlayId);
      return;
    }
    if (taskId) {
      switchToTaskSession(
        taskId,
        ctx,
        restoreOverlayId,
        parentSessionPath,
        parentSessionId,
      );
      return;
    }
    if (parentSessionPath) {
      if (
        !parentSessionId ||
        readPersistedPiSessionId(parentSessionPath, parentSessionId) !== parentSessionId
      ) {
        notifyCommandContext(
          ctx,
          "The parent Pi session is missing or invalid; refusing to switch to it.",
          "warning",
        );
        if (restoreOverlayId) openView(restoreOverlayId);
        return;
      }
      if (panelState.viewTaskId !== null) closeView();
      void switchSession(ctx, parentSessionPath, "Returned to the parent conversation.").then(
        (switched) => {
          if (!switched && restoreOverlayId) openView(restoreOverlayId);
        },
      );
      return;
    }
    closeView();
  }

  // ── Panel actions ─────────────────────────────────────────────────────────

  function steerViewedTask(
    taskId: string,
    text: string,
    promptTemplatesPromise: Promise<ChildPromptTemplateService | undefined> | undefined,
    generation: number,
    ctx: ExtensionContext,
    builtinBackend: ChildBuiltinCommandBackend,
  ): void {
    const isCurrentView = () =>
      generation === viewGeneration &&
      panelState.viewTaskId === taskId &&
      widgetCtx === ctx;
    const notify = (message: string, level: "info" | "warning" | "error") => {
      if (!isCurrentView()) return;
      ignoreStaleExtensionCtx(() => ctx.ui.notify(message, level));
    };
    if (!isCurrentView()) return;
    const task = findTask(taskId);
    if (!task) {
      notify("No task is open in the transcript view", "error");
      return;
    }
    const activelyTracked = foregroundTasks.has(taskId) || backgroundTasks.has(taskId);
    if (!activelyTracked || (task.status !== undefined && task.status !== "running")) {
      notify("This task is no longer running; its transcript is read-only.", "warning");
      return;
    }
    void (async () => {
      if (task.runtime !== "claude" && text.trim().startsWith("/")) {
        let route: Awaited<ReturnType<typeof routeChildBuiltinCommand>>;
        try {
          route = await routeChildBuiltinCommand(text, builtinBackend);
        } catch (error) {
          notify(
            `Pi's child command catalog is unavailable; no slash command was sent: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
          return;
        }
        if (!isCurrentView()) return;
        if (route?.kind === "unsupported") {
          notify(route.message, "error");
          return;
        }
        if (route?.kind === "supported") {
          const result = await deps?.runChildBuiltinCommand?.(task, taskId, route.command);
          if (!isCurrentView()) return;
          if (!result) {
            notify(`/${route.command.name} is not available for this child task.`, "error");
          } else {
            notify(result.message, result.level);
          }
          return;
        }
      }

      let steeringText = text;
      if (task.runtime !== "claude" && promptTemplatesPromise) {
        const service = await promptTemplatesPromise;
        if (!isCurrentView()) return;
        if (service) {
          const backend = task.backend === "sdk"
            ? "sdk"
            : task.backend === "durable"
              ? "durable"
              : "terminal";
          const prepared = service.prepareSteeringInput(text, backend);
          if (prepared.error) {
            notify(prepared.error, "error");
            return;
          }
          steeringText = prepared.text;
        }
      }
      if (!isCurrentView()) return;
      const error = await deps?.steerTask(task, taskId, steeringText);
      if (!isCurrentView()) return;
      if (error) notify(`Could not steer task: ${error}`, "error");
    })().catch((error: unknown) => {
      notify(
        `Could not steer task: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    });
  }

  function stopTaskRow(taskId: string): void {
    const task = foregroundTasks.get(taskId) ?? backgroundTasks.get(taskId);
    if (!task) {
      if (!finishedTasks.has(taskId)) return;
      finishedTasks.delete(taskId);
      liveTranscripts.delete(taskId);
      reconcileSelection();
      requestRender();
      return;
    }
    if (stoppingTaskIds.has(taskId)) return;
    if (task.backend === "durable" && task.durableAbortController) {
      // Latch cancellation on the runner before it can admit its child input;
      // aborting an idle conversation here would leave the runner free to submit.
      task.durableAbortController.abort();
      return;
    }
    stoppingTaskIds.add(taskId);
    Promise.resolve()
      .then(() => deps?.stopTask(taskId, task))
      .then((error) => {
        if (error) widgetCtx?.ui.notify(error, "error");
      })
      .catch((error: unknown) => {
        widgetCtx?.ui.notify(error instanceof Error ? error.message : String(error), "error");
      })
      .finally(() => {
        stoppingTaskIds.delete(taskId);
        requestRender();
      });
  }

  const host: TaskPanelHost = {
    panelState: () => panelState,
    taskMonitorVisible: () => taskMonitorVisible,
    panelRows: () => panelRows(),
    onSelect: (selection: PanelSelection) => {
      if (selection === null) {
        clearAgentSwitcherState();
        panelState = { ...panelState, switcherMode: false };
      }
      panelState = { ...panelState, selection };
      requestRender();
    },
    onCancelSwitcher: () => {
      // The picker contract: cancelling restores only an interrupted overlay;
      // a native Pi transcript session remains active behind the picker.
      const restore = switcherRestoreOverlayId;
      clearAgentSwitcherState();
      panelState = { ...panelState, selection: null, switcherMode: false };
      if (restore) openView(restore);
      else requestRender();
    },
    onEnter: (taskId: string | null) => {
      if (agentsSwitcher) {
        panelState = { ...panelState, selection: null, switcherMode: false };
        activateAgentTarget(taskId);
        return;
      }
      panelState = { ...panelState, selection: null, switcherMode: false };
      if (taskId) openView(taskId);
      else closeView();
    },
    onStop: (taskId: string) => stopTaskRow(taskId),
    onSteer: (text: string) => {
      const taskId = panelState.viewTaskId;
      const ctx = widgetCtx;
      const task = taskId ? findTask(taskId) : undefined;
      if (!taskId || !ctx || !task) return;
      const builtinBackend: ChildBuiltinCommandBackend = task.comparisonIndex !== undefined
        ? "none"
        : task.backend === "durable"
          ? "durable"
          : task.backend === "sdk"
            ? "sdk"
            : "terminal";
      steerViewedTask(
        taskId,
        text,
        undefined,
        viewGeneration,
        ctx,
        builtinBackend,
      );
    },
    onScrollView: (delta: number) => activePane?.scrollBy(delta),
    onExitView: () => closeView(),
    requestRender,
  };

  // ── Widget ────────────────────────────────────────────────────────────────

  /** Task rows plus the phase that drives their animated working indicator. */
  function* withActivity(
    entries: Iterable<[string, BackgroundTask]>,
  ): Generator<[string, WidgetTask]> {
    for (const [id, task] of entries) {
      yield [id, { ...task, activity: activityFor(id, task) }];
    }
  }

  function renderWidget(width: number): string[] {
    try {
      // Expire finished rows that outlived their linger window; without this
      // the idle widget would keep a done/failed row forever once the task
      // maps are empty (nothing else re-invokes pruneFinished).
      pruneFinished();
      reconcileSelection();
      if (!taskMonitorVisible) return [];
      // The transcript overlay owns the screen while a view is open; the
      // below-editor panel would be a second copy of the same information.
      if (panelState.viewTaskId !== null) return [];
      if (isPanelFocused(panelState)) {
        return renderTaskPanel({
          rows: panelRows(),
          selection: panelState.selection,
          viewTaskId: panelState.viewTaskId,
          now: now(),
          width,
          theme: widgetTheme,
          ...(agentsSwitcher
            ? {
                hint: `Switch to: ${panelRows().length + 1} agents — ↑↓ select · enter switch · esc close`,
                showTaskIds: true,
                shownTaskId: switcherShownId,
              }
            : {}),
        });
      }
      return renderTaskWidget({
        foregroundTasks: withActivity(foregroundTasks.entries()),
        backgroundTasks: withActivity(backgroundTasks.entries()),
        foregroundCount: foregroundTasks.size,
        backgroundCount: backgroundTasks.size,
        width,
        theme: widgetTheme,
        finishedTasks: retainedFinishedRows().map(
          ([id, f]) => [id, f.task] as const,
        ),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const active = [
        ...Array.from(foregroundTasks.entries()),
        ...Array.from(backgroundTasks.entries()),
        ...retainedFinishedRows().map(([id, f]) => [id, f.task] as const),
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

  function setLiveTranscript(
    taskId: string,
    items: readonly TranscriptItem[],
    toolUses?: number,
    agent?: DurableChildAgent,
  ): void {
    const task = findTask(taskId);
    if (!task || task.backend !== "durable") return;
    const retained = items.slice(-MAX_TRANSCRIPT_ITEMS);
    const previous = liveTranscripts.get(taskId);
    // A watch-error update carries no agent state; keep the last one we saw.
    const nextAgent = agent ?? previous?.agent;
    liveTranscripts.set(taskId, {
      items: [...retained],
      revision: (previous?.revision ?? 0) + 1,
      ...(nextAgent === undefined ? {} : { agent: nextAgent }),
    });
    const calls = retained.filter((item): item is Extract<TranscriptItem, { type: "tool" }> => item.type === "tool");
    task.toolUses = toolUses ?? calls.length;
    task.recentCalls = calls.slice(-10).map((item) => {
      const summary = transcriptActivity([item]);
      const detail = summary.startsWith("$ ")
        ? summary.slice(2)
        : summary.startsWith(`${item.name} `)
          ? summary.slice(item.name.length + 1)
          : "";
      return {
        id: item.toolCallId,
        name: item.name,
        detail,
        status: item.inProgress ? "in_progress" : item.isError ? "error" : "done",
      };
    });
    // The phase just changed (tool -> thinking/streaming or back).
    syncAnimationTicker();
    requestRender();
  }

  function requestRender(): void {
    requestWidgetRender?.();
  }

  function getContext(): ExtensionContext | null {
    return widgetCtx;
  }

  function installEditor(targetCtx: ExtensionContext): void {
    if (targetCtx.mode === "tui") widgetCtx = targetCtx;
    // Keyboard access needs the editor wrapper; step aside if another
    // extension owns a custom editor (the widget stays display-only).
    // Hosts without the editor APIs just get the display-only widget.
    if (
      targetCtx.hasUI &&
      typeof targetCtx.ui.getEditorComponent === "function" &&
      typeof targetCtx.ui.setEditorComponent === "function" &&
      !targetCtx.ui.getEditorComponent()
    ) {
      panelEditorInstalled = true;
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
    widgetCtx = targetCtx;
    installEditor(targetCtx);
    if (!taskWidgetInstalled) {
      taskWidgetInstalled = true;
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
    syncAnimationTicker();
    requestRender();
  }

  function toggleTaskMonitor(
    targetCtx: ExtensionContext,
  ): boolean | undefined {
    if (targetCtx.mode !== "tui" || !targetCtx.hasUI) return undefined;
    taskMonitorVisible = !taskMonitorVisible;
    if (!taskMonitorVisible) {
      panelState = { ...panelState, selection: null };
    }
    if (
      taskMonitorVisible &&
      (foregroundTasks.size > 0 || backgroundTasks.size > 0 || finishedTasks.size > 0)
    ) {
      ensureTaskWidget(targetCtx);
    } else {
      syncAnimationTicker();
      requestRender();
    }
    return taskMonitorVisible;
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
    syncAnimationTicker();
    requestRender();
  }

  let overlayOpen = false;

  async function showOverlay(
    targetCtx: ExtensionContext,
    mode: "tasks" | "agents" = "tasks",
  ): Promise<boolean> {
    if (targetCtx.mode !== "tui" || !targetCtx.hasUI) return false;
    if (mode === "tasks") {
      // The task browser is independent of whichever transcript was open.
      if (panelState.viewTaskId !== null) closeView();
      panelState = { selection: null, viewTaskId: null };
    }
    overlayOpen = true;
    try {
      await targetCtx.ui.custom(
        (_tui, theme, _keybindings, done) =>
          new TaskOverlay(
            {
              getRows: () => panelRows(),
              now,
              onStop: (taskId) => stopTaskRow(taskId),
              onOpen: (taskId) => {
                done(undefined);
                if (mode === "agents") {
                  activateAgentTarget(taskId);
                } else if (taskId === null) {
                  closeView();
                } else {
                  openView(taskId);
                }
              },
              onClose: () => done(undefined),
              requestRender,
            },
            theme,
            mode === "agents"
              ? { mode, getShownTaskId: () => switcherShownId }
              : {},
          ),
        {
          overlay: true,
          overlayOptions: { anchor: "center", width: "70%", maxHeight: "60%" },
        },
      );
    } finally {
      overlayOpen = false;
      if (mode === "agents") {
        clearAgentSwitcherState();
        panelState = { ...panelState, selection: null, switcherMode: false };
      }
      clearTaskWidgetIfIdle();
    }
    return true;
  }

  function openOverlay(targetCtx: ExtensionContext): Promise<boolean> {
    return showOverlay(targetCtx);
  }

  /**
   * Open Pi's main/subagent switcher. Selecting a child creates a Pi-native
   * transcript snapshot; selecting main from that snapshot returns to its
   * parent session. The task overlay remains the live, steerable view.
   */
  async function openAgentSwitcher(targetCtx: ExtensionCommandContext): Promise<boolean> {
    if (targetCtx.mode !== "tui" || !targetCtx.hasUI) {
      ignoreStaleExtensionCtx(() =>
        targetCtx.ui.notify("/agents requires Pi's interactive TUI.", "warning"),
      );
      return false;
    }
    ensureTaskWidget(targetCtx);
    const sessionManager = targetCtx.sessionManager;
    const sessionEntries =
      typeof sessionManager?.getBranch === "function" ? sessionManager.getBranch() : [];
    const sessionHeader =
      typeof sessionManager?.getHeader === "function" ? sessionManager.getHeader() : null;
    const viewLink = findTaskTranscriptViewLink(sessionEntries, sessionHeader);
    if (hasTaskTranscriptViewMarker(sessionEntries) && !viewLink) {
      ignoreStaleExtensionCtx(() =>
        targetCtx.ui.notify(
          "This transcript snapshot has a missing or invalid parent Pi session; /agents cannot switch safely.",
          "warning",
        ),
      );
      return false;
    }
    const interruptedOverlayId = panelState.viewTaskId;
    agentsCommandContext = targetCtx;
    agentsParentSessionPath = viewLink?.parentSessionPath;
    agentsParentSessionId = viewLink?.parentSessionId;
    switcherRestoreOverlayId = interruptedOverlayId;
    switcherShownId = interruptedOverlayId ?? viewLink?.taskId ?? null;
    agentsSwitcher = true;

    // The inline picker needs OUR panel editor for keyboard input; when
    // another extension owns a custom editor the panel is display-only, so
    // use the capturing modal while preserving the current view on cancel.
    if (!panelEditorInstalled) {
      return showOverlay(targetCtx, "agents");
    }

    // The transcript overlay owns the screen, so close it to reveal the panel.
    // A native transcript session has no overlay to close and remains active
    // when the picker is cancelled.
    if (interruptedOverlayId !== null) closeView();
    taskMonitorVisible = true;
    const rows = orderPanelRows(allRows(), now(), true);
    const shown = switcherShownId;
    const idx = shown ? rows.findIndex((r) => r.id === shown) + 1 : 0;
    panelState = {
      ...panelState,
      selection: selectAt(rows, Math.max(0, idx)),
      switcherMode: true,
    };
    requestRender();
    return true;
  }

  function clearTaskWidgetIfIdle(): void {
    pruneFinished();
    if (
      foregroundTasks.size > 0 ||
      backgroundTasks.size > 0 ||
      finishedTasks.size > 0 ||
      isPanelFocused(panelState)
    ) {
      syncAnimationTicker();
      requestRender();
      return;
    }
    stopAnimationTicker();
    if (taskWidgetInstalled) {
      const ctx = widgetCtx;
      if (ctx && typeof ctx.ui.setWidget === "function") {
        ignoreStaleExtensionCtx(() => ctx.ui.setWidget("task", undefined));
      }
      widgetCtx = null;
      taskWidgetInstalled = false;
    }
    requestWidgetRender = null;
  }

  function dispose(): void {
    stopAnimationTicker();
    closeView();
    if (taskWidgetInstalled) {
      const ctx = widgetCtx;
      if (ctx && typeof ctx.ui.setWidget === "function") {
        ignoreStaleExtensionCtx(() => ctx.ui.setWidget("task", undefined));
      }
      widgetCtx = null;
      taskWidgetInstalled = false;
    } else {
      widgetCtx = null;
    }
    widgetTheme = null;
    requestWidgetRender = null;
    finishedTasks.clear();
    liveTranscripts.clear();
    sessionMetaCache.clear();
  }

  return {
    ensureTaskWidget,
    ensurePanelEditor: installEditor,
    openOverlay,
    openAgentSwitcher,
    toggleTaskMonitor,
    openTaskView,
    closeTaskView,
    setLiveTranscript,
    requestRender,
    clearTaskWidgetIfIdle,
    getContext,
    noteTaskFinished,
    dispose,
  };
}