import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AssistantMessageComponent,
  initTheme,
  SessionManager,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { createTaskWidgetController } from "../src/lifecycle/widget.js";
import { DurableTranscript } from "../src/panel/durable-transcript.js";
import { TaskTranscriptOverlay } from "../src/panel/task-transcript-overlay.js";
import { createTaskTranscriptPane } from "../src/panel/task-pane.js";
import {
  createTaskTranscriptSessionView,
  findTaskTranscriptViewLink,
  TASK_TRANSCRIPT_VIEW_ENTRY,
} from "../src/panel/task-session-view.js";
import type { TranscriptItem } from "../src/panel/transcript.js";
import type { BackgroundTask } from "../src/types.js";

function makeTask(over: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    agentType: "general",
    sessionName: "task-1",
    originalPane: null,
    description: "run",
    startedAt: 1000,
    toolUses: 0,
    turns: 0,
    recentCalls: [],
    dir: "/tmp/art",
    status: "running",
    ...over,
  };
}

function createTuiContext() {
  let widgetFactory: ((tui: unknown, theme: unknown) => {
    render(width: number): string[];
    dispose?(): void;
  }) | undefined;
  let editorInstalled = false;
  const setWidgetCalls: Array<{ key: string; value: unknown; placement?: string }> = [];
  const customCalls: Array<{
    factory: (
      tui: unknown,
      theme: unknown,
      keybindings: unknown,
      done: (result?: unknown) => void,
    ) => { render(width: number): string[] };
    options?: { overlay?: boolean; overlayOptions?: Record<string, unknown> };
    resolved: boolean;
  }> = [];
  const ui: any = {
    setWidget(key: string, value: unknown, options?: { placement?: string }) {
      setWidgetCalls.push({ key, value, placement: options?.placement });
      if (typeof value === "function") widgetFactory = value as never;
      else if (value === undefined) widgetFactory = undefined;
    },
    getEditorComponent: () => undefined,
    setEditorComponent: () => {
      editorInstalled = true;
    },
    notify: () => {},
    custom(
      factory: (typeof customCalls)[number]["factory"],
      options?: (typeof customCalls)[number]["options"],
    ): Promise<unknown> {
      const call: (typeof customCalls)[number] = { factory, options, resolved: false };
      customCalls.push(call);
      return new Promise((resolve) => {
        (call as unknown as { resolve: (r?: unknown) => void }).resolve = () => {
          call.resolved = true;
          resolve(undefined);
        };
      });
    },
  };
  const fakeTui = { terminal: { rows: 40 }, requestRender: () => {} };
  const mountOverlay = (theme: unknown = null) => {
    const last = customCalls.at(-1);
    assert.ok(last, "expected an open overlay");
    return last.factory(fakeTui, theme, {}, () => {
      (last as unknown as { resolve?: (r?: unknown) => void }).resolve?.();
    });
  };
  return {
    context: {
      mode: "tui",
      hasUI: true,
      cwd: "/tmp",
      ui,
      sessionManager: undefined,
    } as any,
    getFactory: () => widgetFactory,
    editorInstalled: () => editorInstalled,
    setWidgetCalls,
    customCalls,
    mountOverlay,
  };
}

function createEditorTuiContext() {
  type Editor = { handleInput(data: string): void };
  type EditorFactory = (tui: any, theme: any, keybindings: any) => Editor;
  type WidgetFactory = (tui: any, theme: any) => { render(width: number): string[] };
  let editorFactory: EditorFactory | undefined;
  let widgetFactory: WidgetFactory | undefined;
  const notices: Array<{ message: string; level: string }> = [];
  const customCalls: Array<{
    factory: (
      tui: unknown,
      theme: unknown,
      keybindings: unknown,
      done: (result?: unknown) => void,
    ) => { render(width: number): string[] };
    options?: { overlay?: boolean; overlayOptions?: Record<string, unknown> };
  }> = [];
  const context = {
    mode: "tui",
    hasUI: true,
    cwd: "/tmp",
    ui: {
      setWidget: (_name: string, value: unknown) => {
        if (typeof value === "function") widgetFactory = value as WidgetFactory;
      },
      getEditorComponent: () => undefined,
      setEditorComponent: (factory: EditorFactory) => { editorFactory = factory; },
      notify: (message: string, level: string) => notices.push({ message, level }),
      custom: (
        factory: (typeof customCalls)[number]["factory"],
        options?: (typeof customCalls)[number]["options"],
      ) => {
        customCalls.push({ factory, options });
        return new Promise<unknown>(() => {});
      },
    },
  } as any;
  const tui = { requestRender: () => {}, terminal: { rows: 40 } };
  const mountOverlay = (theme: unknown = null) => {
    const last = customCalls.at(-1);
    assert.ok(last, "expected an open overlay");
    return last.factory(tui, theme, {}, () => {});
  };
  return {
    context,
    createEditor: () => editorFactory?.(
      tui,
      { borderColor: (text: string) => text },
      { matches: () => false },
    ),
    createWidget: () => widgetFactory?.(tui, { fg: (_style: string, text: string) => text }),
    notices,
    customCalls,
    mountOverlay,
  };
}

test("resuming an ID suppresses its retained finished row", () => {
  const taskId = "t-resumed-row";
  const active = makeTask({
    backend: "durable",
    durableAbortController: new AbortController(),
    description: "resumed work",
  });
  const { context, createWidget } = createEditorTuiContext();
  const controller = createTaskWidgetController(new Map(), new Map([[taskId, active]]));
  controller.noteTaskFinished(taskId, makeTask({ status: "done", description: "old completion" }));
  controller.ensureTaskWidget(context);

  const widget = createWidget();
  const lines = widget?.render(120).join("\n") ?? "";

  assert.match(lines, /t-resumed-row/);
  assert.doesNotMatch(lines, /old completion/);
  controller.openTaskView(taskId);
  const focusedLines = widget?.render(120).join("\n") ?? "";
  assert.equal(focusedLines, "", "the transcript overlay owns the screen while viewing");
  controller.closeTaskView(taskId);
  const afterLines = widget?.render(120).join("\n") ?? "";
  assert.match(afterLines, /t-resumed-row/, "the resumed row returns after closing (retained, not expired)");
  controller.dispose();
});

test("expiring a previous finished row preserves a resumed task's live transcript", () => {
  const taskId = "t-resumed-transcript";
  let clock = 100_000;
  const active = makeTask({ backend: "durable" });
  const { context, getFactory, mountOverlay } = createTuiContext();
  const controller = createTaskWidgetController(new Map(), new Map([[taskId, active]]), {
    now: () => clock,
  });
  controller.noteTaskFinished(
    taskId,
    makeTask({ status: "done", description: "old completion" }),
    clock,
  );
  controller.setLiveTranscript(taskId, [
    { type: "assistant", text: "The resumed run is still active.", timestamp: "" },
  ]);
  controller.ensureTaskWidget(context);
  clock += 6_000;
  getFactory()!({ requestRender: () => {}, terminal: { rows: 40 } }, null).render(120);

  controller.openTaskView(taskId);
  const overlay = mountOverlay({ fg: (_style: string, text: string) => text });
  const view = overlay.render(80).join("\n");

  assert.match(view, /The resumed run is still active/);
  controller.dispose();
});

test("stopping a resumed ID cancels its active runner instead of dismissing history", () => {
  const taskId = "t-resumed-stop";
  const abortController = new AbortController();
  const active = makeTask({ backend: "durable", durableAbortController: abortController });
  const { context, createEditor } = createEditorTuiContext();
  const controller = createTaskWidgetController(new Map(), new Map([[taskId, active]]));
  controller.noteTaskFinished(taskId, makeTask({ status: "done", description: "old completion" }));
  controller.ensureTaskWidget(context);
  const editor = createEditor();
  assert.ok(editor);

  editor.handleInput("\x1b[B");
  editor.handleInput("\x1b[B");
  editor.handleInput("x");

  assert.equal(abortController.signal.aborted, true);
  controller.dispose();
});

