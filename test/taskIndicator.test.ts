/**
 * Animation lifecycle for the working indicators: the below-editor task rows
 * and the live child panel's native working row.
 *
 * Both must animate only while a child is actually running, and both must stop
 * on completion, cancellation, dispose, or a session switch. Timers are mocked
 * so the assertions are deterministic instead of wall-clock dependent.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createTaskWidgetController } from "../src/lifecycle/widget.js";
import { TaskTranscriptOverlay } from "../src/panel/task-transcript-overlay.js";
import { TASK_WIDGET_RENDER_MS } from "../src/task-widget.js";
import type { TaskActivity } from "../src/task-activity.js";
import type { BackgroundTask } from "../src/types.js";

function makeTask(over: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    agentType: "general",
    sessionName: "task-1",
    originalPane: null,
    description: "run",
    startedAt: 1000,
    toolUses: 0,
    recentCalls: [],
    dir: "/tmp/art",
    ...over,
  };
}

/** Minimal TUI/extension context seam for the widget controller. */
function makeWidgetHarness() {
  let widgetFactory:
    | ((tui: unknown, theme: unknown) => { render(width: number): string[] })
    | undefined;
  const customCalls: Array<{
    factory: (
      tui: unknown,
      theme: unknown,
      keybindings: unknown,
      done: (result?: unknown) => void,
    ) => { render(width: number): string[]; dispose?(): void };
    resolve: (result?: unknown) => void;
  }> = [];
  const ui: any = {
    setWidget(key: string, value: unknown) {
      if (key !== "task") return;
      widgetFactory = typeof value === "function" ? (value as never) : undefined;
    },
    getEditorComponent: () => undefined,
    setEditorComponent: () => {},
    notify: () => {},
    custom(factory: (typeof customCalls)[number]["factory"]) {
      let resolve: (result?: unknown) => void = () => {};
      const promise = new Promise((r) => {
        resolve = r as never;
      });
      customCalls.push({ factory, resolve });
      return promise;
    },
  };
  const context = {
    mode: "tui",
    hasUI: true,
    cwd: "/tmp",
    ui,
    sessionManager: undefined,
  } as never;
  return {
    context,
    customCalls,
    getFactory: () => widgetFactory,
  };
}

test("below-editor rows repaint on the animation frame while a task runs", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const foreground = new Map([["t1", makeTask()]]);
  const controller = createTaskWidgetController(foreground, new Map());
  const harness = makeWidgetHarness();
  controller.ensureTaskWidget(harness.context);

  let renders = 0;
  const tui = { terminal: { rows: 40 }, requestRender: () => { renders += 1; } };
  harness.getFactory()!(tui, { fg: (_token: string, text: string) => text });

  renders = 0;
  t.mock.timers.tick(TASK_WIDGET_RENDER_MS);
  assert.equal(renders, 1, "a running task repaints once per animation frame");
  t.mock.timers.tick(TASK_WIDGET_RENDER_MS * 2);
  assert.equal(renders, 3, "the animation keeps advancing frame by frame");

  // The task settles and leaves the map: nothing is animating any more.
  const task = foreground.get("t1")!;
  foreground.delete("t1");
  controller.noteTaskFinished("t1", { ...task, status: "done" });
  renders = 0;
  t.mock.timers.tick(TASK_WIDGET_RENDER_MS * 10);
  assert.equal(renders, 0, "a finished task leaves no timer behind");
  controller.dispose();
});

test("the row ticker pauses while the transcript overlay owns the screen", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const foreground = new Map([["t1", makeTask()]]);
  const controller = createTaskWidgetController(foreground, new Map());
  const harness = makeWidgetHarness();
  controller.ensureTaskWidget(harness.context);

  let renders = 0;
  const tui = { terminal: { rows: 40 }, requestRender: () => { renders += 1; } };
  harness.getFactory()!(tui, { fg: (_token: string, text: string) => text });

  controller.openTaskView("t1");
  renders = 0;
  t.mock.timers.tick(TASK_WIDGET_RENDER_MS * 5);
  assert.equal(renders, 0, "the overlay repaints itself; the hidden rows stay quiet");

  controller.closeTaskView("t1");
  renders = 0;
  t.mock.timers.tick(TASK_WIDGET_RENDER_MS);
  assert.ok(renders >= 1, "the rows animate again once the overlay closes");
  controller.dispose();
});

test("disposing the widget stops the row ticker", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const foreground = new Map([["t1", makeTask()]]);
  const controller = createTaskWidgetController(foreground, new Map());
  const harness = makeWidgetHarness();
  controller.ensureTaskWidget(harness.context);

  let renders = 0;
  const tui = { terminal: { rows: 40 }, requestRender: () => { renders += 1; } };
  harness.getFactory()!(tui, { fg: (_token: string, text: string) => text });
  t.mock.timers.tick(TASK_WIDGET_RENDER_MS);

  controller.dispose();
  renders = 0;
  t.mock.timers.tick(TASK_WIDGET_RENDER_MS * 10);
  assert.equal(renders, 0, "a disposed widget (session switch) stops animating");
});

