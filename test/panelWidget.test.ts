import assert from "node:assert/strict";
import { test } from "node:test";
import { createTaskWidgetController } from "../src/lifecycle/widget.js";
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
  const setWidgetCalls: Array<{ key: string; placement?: string }> = [];
  const ui: any = {
    setWidget(key: string, value: unknown, options?: { placement?: string }) {
      setWidgetCalls.push({ key, placement: options?.placement });
      if (typeof value === "function") widgetFactory = value as never;
      else if (value === undefined) widgetFactory = undefined;
    },
    getEditorComponent: () => undefined,
    setEditorComponent: () => {
      editorInstalled = true;
    },
    notify: () => {},
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
  };
}

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