test("task widget installs the editor wrapper when no other extension owns one", () => {
  const { context, editorInstalled } = createTuiContext();
  const controller = createTaskWidgetController(new Map(), new Map());
  controller.ensureTaskWidget(context);
  assert.equal(editorInstalled(), true, "panel editor should be installed");
  controller.dispose();
});

test("task widget is placed below the editor", () => {
  const { context, setWidgetCalls } = createTuiContext();
  const controller = createTaskWidgetController(new Map(), new Map());
  controller.ensureTaskWidget(context);
  const taskCall = setWidgetCalls.find((c) => c.key === "task");
  assert.equal(taskCall?.placement, "belowEditor");
  controller.dispose();
});

test("durable live transcript is shown in the task view and summarized in its row", () => {
  const task = makeTask({ backend: "durable" });
  const background = new Map([["t-durable", task]]);
  const { context, setWidgetCalls, customCalls, getFactory, mountOverlay } = createTuiContext();
  const controller = createTaskWidgetController(new Map(), background);
  controller.ensureTaskWidget(context);
  controller.setLiveTranscript("t-durable", [
    { type: "user", text: "Research this topic.", timestamp: "" },
    { type: "assistant", text: "I am checking sources.", timestamp: "" },
    {
      type: "tool",
      name: "websearch",
      toolCallId: "call-search",
      args: { query: "Pi Durable" },
      timestamp: "",
      inProgress: true,
    },
  ]);

  assert.equal(task.toolUses, 1, "tool count follows the durable event transcript");
  assert.equal(task.recentCalls[0]?.name, "websearch");
  assert.equal(task.recentCalls[0]?.status, "in_progress");
  const compactWidget = getFactory()!(
    { terminal: { rows: 40 }, requestRender: () => {} },
    null,
  );
  const compactRow = compactWidget.render(120).join("\\n");
  assert.match(compactRow, /1 tool/);
  assert.match(compactRow, /websearch/);
  controller.openTaskView("t-durable");
  initTheme();
  const pane = mountOverlay({ fg: (_style: string, text: string) => text });
  const view = pane.render(80).join("\\n");
  assert.match(view, /Research this topic/);
  assert.match(view, /I am checking sources/);
  assert.match(view, /websearch/);
  controller.setLiveTranscript("t-durable", [
    { type: "user", text: "Research this topic.", timestamp: "" },
    { type: "assistant", text: "I found two useful sources.", timestamp: "" },
    {
      type: "tool",
      name: "websearch",
      toolCallId: "call-search",
      args: { query: "Pi Durable" },
      result: "Two pages found.",
      timestamp: "",
      inProgress: false,
    },
  ]);
  const updatedView = pane.render(80).join("\\n");
  assert.match(updatedView, /I found two useful sources/, "the open pane follows event updates");
  assert.ok(setWidgetCalls.every((call) => call.key !== "task-transcript"));
  assert.equal(customCalls.length, 1, "the live view is one overlay");
  assert.equal(customCalls[0]?.options?.overlay, true);

  const longTranscript: TranscriptItem[] = [];
  for (let index = 0; index < 205; index++) {
    longTranscript.push({ type: "assistant", text: `Turn ${index}`, timestamp: "" });
    longTranscript.push({
      type: "tool",
      name: "read",
      toolCallId: `call-${index}`,
      args: {},
      timestamp: "",
      inProgress: false,
    });
  }
  controller.setLiveTranscript("t-durable", longTranscript, 205);
  assert.equal(task.toolUses, 205, "the activity count stays cumulative when transcript rows are capped");
  assert.equal(task.recentCalls.length, 10, "the recent activity list remains bounded");
  controller.dispose();
});

test("task transcript pane finalizes completed tools with empty output", () => {
  initTheme();
  const originalUpdateResult = ToolExecutionComponent.prototype.updateResult;
  let finalizedResult: Parameters<typeof originalUpdateResult>[0] | undefined;
  let isPartial: boolean | undefined;
  ToolExecutionComponent.prototype.updateResult = function (result, partial) {
    finalizedResult = result;
    isPartial = partial;
    return originalUpdateResult.call(this, result, partial);
  };

  const pane = createTaskTranscriptPane(
    { terminal: { rows: 40 }, requestRender: () => {} } as never,
    { fg: (_style: string, text: string) => text } as never,
    {
      taskId: "t-empty-result",
      cwd: "/tmp",
      sig: () => "stable",
      read: () => [{
        type: "tool",
        name: "read",
        toolCallId: "call-empty-result",
        args: {},
        timestamp: "",
        inProgress: false,
      }],
    },
  );

  try {
    pane.render(80);
    assert.deepEqual(finalizedResult?.content, [{ type: "text", text: "" }]);
    assert.equal(finalizedResult?.isError, false);
    assert.equal(isPartial, false);
  } finally {
    pane.dispose();
    ToolExecutionComponent.prototype.updateResult = originalUpdateResult;
  }
});

test("controller opens and closes the selected task transcript view", async () => {
  const foreground = new Map([["t1", makeTask({ backend: "durable" })]]);
  const { context, customCalls, mountOverlay } = createTuiContext();
  const controller = createTaskWidgetController(foreground, new Map());
  controller.ensureTaskWidget(context);

  controller.openTaskView("t1");
  assert.equal(customCalls.length, 1, "the transcript view is a ui.custom overlay");
  assert.equal(customCalls[0]?.options?.overlay, true);
  const overlay = mountOverlay({ fg: (_s: string, t: string) => t });
  assert.ok(typeof overlay.render === "function", "overlay renders the transcript");

  controller.closeTaskView("t1");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(customCalls[0]?.resolved, true, "closing resolves the overlay");
  controller.dispose();
});

test("noteTaskFinished keeps a done row in the idle widget render", () => {
  const foreground = new Map<string, BackgroundTask>();
  const background = new Map<string, BackgroundTask>();
  const controller = createTaskWidgetController(foreground, background);
  const task = makeTask({ status: "done" });
  controller.noteTaskFinished("t1", task, Date.now());
  const { context, getFactory } = createTuiContext();
  controller.ensureTaskWidget(context);
  const widget = getFactory();
  const fakeTui = { requestRender: () => {}, terminal: { rows: 40 } };
  const lines = (widget as never as (t: unknown, th: unknown) => { render(w: number): string[] })(
    fakeTui,
    null,
  ).render(120);
  assert.ok(
    lines.some((l) => l.includes("✓") && l.includes("general")),
    `expected a finished row, got: ${JSON.stringify(lines)}`,
  );
  controller.dispose();
});

test("idle widget still renders active background rows alongside finished ones", () => {
  const foreground = new Map<string, BackgroundTask>();
  const background = new Map<string, BackgroundTask>();
  background.set("t1", makeTask());
  const controller = createTaskWidgetController(foreground, background);
  const { context, getFactory } = createTuiContext();
  controller.ensureTaskWidget(context);
  const widget = getFactory();
  const fakeTui = { requestRender: () => {}, terminal: { rows: 40 } };
  const lines = (widget as never as (t: unknown, th: unknown) => { render(w: number): string[] })(
    fakeTui,
    null,
  ).render(120);
  assert.ok(lines.some((l) => l.includes("general")), "background row rendered");
  controller.dispose();
});
test("ensurePanelEditor installs the editor without registering the task widget", () => {
  const { context, setWidgetCalls, editorInstalled } = createTuiContext();
  const controller = createTaskWidgetController(new Map(), new Map());
  controller.ensurePanelEditor(context);
  assert.equal(editorInstalled(), true);
  assert.equal(
    setWidgetCalls.some((c) => c.key === "task"),
    false,
    "task widget must not be registered by ensurePanelEditor",
  );
  controller.dispose();
});