/** Overlay seam: fake pane/editor plus a TUI that counts repaint requests. */
function makeOverlayHarness(activity: () => TaskActivity | undefined) {
  const calls = { renders: 0 };
  const overlay = new TaskTranscriptOverlay({
    pane: {
      scrollBy: () => {},
      render: (width: number) => ["transcript".padEnd(width)],
      invalidate: () => {},
      dispose: () => {},
    },
    host: {
      taskId: "t1",
      onSteer: () => {},
      onClose: () => {},
      requestRender: () => {
        calls.renders += 1;
      },
      activity,
    },
    theme: { fg: (_token: string, text: string) => text, bg: (_token: string, text: string) => text },
    editor: {
      handleInput: () => {},
      render: (width: number) => ["steer".padEnd(width)],
      getText: () => "",
      setText: () => {},
    },
    terminalRows: () => 12,
    ui: { requestRender: () => { calls.renders += 1; } } as never,
  });
  const lines = (width = 60) =>
    overlay.render(width).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
  return { overlay, calls, lines };
}

test("live child panel animates pi's working indicator while the child runs", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let phase: TaskActivity | undefined = { phase: "tool", label: "Running websearch…" };
  const { overlay, calls, lines } = makeOverlayHarness(() => phase);

  const first = lines().join("\n");
  assert.match(first, /Running websearch…/, "the child's phase is shown");
  assert.match(first, /⠋/, "the working indicator draws a spinner frame");

  calls.renders = 0;
  t.mock.timers.tick(80);
  assert.ok(calls.renders >= 1, "the native loader repaints the panel while active");
  assert.match(lines().join("\n"), /⠙/, "the spinner advances to the next frame");

  // The child settles: the indicator disappears and its timer stops.
  phase = undefined;
  const settled = lines().join("\n");
  assert.doesNotMatch(settled, /Running websearch…|⠙/, "no indicator for a settled child");
  calls.renders = 0;
  t.mock.timers.tick(500);
  assert.equal(calls.renders, 0, "the loader timer is stopped, not just hidden");

  overlay.dispose();
});

test("the detached working row yields when it would leave no room beside the editor", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const makeShort = (rows: number) =>
    new TaskTranscriptOverlay({
      pane: {
        scrollBy: () => {},
        // Honors the row budget like the real pane (0 rows renders nothing).
        render: (width: number, availableRows?: number) =>
          availableRows === 0 ? [] : ["transcript".padEnd(width)],
        invalidate: () => {},
        dispose: () => {},
      },
      host: {
        taskId: "t1",
        onSteer: () => {},
        onClose: () => {},
        requestRender: () => {},
        activity: () => ({ phase: "tool", label: "Running read…" }),
      },
      theme: null,
      editor: {
        handleInput: () => {},
        render: (width: number) => ["steer".padEnd(width)],
        getText: () => "",
        setText: () => {},
      },
      terminalRows: () => rows,
      ui: { requestRender: () => {} } as never,
    });

  // 2 rows: editor + indicator would leave nothing else, so the indicator goes.
  const cramped = makeShort(2);
  try {
    const frame = cramped.render(40);
    assert.equal(frame.length, 2, "a cramped frame is not clipped");
    assert.doesNotMatch(frame.join("\n"), /Running read…/, "no working row without room");
  } finally {
    cramped.dispose();
  }

  // 3 rows: editor + indicator + one transcript row fit exactly.
  const exact = makeShort(3);
  try {
    const frame = exact.render(40);
    assert.equal(frame.length, 3, "an exact frame is not clipped");
    assert.match(frame.join("\n"), /Running read…/, "the indicator fits when there is room");
  } finally {
    exact.dispose();
  }
});

test("live child panel hides the indicator when the task is cancelled or fails", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let phase: TaskActivity | undefined = { phase: "streaming", label: "Streaming…" };
  const { overlay, calls, lines } = makeOverlayHarness(() => phase);
  assert.match(lines().join("\n"), /Streaming…/);

  phase = undefined; // cancelled / failed / done
  lines();
  calls.renders = 0;
  t.mock.timers.tick(500);
  assert.equal(calls.renders, 0, "a cancelled child leaves no repaint timer");

  overlay.dispose();
  phase = { phase: "running", label: "Running…" };
  calls.renders = 0;
  t.mock.timers.tick(500);
  assert.equal(calls.renders, 0, "a disposed overlay never restarts the animation");
});

test("the slow transcript tick yields to the running working indicator", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const task = makeTask({ backend: "sdk" });
  const foreground = new Map([["t1", task]]);
  const controller = createTaskWidgetController(foreground, new Map());
  const harness = makeWidgetHarness();
  controller.ensureTaskWidget(harness.context);

  let widgetRenders = 0;
  const widgetTui = { terminal: { rows: 40 }, requestRender: () => { widgetRenders += 1; } };
  harness.getFactory()!(widgetTui, { fg: (_token: string, text: string) => text });

  controller.openTaskView("t1");
  const call = harness.customCalls.at(-1)!;
  let overlayRenders = 0;
  const overlayTui = { terminal: { rows: 40 }, requestRender: () => { overlayRenders += 1; } };
  const overlay = call.factory(
    overlayTui,
    { fg: (_token: string, text: string) => text, bg: (_token: string, text: string) => text },
    {},
    () => {},
  );
  overlay.render(60);

  widgetRenders = 0;
  overlayRenders = 0;
  t.mock.timers.tick(700);
  assert.equal(widgetRenders, 0, "the working indicator already repaints the open panel");
  assert.ok(overlayRenders >= 1, "the indicator animates on its own frames");

  // The child settles: the indicator stops and the slow tick resumes.
  task.status = "done";
  widgetRenders = 0;
  t.mock.timers.tick(700);
  assert.ok(widgetRenders >= 1, "the transcript tick repaints a settled view again");
  controller.closeTaskView("t1");
  controller.dispose();
});