test("task monitor visibility toggles independently from tracked work", () => {
  const background = new Map([["t1", makeTask()]]);
  const { context, getFactory } = createTuiContext();
  const controller = createTaskWidgetController(new Map(), background);
  controller.ensureTaskWidget(context);
  const render = () =>
    getFactory()!({ terminal: { rows: 40 }, requestRender: () => {} }, null)
      .render(120)
      .join("\n");
  assert.match(render(), /t1/, "monitor is visible by default");

  assert.equal(controller.toggleTaskMonitor(context), false);
  assert.equal(render(), "", "toggle hides monitor content without unregistering it");
  assert.equal(background.has("t1"), true, "hiding does not stop or remove work");

  background.set("t2", makeTask());
  controller.ensureTaskWidget(context);
  assert.equal(render(), "", "new tasks stay hidden until toggled back on");

  assert.equal(controller.toggleTaskMonitor(context), true);
  assert.match(render(), /t1/);
  assert.match(render(), /t2/, "toggle restores all tracked rows");
  controller.dispose();
});

test("hidden task monitor does not allow stopping an invisible row from the editor", async () => {
  const background = new Map([["t-hidden", makeTask()]]);
  const { context, createEditor } = createEditorTuiContext();
  const stopCalls: string[] = [];
  const controller = createTaskWidgetController(new Map(), background, {
    steerTask: () => null,
    stopTask: (taskId) => { stopCalls.push(taskId); return null; },
  });
  controller.ensureTaskWidget(context);
  const editor = createEditor();
  assert.ok(editor);

  controller.toggleTaskMonitor(context);
  editor.handleInput("\x1b[B");
  editor.handleInput("\x1b[B");
  editor.handleInput("x");
  await Promise.resolve();

  assert.deepEqual(stopCalls, []);
  assert.equal(background.has("t-hidden"), true, "hidden navigation must not stop tracked work");
  controller.dispose();
});

test("a finished durable transcript is read-only", () => {
  const finished = makeTask({ backend: "durable", status: "done" });
  const { context, createEditor, notices, mountOverlay } = createEditorTuiContext();
  const steeringCalls: string[] = [];
  const controller = createTaskWidgetController(new Map(), new Map(), {
    steerTask: (_task, taskId) => { steeringCalls.push(taskId); return null; },
    stopTask: () => null,
  });
  controller.noteTaskFinished("t-finished", finished, Date.now());
  controller.ensureTaskWidget(context);
  controller.openTaskView("t-finished");
  const overlay = mountOverlay({ fg: (_style: string, text: string) => text });
  const editor = createEditor();
  assert.ok(editor);

  editor.handleInput("please continue this analysis");
  editor.handleInput("\r");

  assert.deepEqual(steeringCalls, [], "finished transcript input must not submit a new child run");
  assert.match(overlay.render(90).join("\n"), /read-only|no longer running/i);
  assert.deepEqual(notices, [], "finished child-view errors stay out of the parent notification surface");
  overlay.dispose();
  controller.dispose();
});

test("a running durable transcript still accepts steering", () => {
  const running = makeTask({ backend: "durable", status: "running" });
  const { context, createEditor } = createEditorTuiContext();
  const steeringCalls: Array<{ taskId: string; text: string }> = [];
  const controller = createTaskWidgetController(new Map(), new Map([["t-running", running]]), {
    steerTask: (_task, taskId, text) => {
      steeringCalls.push({ taskId, text });
      return null;
    },
    stopTask: () => null,
  });
  controller.ensureTaskWidget(context);
  controller.openTaskView("t-running");
  controller.toggleTaskMonitor(context);
  const editor = createEditor();
  assert.ok(editor);

  editor.handleInput("check this result");
  editor.handleInput("\r");

  assert.deepEqual(steeringCalls, [{ taskId: "t-running", text: "check this result" }]);
  controller.dispose();
});

test("finished rows expire from the idle widget after their linger window", () => {
  let clock = 100_000;
  const controller = createTaskWidgetController(
    new Map(),
    new Map(),
    { steerTask: () => null, stopTask: () => null, now: () => clock },
  );
  const task = makeTask({ status: "done" });
  controller.noteTaskFinished("t1", task, clock);
  const { context, getFactory } = createTuiContext();
  controller.ensureTaskWidget(context);
  const fakeTui = { requestRender: () => {}, terminal: { rows: 40 } };
  const widget = getFactory() as (t: unknown, th: unknown) => { render(w: number): string[] };
  // Within the done linger window the row is visible.
  let lines = widget(fakeTui, null).render(120);
  assert.ok(lines.some((l) => l.includes("✓")), "done row visible during linger");
  // After the linger window a render drops it (the idle widget expires it).
  clock += 6_000;
  lines = widget(fakeTui, null).render(120);
  assert.ok(
    !lines.some((l) => l.includes("✓")),
    "done row must expire after the linger window",
  );
  controller.dispose();
});

test("panel stop awaits async cleanup and suppresses duplicate requests", async () => {
  const foreground = new Map<string, BackgroundTask>([["task-1", makeTask()]]);
  let release!: () => void;
  const cleanupFinished = new Promise<void>((resolve) => {
    release = resolve;
  });
  let cleanupCalls = 0;
  let editorFactory: ((tui: unknown, theme: unknown, keybindings: unknown) => {
    handleInput(data: string): void;
  }) | undefined;
  const context = {
    mode: "tui",
    hasUI: true,
    ui: {
      getEditorComponent: () => undefined,
      setEditorComponent: (factory: typeof editorFactory) => {
        editorFactory = factory;
      },
      notify: () => {},
    },
  } as any;
  const controller = createTaskWidgetController(
    foreground,
    new Map(),
    {
      steerTask: () => null,
      stopTask: async () => {
        cleanupCalls++;
        await cleanupFinished;
        return null;
      },
    },
  );
  controller.ensurePanelEditor(context);
  const editor = editorFactory?.({}, {}, {});
  assert.ok(editor);

  editor.handleInput("\x1b[B");
  editor.handleInput("\x1b[B");
  editor.handleInput("x");
  await Promise.resolve();
  editor.handleInput("x");
  assert.equal(cleanupCalls, 1);

  release();
  await cleanupFinished;
  await Promise.resolve();
  controller.dispose();
});


test("task transcript pane renders tools with pi's compact per-tool renderers", () => {
  initTheme();
  const pane = createTaskTranscriptPane(
    { terminal: { rows: 40 }, requestRender: () => {} } as never,
    { fg: (_style: string, text: string) => text } as never,
    {
      taskId: "t-compact-tools",
      cwd: "/tmp",
      sig: () => "stable",
      read: () => [
        {
          type: "tool",
          name: "bash",
          toolCallId: "call-compact-1",
          args: { command: "rg -n compact src/" },
          timestamp: "",
          inProgress: false,
          result: "src/x.ts:1: compact",
        },
        {
          type: "tool",
          name: "read",
          toolCallId: "call-compact-2",
          args: { path: "src/x.ts" },
          timestamp: "",
          inProgress: false,
          result: "const compact = true;",
        },
      ],
    },
  );

  try {
    const lines = pane.render(100).map((l: string) => l.replace(/\x1b\[[0-9;]*m/g, ""));
    const joined = lines.join("\n");
    assert.match(joined, /\$ rg -n compact src\//, "bash renders its command, shell-style");
    assert.doesNotMatch(joined, /^\{$/m, "no raw pretty-printed args object block");
    assert.ok(lines.some((l) => l.trim().startsWith("read")), "read renders its own header line");
  } finally {
    pane.dispose();
  }
});

test("task transcript pane renders provider reasoning summaries above the answer", () => {
  initTheme();
  const pane = createTaskTranscriptPane(
    { terminal: { rows: 40 }, requestRender: () => {} } as never,
    { fg: (_style: string, text: string) => text } as never,
    {
      taskId: "t-thinking-summary",
      cwd: "/tmp",
      sig: () => "stable",
      read: () => [
        {
          type: "assistant",
          text: "The answer.",
          thinking: "Check the assumptions.\nCompare the alternatives.",
          timestamp: "",
        },
      ],
    },
  );

  try {
    const lines = pane.render(100).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
    const joined = lines.join("\n");
    assert.ok(joined.indexOf("Check the assumptions.") < joined.indexOf("The answer."));
    assert.ok(joined.indexOf("Compare the alternatives.") < joined.indexOf("The answer."));
  } finally {
    pane.dispose();
  }
});

test("transcript overlay can scroll to the oldest line with a multiline editor", () => {
  initTheme();
  const terminalRows = 40;
  const pane = createTaskTranscriptPane(
    { terminal: { rows: terminalRows }, requestRender: () => {} } as never,
    { fg: (_style: string, text: string) => text } as never,
    {
      taskId: "t-scroll-viewport",
      cwd: "/tmp",
      sig: () => "stable",
      read: () =>
        Array.from({ length: 100 }, (_, index) => ({
          type: "assistant" as const,
          text: `LINE_${index}`,
          timestamp: "",
        })),
    },
  );
  const editor = {
    handleInput() {},
    render: () => Array.from({ length: 14 }, (_, index) => `editor line ${index}`),
    getText: () => "",
    setText() {},
  };
  const overlay = new TaskTranscriptOverlay({
    pane,
    host: {
      taskId: "t-scroll-viewport",
      onSteer() {},
      onClose() {},
      requestRender() {},
    },
    theme: {
      fg: (_style: string, text: string) => text,
      bg: (_style: string, text: string) => text,
    },
    editor,
    terminalRows: () => terminalRows,
  });

  try {
    overlay.render(100);
    for (let page = 0; page < 20; page++) overlay.handleInput("\x1b[5~");
    const lines = overlay.render(100).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
    assert.equal(lines.length, terminalRows, "overlay still fills the terminal");
    assert.ok(lines.some((line) => line.includes("LINE_0")), "the pane's oldest line stays reachable");
  } finally {
    overlay.dispose();
  }
});

test("task transcript pane bounds scroll calculations by its available rows", () => {
  initTheme();
  const availableRows = 23;
  const pane = createTaskTranscriptPane(
    { terminal: { rows: 40 }, requestRender: () => {} } as never,
    { fg: (_style: string, text: string) => text } as never,
    {
      taskId: "t-pane-viewport",
      cwd: "/tmp",
      sig: () => "stable",
      read: () =>
        Array.from({ length: 100 }, (_, index) => ({
          type: "assistant" as const,
          text: `LINE_${index}`,
          timestamp: "",
        })),
    },
  );

  try {
    assert.ok(pane.render(100, availableRows).length <= availableRows);
    pane.scrollBy(100_000);
    const oldest = pane.render(100, availableRows).join("\n");
    assert.ok(oldest.includes("LINE_0"), "scroll bounds include the oldest item in this viewport");
  } finally {
    pane.dispose();
  }
});

test("task transcript pane clamps scroll to the transcript bounds", () => {
  initTheme();
  const pane = createTaskTranscriptPane(
    { terminal: { rows: 12 }, requestRender: () => {} } as never,
    { fg: (_style: string, text: string) => text } as never,
    {
      taskId: "t-scroll",
      cwd: "/tmp",
      sig: () => "stable",
      read: () =>
        Array.from({ length: 40 }, (_, i) => ({
          type: "assistant" as const,
          text: `turn ${i}`,
          timestamp: "",
        })),
    },
  );

  try {
    pane.scrollBy(-100); // negative stays at the tail
    let lines = pane.render(80).map((l: string) => l.replace(/\x1b\[[0-9;]*m/g, ""));
    assert.ok(!lines.some((l) => l.includes("pageDown")), "at the tail there is no pageDown hint");
    pane.scrollBy(100_000); // overshoot clamps to the oldest line
    lines = pane.render(80).map((l: string) => l.replace(/\x1b\[[0-9;]*m/g, ""));
    assert.ok(lines.some((l) => l.includes("turn 0")), "clamped view reaches the first turn");
    assert.ok(!lines.some((l) => l.includes("pageUp")), "fully scrolled back has no pageUp hint");
    assert.ok(lines.some((l) => l.includes("pageDown")), "newer lines exist below the clamp");
  } finally {
    pane.dispose();
  }
});

test("task transcript pane re-reads only when the signature changes", () => {
  initTheme();
  let sig = "v1";
  let reads = 0;
  const pane = createTaskTranscriptPane(
    { terminal: { rows: 40 }, requestRender: () => {} } as never,
    { fg: (_style: string, text: string) => text } as never,
    {
      taskId: "t-sig",
      cwd: "/tmp",
      sig: () => sig,
      read: () => {
        reads += 1;
        return [{ type: "assistant" as const, text: `payload ${sig}`, timestamp: "" }];
      },
    },
  );

  try {
    pane.render(80);
    pane.render(80);
    assert.equal(reads, 1, "unchanged signature uses the cache");
    sig = "v2";
    const lines = pane.render(80).map((l: string) => l.replace(/\x1b\[[0-9;]*m/g, ""));
    assert.equal(reads, 2, "changed signature re-reads");
    assert.ok(lines.some((l) => l.includes("payload v2")), "new payload rendered");
  } finally {
    pane.dispose();
  }
});

test("transcript overlay hides the below-editor task panel while viewing", () => {
  initTheme();
  const foreground = new Map([["t-view", makeTask({ description: "viewable work" })]]);
  const { context, getFactory, mountOverlay } = createTuiContext();
  const controller = createTaskWidgetController(foreground, new Map());
  controller.ensureTaskWidget(context);

  const before = getFactory()!({ terminal: { rows: 40 }, requestRender: () => {} }, null);
  assert.match(before.render(120).join("\n"), /viewable work/, "rows visible before viewing");

  controller.openTaskView("t-view");
  mountOverlay();
  const during = getFactory()!({ terminal: { rows: 40 }, requestRender: () => {} }, null);
  assert.equal(
    during.render(120).join("\n"),
    "",
    "the overlay owns the screen: the below-editor panel is hidden",
  );

  controller.closeTaskView("t-view");
  const after = getFactory()!({ terminal: { rows: 40 }, requestRender: () => {} }, null);
  assert.match(after.render(120).join("\n"), /viewable work/, "rows return after closing");
  controller.dispose();
});

test("child panel footer shows the child's recorded model, thinking, and cwd", () => {
  initTheme();
  const root = mkdtempSync(join(tmpdir(), "pi-task-child-meta-"));
  try {
    const sessionsDir = join(root, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const sessionFile = join(sessionsDir, "2026-01-01T00-00-00-000Z_a.jsonl");
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "model_change",
          provider: "anthropic",
          modelId: "claude-sonnet-4",
          timestamp: "2026-01-01T00:00:00.000Z",
        }),
        JSON.stringify({
          type: "thinking_level_change",
          thinkingLevel: "medium",
          timestamp: "2026-01-01T00:00:00.000Z",
        }),
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "session body" }] },
          timestamp: "",
        }),
      ].join("\n"),
    );
    const task = makeTask({
      backend: "sdk",
      dir: join(root, "artifacts"),
      sessionPath: sessionFile,
      sessionName: "task-meta",
      cwd: join(root, "child-cwd"),
      status: undefined,
    });
    const { context, mountOverlay } = createTuiContext();
    const controller = createTaskWidgetController(new Map(), new Map([["t-meta", task]]));
    controller.ensureTaskWidget(context);
    controller.openTaskView("t-meta");
    const overlay = mountOverlay({ fg: (_style: string, text: string) => text });
    initTheme();

    try {
      const view = overlay.render(140).join("\n");
      assert.match(view, /#t-meta/, "the footer names the child");
      assert.match(view, /claude-sonnet-4/, "the session's recorded model is shown");
      assert.match(view, /thinking medium/, "the session's recorded thinking level is shown");
      assert.match(view, /child-cwd/, "the child's cwd is shown");
      assert.match(view, /esc back/, "key hints stay in the footer");
    } finally {
      controller.dispose();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("child panel footer prefers the live durable agent state over session metadata", () => {
  initTheme();
  const task = makeTask({ backend: "durable", cwd: "/tmp/child-cwd" });
  const { context, mountOverlay } = createTuiContext();
  const controller = createTaskWidgetController(new Map([["t-durable-meta", task]]), new Map());
  controller.ensureTaskWidget(context);
  controller.setLiveTranscript("t-durable-meta", [
    { type: "user", text: "do the thing", timestamp: "" },
  ], 2, { model: "opencode-go/deepseek-flash", thinkingLevel: "high", cwd: "/tmp/child-cwd" });
  controller.openTaskView("t-durable-meta");
  const overlay = mountOverlay({ fg: (_style: string, text: string) => text });
  initTheme();

  try {
    const view = overlay.render(140).join("\n");
    assert.match(view, /deepseek-flash/, "the live agent state's model is shown");
    assert.match(view, /thinking high/, "the live agent state's thinking level is shown");
    assert.match(view, /child-cwd/, "the live agent state's cwd is shown");

    // A watch-error update carries no agent state: the last one we saw stays.
    controller.setLiveTranscript(
      "t-durable-meta",
      [{ type: "system", text: "live updates unavailable", timestamp: "" }],
      2,
    );
    const afterWatchError = overlay.render(140).join("\n");
    assert.match(afterWatchError, /deepseek-flash/, "the model survives an update without agent state");
    assert.match(afterWatchError, /thinking high/, "the thinking level survives too");
  } finally {
    controller.dispose();
  }
});

test("child panel footer shows the failover model, not the stale primary", () => {
  initTheme();
  const task = makeTask({ backend: "durable", cwd: "/tmp/child-cwd" });
  const { context, mountOverlay } = createTuiContext();
  const controller = createTaskWidgetController(new Map([["t-failover-footer", task]]), new Map());
  controller.ensureTaskWidget(context);

  const transcript = new DurableTranscript({
    type: "snapshot",
    entries: [],
    tools: [],
    compactions: [],
    inbox: [],
    agent: {
      model: { provider: "openai-codex", modelId: "gpt-6-luna" },
      thinkingLevel: "max",
    },
    usage: {
      models: {},
      tools: {},
      totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costTotal: 0 },
    },
  } as never);
  // A failover configure commit reaches the live view as an agent_changed event.
  transcript.apply([{
    type: "agent_changed",
    agent: {
      model: { provider: "opencode-go", modelId: "deepseek-flash" },
      thinkingLevel: "max",
    },
  } as never]);
  controller.setLiveTranscript(
    "t-failover-footer",
    transcript.items(),
    0,
    transcript.agentState(),
  );
  controller.openTaskView("t-failover-footer");
  const overlay = mountOverlay({ fg: (_style: string, text: string) => text });
  initTheme();

  try {
    const view = overlay.render(140).join("\n");
    assert.match(view, /deepseek-flash/, "the footer shows the model actually running");
    assert.doesNotMatch(view, /gpt-6-luna/, "the stale primary model is gone");
    assert.match(view, /thinking max/, "the fallback model's thinking level is shown");
  } finally {
    controller.dispose();
  }
});

test("sdk transcript reads the captured session file and streams growth", () => {
  initTheme();
  const root = mkdtempSync(join(tmpdir(), "pi-task-sdk-transcript-"));
  try {
    const sessionsDir = join(root, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const sessionFile = join(sessionsDir, "2026-01-01T00-00-00-000Z_a.jsonl");
    writeFileSync(
      sessionFile,
      `${JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "live session body" }] },
        timestamp: "",
      })}\n`,
    );
    const task = makeTask({
      backend: "sdk",
      dir: join(root, "artifacts"), // wrong dir on purpose: the live read must use sessionPath
      sessionPath: sessionFile,
      sessionName: "task-live",
    });
    const { context, mountOverlay } = createTuiContext();
    const controller = createTaskWidgetController(new Map(), new Map([["t-live", task]]));
    controller.ensureTaskWidget(context);
    controller.openTaskView("t-live");
    const overlay = mountOverlay({ fg: (_style: string, text: string) => text });
    initTheme();

    const view = overlay.render(100).join("\n");
    assert.match(view, /live session body/, "the captured session file is the live source");

    // Appending to the JSONL (signature change) streams into the open view.
    appendFileSync(
      sessionFile,
      `${JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "streamed growth" }] },
        timestamp: "",
      })}\n`,
    );
    const updated = overlay.render(100).join("\n");
    assert.match(updated, /streamed growth/, "growth streams into the open view");
    controller.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task transcript snapshot is a native Pi session linked back to its parent", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-session-view-"));
  try {
    const parent = SessionManager.create(root, join(root, "parent-sessions"));
    parent.appendMessage({ role: "user", content: "parent transcript", timestamp: 1 });
    const parentPath = parent.getSessionFile();
    const parentSessionId = parent.getHeader()?.id;
    assert.ok(parentPath);
    assert.ok(parentSessionId);

    const result = createTaskTranscriptSessionView({
      taskId: "t-native-view",
      cwd: root,
      sessionDir: join(root, "child-views"),
      parentSessionPath: parentPath,
      parentSessionId,
      model: { api: "openai-completions", provider: "openai", model: "gpt-5.6" },
      items: [
        { type: "user", text: "child prompt", timestamp: "" },
        {
          type: "assistant",
          text: "safe \x1b]52;c;payload\x07child answer",
          thinking: "child reasoning\x1b]0;title\x07",
          timestamp: "",
        },
        {
          type: "tool",
          name: "read",
          toolCallId: "call-child-read",
          args: { path: "src/\x1b]52;c;argument\x07index.ts" },
          result: "export {};\x1b]52;c;result\x07",
          timestamp: "",
        },
        { type: "system", text: "child failed\x1b]0;error\x07", timestamp: "" },
      ],
    });
    assert.ok(result.ok);
    const view = SessionManager.open(result.sessionPath);
    const entries = view.getBranch();
    const messages = entries
      .filter((entry) => entry.type === "message")
      .map((entry) => entry.message);

    assert.equal(view.getHeader()?.parentSession, parentPath);
    assert.deepEqual(
      findTaskTranscriptViewLink(entries, view.getHeader()),
      { taskId: "t-native-view", parentSessionPath: parentPath, parentSessionId },
    );
    assert.deepEqual(messages.map((message) => message.role), [
      "user",
      "assistant",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    assert.ok(
      messages.some(
        (message) =>
          message.role === "assistant" &&
          message.content.some(
            (block) => block.type === "thinking" && block.thinking === "child reasoning",
          ),
      ),
      "provider thinking is retained as a native assistant block",
    );
    const serializedMessages = JSON.stringify(messages);
    assert.ok(serializedMessages.includes("child answer"));
    assert.ok(!serializedMessages.includes("\\u001b"), "terminal control sequences are stripped");
    assert.ok(
      messages.some(
        (message) =>
          message.role === "assistant" &&
          message.content.some(
            (block) =>
              block.type === "toolCall" &&
              block.id === "call-child-read" &&
              block.name === "read",
          ),
      ),
      "tool calls use Pi's native assistant/tool-result message shape",
    );
    const firstMessage = entries.find((entry) => entry.type === "message");
    assert.ok(firstMessage);
    view.branch(firstMessage.id);
    assert.deepEqual(
      findTaskTranscriptViewLink(view.getBranch(), view.getHeader()),
      { taskId: "t-native-view", parentSessionPath: parentPath, parentSessionId },
      "the parent link remains available after branching the snapshot",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("empty transcript snapshots return a typed error", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-empty-view-"));
  try {
    const parent = SessionManager.create(root, join(root, "parent-sessions"));
    parent.appendMessage({ role: "user", content: "parent transcript", timestamp: 1 });
    const parentPath = parent.getSessionFile();
    const parentSessionId = parent.getHeader()?.id;
    assert.ok(parentPath);
    assert.ok(parentSessionId);
    const result = createTaskTranscriptSessionView({
      taskId: "t-empty-view",
      cwd: root,
      sessionDir: join(root, "empty-views"),
      parentSessionPath: parentPath,
      parentSessionId,
      model: { api: "openai-completions", provider: "openai", model: "gpt-5.6" },
      items: [],
    });
    assert.deepEqual(result, { ok: false, error: { kind: "empty-transcript" } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agents opens child selections as overlays without replacing the session", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-agents-session-"));
  try {
    const parent = SessionManager.create(root, join(root, "parent-sessions"));
    parent.appendMessage({ role: "user", content: "parent transcript", timestamp: 1 });
    const parentPath = parent.getSessionFile();
    const parentSessionId = parent.getHeader()?.id;
    assert.ok(parentPath);
    assert.ok(parentSessionId);

    const { context, createEditor, notices, mountOverlay } = createEditorTuiContext();
    const switchedPaths: string[] = [];
    Object.assign(context, {
      cwd: root,
      sessionManager: parent,
      model: { api: "openai-completions", provider: "openai", id: "gpt-5.6" },
      switchSession: async (
        sessionPath: string,
        options?: { withSession?: (next: unknown) => Promise<void> },
      ) => {
        switchedPaths.push(sessionPath);
        await options?.withSession?.({
          ui: { notify: (message: string, level: string) => notices.push({ message, level }) },
        });
        return { cancelled: false };
      },
    });

    const taskAId = "t-native-view-a";
    const taskBId = "t-native-view-b";
    const taskA = makeTask({ backend: "durable", cwd: root, dir: root, startedAt: 1000, ownerSessionId: parentSessionId });
    const taskB = makeTask({ backend: "durable", cwd: root, dir: root, startedAt: 2000, ownerSessionId: parentSessionId });
    const controller = createTaskWidgetController(
      new Map(),
      new Map([[taskAId, taskA], [taskBId, taskB]]),
    );
    for (const taskId of [taskAId, taskBId]) {
      controller.setLiveTranscript(taskId, [
        { type: "user", text: `${taskId} prompt`, timestamp: "" },
        { type: "assistant", text: `${taskId} answer`, thinking: "child reasoning", timestamp: "" },
      ]);
    }
    controller.ensureTaskWidget(context);

    await controller.openAgentSwitcher(context);
    const parentEditor = createEditor();
    assert.ok(parentEditor);
    parentEditor.handleInput("\x1b[B");
    parentEditor.handleInput("\r");
    await Promise.resolve();

    assert.deepEqual(switchedPaths, [], "child selection opens an overlay instead of replacing the Pi session");
    const viewA = mountOverlay({ fg: (_style: string, text: string) => text }).render(100).join("\n");
    assert.match(viewA, /t-native-view-a answer/, "the selected child opens as a live steerable transcript");

    await controller.openAgentSwitcher(context);
    const secondPicker = createEditor();
    assert.ok(secondPicker);
    secondPicker.handleInput("\x1b[B");
    secondPicker.handleInput("\x1b[B");
    secondPicker.handleInput("\r");
    await Promise.resolve();

    assert.deepEqual(switchedPaths, [], "the second child selection also stays on the overlay path");
    const viewB = mountOverlay({ fg: (_style: string, text: string) => text }).render(100).join("\n");
    assert.match(viewB, /t-native-view-b answer/, "the second child opens its own transcript");
    controller.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const invalidParent of ["deleted", "malformed"] as const) {
  test(`agents keeps opening live children when the parent session is ${invalidParent}`, async () => {
    const root = mkdtempSync(join(tmpdir(), `pi-task-${invalidParent}-parent-`));
    try {
      const parent = SessionManager.create(root, join(root, "parent-sessions"));
      parent.appendMessage({ role: "user", content: "parent transcript", timestamp: 1 });
      const parentPath = parent.getSessionFile();
      assert.ok(parentPath);
      if (invalidParent === "deleted") rmSync(parentPath);
      else writeFileSync(parentPath, "not a Pi session\n");

      const { context, createEditor, notices, mountOverlay } = createEditorTuiContext();
      const switchedPaths: string[] = [];
      Object.assign(context, {
        cwd: root,
        sessionManager: parent,
        model: { api: "openai-completions", provider: "openai", id: "gpt-5.6" },
        switchSession: async (sessionPath: string) => {
          switchedPaths.push(sessionPath);
          return { cancelled: false };
        },
      });
      const taskId = `t-${invalidParent}-parent`;
      const ownerSessionId = parent.getHeader()?.id;
      assert.ok(ownerSessionId);
      const controller = createTaskWidgetController(
        new Map(),
        new Map([[taskId, makeTask({ backend: "durable", cwd: root, dir: root, ownerSessionId })]]),
      );
      controller.setLiveTranscript(taskId, [
        { type: "user", text: "child prompt", timestamp: "" },
        { type: "assistant", text: "child answer", timestamp: "" },
      ]);
      controller.ensureTaskWidget(context);
      await controller.openAgentSwitcher(context);
      const editor = createEditor();
      assert.ok(editor);
      editor.handleInput("\x1b[B");
      editor.handleInput("\r");
      await Promise.resolve();

      assert.deepEqual(switchedPaths, [], "invalid parent paths are never passed to Pi's switch API");
      const view = mountOverlay({ fg: (_style: string, text: string) => text }).render(80).join("\n");
      assert.match(view, /child answer/, "live children open as overlays without needing the parent file");
      assert.ok(!notices.some((notice) => notice.level === "error"));
      controller.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const malformedParent of [
  "missing-version",
  "incomplete-user-message",
  "incomplete-assistant-message",
  "malformed-trailing-entry",
] as const) {
  test(`agents refuses a ${malformedParent} parent without rewriting it`, async () => {
    const root = mkdtempSync(join(tmpdir(), `pi-task-${malformedParent}-return-`));
    try {
      const parent = SessionManager.create(root, join(root, "parent-sessions"));
      parent.appendMessage({ role: "user", content: "seed message", timestamp: 1 });
      const parentPath = parent.getSessionFile();
      const parentSessionId = parent.getHeader()?.id;
      assert.ok(parentPath);
      assert.ok(parentSessionId);
      const headerLine = readFileSync(parentPath, "utf8").split("\n")[0];
      assert.ok(headerLine);
      const header: Record<string, unknown> = JSON.parse(headerLine);
      if (malformedParent === "missing-version") delete header.version;
      const parentEntries: unknown[] = [];
      if (malformedParent === "incomplete-assistant-message") {
        parentEntries.push({
          type: "message",
          id: "malformed-assistant-message",
          parentId: null,
          timestamp: new Date().toISOString(),
          message: {
            role: "assistant",
            content: [null],
            api: "openai-completions",
            provider: "openai",
            model: "gpt-5.6",
            usage: {},
            stopReason: "stop",
            timestamp: 1,
          },
        });
      } else if (malformedParent === "malformed-trailing-entry") {
        parentEntries.push({
          type: "message",
          id: "valid-user-message",
          parentId: null,
          timestamp: new Date().toISOString(),
          message: { role: "user", content: "valid prefix", timestamp: 1 },
        });
      } else {
        parentEntries.push({
          type: "message",
          id: "malformed-user-message",
          parentId: null,
          timestamp: new Date().toISOString(),
          message: { role: "user" },
        });
      }
      writeFileSync(
        parentPath,
        `${JSON.stringify(header)}\n${parentEntries.map((entry) => JSON.stringify(entry)).join("\n")}${
          malformedParent === "malformed-trailing-entry" ? "\nnot-json" : ""
        }\n`,
      );
      const originalParentBytes = readFileSync(parentPath);

      const snapshot = SessionManager.create(root, join(root, "snapshot-sessions"), {
        parentSession: parentPath,
      });
      const snapshotId = snapshot.getHeader()?.id;
      assert.ok(snapshotId);
      snapshot.appendCustomEntry(TASK_TRANSCRIPT_VIEW_ENTRY, {
        taskId: "malformed-parent-task",
        sessionId: snapshotId,
        parentSessionPath: parentPath,
        parentSessionId,
      });
      snapshot.appendMessage({ role: "user", content: "child transcript", timestamp: 2 });
      const snapshotPath = snapshot.getSessionFile();
      assert.ok(snapshotPath);
      const childView = SessionManager.open(snapshotPath);

      const { context, createEditor, notices } = createEditorTuiContext();
      const switchedPaths: string[] = [];
      Object.assign(context, {
        cwd: root,
        sessionManager: childView,
        switchSession: async (sessionPath: string) => {
          switchedPaths.push(sessionPath);
          SessionManager.open(sessionPath);
          return { cancelled: false };
        },
      });
      const controller = createTaskWidgetController(new Map(), new Map());
      const opened = await controller.openAgentSwitcher(context);
      if (opened) {
        const editor = createEditor();
        assert.ok(editor);
        editor.handleInput("\r");
        await Promise.resolve();
      }

      assert.equal(opened, false, "malformed parent markers cannot open the session switcher");
      assert.deepEqual(switchedPaths, [], "the malformed parent never reaches Pi's switch API");
      assert.deepEqual(readFileSync(parentPath), originalParentBytes);
      assert.ok(notices.some((notice) => notice.level === "warning"));
      controller.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("agents rejects a forged transcript-view marker", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-forged-view-"));
  try {
    const parent = SessionManager.create(root, join(root, "parent-sessions"));
    parent.appendMessage({ role: "user", content: "parent transcript", timestamp: 1 });
    const parentPath = parent.getSessionFile();
    assert.ok(parentPath);
    const alternateParent = SessionManager.create(root, join(root, "alternate-parent-sessions"));
    alternateParent.appendMessage({ role: "user", content: "alternate transcript", timestamp: 2 });
    const alternateParentPath = alternateParent.getSessionFile();
    const alternateParentId = alternateParent.getHeader()?.id;
    assert.ok(alternateParentPath);
    assert.ok(alternateParentId);
    const forged = SessionManager.create(root, join(root, "forged-views"), {
      parentSession: parentPath,
    });
    const forgedSessionId = forged.getHeader()?.id;
    assert.ok(forgedSessionId);
    forged.appendCustomEntry(TASK_TRANSCRIPT_VIEW_ENTRY, {
      taskId: "forged-task",
      sessionId: forgedSessionId,
      parentSessionPath: alternateParentPath,
      parentSessionId: alternateParentId,
    });
    forged.appendMessage({ role: "user", content: "forged snapshot", timestamp: 2 });

    const { context, notices } = createEditorTuiContext();
    const switchedPaths: string[] = [];
    Object.assign(context, {
      cwd: root,
      sessionManager: forged,
      switchSession: async (sessionPath: string) => {
        switchedPaths.push(sessionPath);
        return { cancelled: false };
      },
    });
    const controller = createTaskWidgetController(new Map(), new Map());
    const opened = await controller.openAgentSwitcher(context);

    assert.equal(opened, false, "an unbound marker cannot enable parent-session navigation");
    assert.deepEqual(switchedPaths, []);
    assert.ok(notices.some((notice) => notice.level === "warning"));
    controller.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agents revalidates a snapshot parent immediately before returning", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-deleted-return-parent-"));
  try {
    const parent = SessionManager.create(root, join(root, "parent-sessions"));
    parent.appendMessage({ role: "user", content: "parent transcript", timestamp: 1 });
    const parentPath = parent.getSessionFile();
    const parentSessionId = parent.getHeader()?.id;
    assert.ok(parentPath);
    assert.ok(parentSessionId);
    const snapshot = createTaskTranscriptSessionView({
      taskId: "t-return-validation",
      cwd: root,
      sessionDir: join(root, "snapshot-views"),
      parentSessionPath: parentPath,
      parentSessionId,
      model: { api: "openai-completions", provider: "openai", model: "gpt-5.6" },
      items: [{ type: "user", text: "child prompt", timestamp: "" }],
    });
    assert.ok(snapshot.ok);
    const childView = SessionManager.open(snapshot.sessionPath);
    const { context, createEditor, notices } = createEditorTuiContext();
    const switchedPaths: string[] = [];
    Object.assign(context, {
      cwd: root,
      sessionManager: childView,
      switchSession: async (sessionPath: string) => {
        switchedPaths.push(sessionPath);
        return { cancelled: false };
      },
    });
    const controller = createTaskWidgetController(new Map(), new Map());
    assert.equal(await controller.openAgentSwitcher(context), true);
    rmSync(parentPath);
    const editor = createEditor();
    assert.ok(editor);
    editor.handleInput("\r");
    await Promise.resolve();

    assert.deepEqual(switchedPaths, [], "a parent deleted after picker open is never returned to");
    assert.ok(notices.some((notice) => notice.level === "warning"));
    controller.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agents opens live children read-write overlays even without a saved parent session", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-unsaved-parent-"));
  try {
    const { context, createEditor, mountOverlay } = createEditorTuiContext();
    const switchedPaths: string[] = [];
    Object.assign(context, {
      cwd: root,
      sessionManager: SessionManager.inMemory(root),
      model: { api: "openai-completions", provider: "openai", id: "gpt-5.6" },
      switchSession: async (sessionPath: string) => {
        switchedPaths.push(sessionPath);
        return { cancelled: false };
      },
    });
    const taskId = "t-unsaved-parent";
    const ownerSessionId = context.sessionManager.getHeader()?.id;
    assert.ok(ownerSessionId);
    const controller = createTaskWidgetController(
      new Map(),
      new Map([[taskId, makeTask({ backend: "durable", cwd: root, dir: root, ownerSessionId })]]),
    );
    controller.setLiveTranscript(taskId, [
      { type: "user", text: "child prompt", timestamp: "" },
      { type: "assistant", text: "child answer", timestamp: "" },
    ]);
    controller.ensureTaskWidget(context);
    await controller.openAgentSwitcher(context);
    const editor = createEditor();
    assert.ok(editor);
    editor.handleInput("\x1b[B");
    editor.handleInput("\r");

    assert.deepEqual(switchedPaths, [], "an unsaved parent is never replaced");
    const view = mountOverlay({ fg: (_style: string, text: string) => text }).render(80).join("\n");
    assert.match(view, /child answer/, "the live child still opens as a steerable overlay");
    controller.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agents never writes a snapshot when task state blocks session replacement", async () => {
  initTheme();
  const root = mkdtempSync(join(tmpdir(), "pi-task-blocked-snapshot-"));
  try {
    const sessionDir = join(root, "parent-sessions");
    const parent = SessionManager.create(root, sessionDir);
    parent.appendMessage({ role: "user", content: "parent transcript", timestamp: 1 });
    const parentPath = parent.getSessionFile();
    assert.ok(parentPath);
    const { context, createEditor, notices, mountOverlay } = createEditorTuiContext();
    const switchedPaths: string[] = [];
    Object.assign(context, {
      cwd: root,
      sessionManager: parent,
      model: { api: "openai-completions", provider: "openai", id: "gpt-5.6" },
      switchSession: async (sessionPath: string) => {
        switchedPaths.push(sessionPath);
        return { cancelled: false };
      },
    });
    const taskId = "t-blocked-snapshot";
    const ownerSessionId = parent.getHeader()?.id;
    assert.ok(ownerSessionId);
    const controller = createTaskWidgetController(
      new Map(),
      new Map([[taskId, makeTask({ backend: "durable", cwd: root, dir: root, ownerSessionId })]]),
      {
        steerTask: () => null,
        stopTask: () => null,
      },
    );
    controller.setLiveTranscript(taskId, [
      { type: "user", text: "child prompt", timestamp: "" },
      { type: "assistant", text: "child answer", timestamp: "" },
    ]);
    controller.ensureTaskWidget(context);
    await controller.openAgentSwitcher(context);
    const editor = createEditor();
    assert.ok(editor);
    editor.handleInput("\x1b[B");
    editor.handleInput("\r");
    await Promise.resolve();

    assert.deepEqual(switchedPaths, []);
    assert.equal(
      readdirSync(sessionDir).filter((name) => name.endsWith(".jsonl")).length,
      1,
      "a rejected replacement does not leave an unreachable snapshot file",
    );
    assert.deepEqual(
      notices.filter((notice) => notice.message.includes("snapshot")),
      [],
      "no snapshot fallback messaging is needed because sessions are never replaced",
    );
    const view = mountOverlay({ fg: (_style: string, text: string) => text }).render(80).join("\n");
    assert.match(view, /child answer/, "the selected task opens as a live transcript");
    controller.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const failure of [
  { name: "a synchronous overlay failure", message: "TUI overlay unavailable" },
  {
    name: "a stale-ctx overlay failure",
    message: "This extension ctx is stale after session replacement",
  },
] as const) {
  test(`agents warns when the live overlay fallback hits ${failure.name}`, async () => {
  initTheme();
  const root = mkdtempSync(join(tmpdir(), "pi-task-blocked-no-view-"));
  try {
    const sessionDir = join(root, "parent-sessions");
    const parent = SessionManager.create(root, sessionDir);
    parent.appendMessage({ role: "user", content: "parent transcript", timestamp: 1 });
    const { context, createEditor, notices } = createEditorTuiContext();
    const switchedPaths: string[] = [];
    Object.assign(context, {
      cwd: root,
      sessionManager: parent,
      model: { api: "openai-completions", provider: "openai", id: "gpt-5.6" },
      switchSession: async (sessionPath: string) => {
        switchedPaths.push(sessionPath);
        return { cancelled: false };
      },
    });
    context.ui.custom = () => {
      throw new Error(failure.message);
    };
    const taskId = "t-blocked-no-view";
    const ownerSessionId = parent.getHeader()?.id;
    assert.ok(ownerSessionId);
    const controller = createTaskWidgetController(
      new Map(),
      new Map([[taskId, makeTask({ backend: "durable", cwd: root, dir: root, ownerSessionId })]]),
      {
        steerTask: () => null,
        stopTask: () => null,
      },
    );
    controller.setLiveTranscript(taskId, [
      { type: "user", text: "child prompt", timestamp: "" },
      { type: "assistant", text: "child answer", timestamp: "" },
    ]);
    controller.ensureTaskWidget(context);
    await controller.openAgentSwitcher(context);
    const editor = createEditor();
    assert.ok(editor);
    editor.handleInput("\x1b[B");
    editor.handleInput("\r");
    await Promise.resolve();

    assert.deepEqual(switchedPaths, []);
    assert.ok(
      notices.some(
        (notice) =>
          notice.level === "warning" &&
          notice.message.includes("could not be opened"),
      ),
      "an unrenderable overlay warns instead of claiming the transcript opened",
    );
    controller.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  });
}

test("agents accepts a parent session containing a newer unknown entry kind", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-unknown-entry-"));
  try {
    const sessionDir = join(root, "parent-sessions");
    const parent = SessionManager.create(root, sessionDir);
    parent.appendMessage({ role: "user", content: "parent transcript", timestamp: 1 });
    const parentPath = parent.getSessionFile();
    const parentSessionId = parent.getHeader()?.id;
    assert.ok(parentPath);
    assert.ok(parentSessionId);
    // A future Pi version could append an entry kind this validator has never
    // seen; it must not make an otherwise valid parent unusable.
    appendFileSync(
      parentPath,
      `${JSON.stringify({
        type: "future_entry_kind",
        id: "future-entry",
        parentId: null,
        timestamp: new Date().toISOString(),
        payload: { anything: [1, 2, 3] },
      })}\n`,
    );

    const { context, createEditor, notices, mountOverlay } = createEditorTuiContext();
    const switchedPaths: string[] = [];
    Object.assign(context, {
      cwd: root,
      sessionManager: parent,
      model: { api: "openai-completions", provider: "openai", id: "gpt-5.6" },
      switchSession: async (sessionPath: string) => {
        switchedPaths.push(sessionPath);
        return { cancelled: false };
      },
    });
    const taskId = "t-unknown-entry";
    const ownerSessionId = parent.getHeader()?.id;
    assert.ok(ownerSessionId);
    const controller = createTaskWidgetController(
      new Map(),
      new Map([[taskId, makeTask({ backend: "durable", cwd: root, dir: root, ownerSessionId })]]),
    );
    controller.setLiveTranscript(taskId, [
      { type: "user", text: "child prompt", timestamp: "" },
      { type: "assistant", text: "child answer", timestamp: "" },
    ]);
    controller.ensureTaskWidget(context);
    assert.equal(await controller.openAgentSwitcher(context), true);
    const editor = createEditor();
    assert.ok(editor);
    editor.handleInput("\x1b[B");
    editor.handleInput("\r");
    await Promise.resolve();

    assert.deepEqual(switchedPaths, [], "selection opens the overlay instead of a snapshot");
    const view = mountOverlay({ fg: (_style: string, text: string) => text }).render(80).join("\n");
    assert.match(view, /child answer/, "a parent with an unknown entry kind still opens the child transcript");
    assert.ok(!notices.some((notice) => notice.level === "error"));
    controller.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task transcript assistant messages use Pi's native renderer without clipping thinking", () => {
  initTheme();
  const thinking = Array.from({ length: 12 }, (_, i) => `reasoning line ${i + 1}`).join("\n");
  const message = {
    role: "assistant" as const,
    content: [
      { type: "thinking" as const, thinking },
      { type: "text" as const, text: "The answer." },
    ],
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
    stopReason: "stop" as const,
    timestamp: 0,
  };
  const nativeLines = new AssistantMessageComponent(message).render(100);
  const pane = createTaskTranscriptPane(
    { terminal: { rows: 60 }, requestRender: () => {} } as never,
    { fg: (_style: string, text: string) => text } as never,
    {
      taskId: "t-thinking",
      cwd: "/tmp",
      sig: () => "stable",
      read: () => [
        { type: "assistant", text: "The answer.", thinking, timestamp: "" },
      ],
    },
  );

  try {
    const lines = pane.render(100, 100);
    const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
    assert.ok(plainLines.some((line) => line.includes("reasoning line 1")));
    assert.ok(plainLines.some((line) => line.includes("reasoning line 12")), "full native thinking block stays visible");
    assert.ok(plainLines.some((line) => line.includes("The answer.")));
    // The pane strips OSC 133 semantic-prompt markers (they break padded
    // rendering on spec-compliant terminals), so compare the native renderer's
    // lines minus those marker-only rows.
    const expected = nativeLines
      .filter((line) => !/^(\x1b\[[0-9;]*m)*\x1b\]133;[^\x07\x1b]*(\x07|\x1b\\)/.test(line))
      .map((line) => line.replace(/\x1b\]133;[^\x07\x1b]*(\x07|\x1b\\)/g, ""));
    for (const line of expected) {
      assert.ok(lines.includes(line), `native assistant renderer line is preserved: ${JSON.stringify(line)}`);
    }
  } finally {
    pane.dispose();
  }
});

test("task transcript pane strips ANSI escapes from tool results at parse time", () => {
  initTheme();
  const pane = createTaskTranscriptPane(
    { terminal: { rows: 60 }, requestRender: () => {} } as never,
    { fg: (_style: string, text: string) => text } as never,
    {
      taskId: "t-ansi-strip",
      cwd: "/tmp",
      sig: () => "stable",
      read: () => [
        {
          type: "tool",
          name: "codemode",
          toolCallId: "call-ansi-unknown",
          args: {},
          timestamp: "",
          inProgress: false,
          result: "\x1b[34m fail 0\x1b[39m\n\x1b[32m pass 12\x1b[39m",
        },
      ],
    },
  );

  try {
    const joined = pane.render(110).map((l: string) => l.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
    assert.ok(joined.includes("fail 0"), "the text itself renders");
    assert.ok(!joined.includes("[34m") && !joined.includes("[39m"), "no raw ANSI escapes leak");
  } finally {
    pane.dispose();
  }
});
