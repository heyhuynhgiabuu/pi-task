/**
 * The /task overlay is a centered modal (`ctx.ui.custom` with `overlay: true`)
 * for browsing the session's tasks: ↑↓ select, enter opens the live transcript
 * view, x stops/dismisses, esc closes. The component is a plain pi-tui
 * Component, so its keys are pinned here against the same panel dispatch the
 * below-editor panel uses — and the controller wiring is pinned against a mock
 * ui.custom: center anchor, live rows, and enter handing off to the live view.
 */

import { strict as assert } from "node:assert";
import { CustomEditor, initTheme } from "@earendil-works/pi-coding-agent";
import { test } from "node:test";

import {
  createSteerEditor,
  createTaskWidgetController,
} from "../src/lifecycle/widget.js";
import {
  TaskOverlay,
  type TaskOverlayHost,
} from "../src/panel/task-overlay.js";
import type { TaskPanelRow } from "../src/panel/panel-core.js";
import type { BackgroundTask } from "../src/types.js";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ESC = "\x1b";
const ENTER = "\r";

function makeRow(id: string, over: Partial<TaskPanelRow> = {}): TaskPanelRow {
  return {
    id,
    agentType: "general",
    description: `task ${id}`,
    status: "running",
    startedAt: 1000,
    ...over,
  };
}

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

interface OverlayCalls {
  open: Array<string | null>;
  stop: string[];
  close: number;
  renders: number;
}

function makeHost(getRows: () => TaskPanelRow[]): {
  host: TaskOverlayHost;
  calls: OverlayCalls;
} {
  const calls: OverlayCalls = { open: [], stop: [], close: 0, renders: 0 };
  const host: TaskOverlayHost = {
    getRows,
    now: () => 1000,
    onStop: (id) => calls.stop.push(id),
    onOpen: (id) => calls.open.push(id),
    onClose: () => calls.close++,
    requestRender: () => calls.renders++,
  };
  return { host, calls };
}

function renderLines(overlay: TaskOverlay, width = 80): string[] {
  return overlay.render(width).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
}

test("overlay opens with the first row selected", () => {
  const { host } = makeHost(() => [makeRow("t1"), makeRow("t2")]);
  const overlay = new TaskOverlay(host, null);
  const lines = renderLines(overlay);
  assert.ok(lines.some((l) => l.includes("tasks (2)")), JSON.stringify(lines));
  const selected = lines.find((l) => l.includes("❯"));
  assert.ok(selected && selected.includes("task t1"), JSON.stringify(lines));
});

test("an empty overlay shows the tasks (0) state with main selected", () => {
  const { host } = makeHost(() => []);
  const overlay = new TaskOverlay(host, null);
  const lines = renderLines(overlay);
  assert.ok(lines.some((l) => l.includes("tasks (0)")), JSON.stringify(lines));
  const selected = lines.find((l) => l.includes("❯"));
  assert.ok(selected && selected.includes("main"), JSON.stringify(lines));
});

test("down moves the selection, enter opens the selected row", () => {
  const { host, calls } = makeHost(() => [makeRow("t1"), makeRow("t2")]);
  const overlay = new TaskOverlay(host, null);
  overlay.handleInput(DOWN);
  const selected = renderLines(overlay).find((l) => l.includes("❯"));
  assert.ok(selected && selected.includes("task t2"), "second row selected");
  overlay.handleInput(ENTER);
  assert.deepEqual(calls.open, ["t2"]);
});

test("up walks back to main and a further up is held there", () => {
  const { host, calls } = makeHost(() => [makeRow("t1")]);
  const overlay = new TaskOverlay(host, null);
  overlay.handleInput(UP);
  let selected = renderLines(overlay).find((l) => l.includes("❯"));
  assert.ok(selected && selected.includes("main"), "first up reaches main");
  overlay.handleInput(UP);
  assert.equal(calls.close, 0, "top-up does not close");
  selected = renderLines(overlay).find((l) => l.includes("❯"));
  assert.ok(selected && selected.includes("main"), "held at main");
});

test("x stops the selected row", () => {
  const { host, calls } = makeHost(() => [makeRow("t1"), makeRow("t2")]);
  const overlay = new TaskOverlay(host, null);
  overlay.handleInput(DOWN);
  overlay.handleInput("x");
  assert.deepEqual(calls.stop, ["t2"]);
});

test("esc closes the overlay", () => {
  const { host, calls } = makeHost(() => [makeRow("t1")]);
  const overlay = new TaskOverlay(host, null);
  overlay.handleInput(ESC);
  assert.equal(calls.close, 1);
});

test("unhandled keys are swallowed, x on empty state does nothing", () => {
  const { host, calls } = makeHost(() => []);
  const overlay = new TaskOverlay(host, null);
  overlay.handleInput("a");
  overlay.handleInput("x");
  overlay.handleInput(ENTER);
  overlay.handleInput(DOWN);
  assert.equal(calls.close, 0);
  assert.deepEqual(calls.open, []);
  assert.deepEqual(calls.stop, []);
});

test("vanishing rows reconcile the selection", () => {
  let rows = [makeRow("t1"), makeRow("t2")];
  const { host } = makeHost(() => rows);
  const overlay = new TaskOverlay(host, null);
  overlay.handleInput(DOWN);
  rows = [makeRow("t1")];
  const selected = renderLines(overlay).find((l) => l.includes("❯"));
  assert.ok(selected && selected.includes("task t1"), "fell back to first row");
});

test("the overlay body is padded to the box width so a background fill reads as a solid panel", () => {
  // A theme that visibly marks background spans: every bg-wrapped span starts
  // with the marker, so unpadded or unstyled lines fail the assertion.
  const theme = {
    fg: (_c: string, s: string) => s,
    bg: (c: string, s: string) => `[${c}]${s}[/${c}]`,
  };
  const { host } = makeHost(() => [makeRow("t1")]);
  const overlay = new TaskOverlay(host, theme);
  const width = 60;
  const lines = overlay.render(width);
  assert.ok(lines.length > 0, "body rendered");
  for (const line of lines) {
    assert.ok(
      line.startsWith("[customMessageBg]"),
      `background fill applied: ${JSON.stringify(line)}`,
    );
    const payload = line
      .replace(/\x1b\[[0-9;]*m/g, "")
      .replace(/\[\/?customMessageBg\]/g, "");
    assert.equal(
      payload.length,
      width,
      `padded to full width: ${JSON.stringify(line)}`,
    );
  }
});

// ── Controller wiring: ctx.ui.custom contract ───────────────────────────────

interface CapturedCustom {
  factory: (
    tui: unknown,
    theme: unknown,
    keybindings: unknown,
    done: (result?: unknown) => void,
  ) => { render(w: number): string[]; handleInput(data: string): void };
  options?: {
    overlay?: boolean;
    overlayOptions?: {
      anchor?: string;
      width?: number | string;
      maxHeight?: number | string;
      margin?: number;
    };
  };
  resolve: (result: unknown) => void;
  resolved: boolean;
}

function createOverlayContext() {
  const setWidgetCalls: Array<{ key: string; value?: unknown; placement?: string }> = [];
  let widgetFactory: ((tui: unknown, theme: unknown) => { render(width: number): string[] }) | undefined;
  let editorFactory:
    | ((tui: unknown, theme: unknown, keybindings: unknown) => { handleInput(data: string): void })
    | undefined;
  const customCalls: CapturedCustom[] = [];
  const ui: any = {
    setWidget(key: string, value: unknown, options?: { placement?: string }) {
      setWidgetCalls.push({ key, value, placement: options?.placement });
      if (typeof value === "function") widgetFactory = value as never;
      else if (value === undefined) widgetFactory = undefined;
    },
    getEditorComponent: () => undefined,
    setEditorComponent: (factory: never) => {
      editorFactory = factory;
    },
    notify: () => {},
    custom(
      factory: CapturedCustom["factory"],
      options?: CapturedCustom["options"],
    ): Promise<unknown> {
      const call: CapturedCustom = {
        factory,
        options,
        resolve: () => {},
        resolved: false,
      };
      return new Promise((resolve) => {
        call.resolve = (result?: unknown) => {
          call.resolved = true;
          resolve(result);
        };
        customCalls.push(call);
      });
    },
  };
  const fakeTui = { terminal: { rows: 40 }, requestRender: () => {} };
  return {
    context: { mode: "tui", hasUI: true, cwd: "/tmp", ui } as any,
    setWidgetCalls,
    customCalls,
    getFactory: () => widgetFactory,
    createEditor: () =>
      editorFactory?.(fakeTui, { borderColor: (t: string) => t }, { matches: () => false }),
  };
}

test("openOverlay shows a centered capturing overlay", async () => {
  const foreground = new Map([["t1", makeTask()]]);
  const controller = createTaskWidgetController(foreground, new Map());
  const { context, customCalls } = createOverlayContext();
  const pending = controller.openOverlay(context);
  assert.equal(customCalls.length, 1, "ui.custom called");
  assert.equal(customCalls[0]!.options?.overlay, true, "overlay mode");
  assert.equal(
    customCalls[0]!.options?.overlayOptions?.anchor,
    "center",
    "centered",
  );
  customCalls[0]!.resolve(undefined);
  assert.equal(await pending, true);
  controller.dispose();
});

test("openOverlay falls back outside the TUI", async () => {
  const foreground = new Map([["t1", makeTask()]]);
  const controller = createTaskWidgetController(foreground, new Map());
  const base = createOverlayContext();
  const context = { ...base.context, mode: "acp" };
  assert.equal(await controller.openOverlay(context as any), false);
  assert.equal(base.customCalls.length, 0, "no overlay requested");
  controller.dispose();
});

test("overlay rows come from the controller and enter opens the live view", async () => {
  const foreground = new Map([["t1", makeTask()]]);
  const controller = createTaskWidgetController(foreground, new Map());
  const { context, customCalls, setWidgetCalls } = createOverlayContext();
  controller.ensureTaskWidget(context);
  const pending = controller.openOverlay(context);
  const captured = customCalls[0]!;
  const overlay = captured.factory({}, null, {}, () =>
    captured.resolve(undefined),
  );
  const lines = overlay.render(80).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.ok(lines.some((l) => l.includes("run") && l.includes("general")), JSON.stringify(lines));
  overlay.handleInput(ENTER);
  assert.equal(await pending, true, "overlay resolved");
  assert.equal(customCalls.length, 2, "enter opens the live transcript overlay");
  assert.equal(customCalls[1]?.options?.overlay, true, "live view is an overlay");
  controller.dispose();
});

test("esc resolves the overlay without opening a view", async () => {
  const foreground = new Map([["t1", makeTask()]]);
  const controller = createTaskWidgetController(foreground, new Map());
  const { context, customCalls, setWidgetCalls } = createOverlayContext();
  const pending = controller.openOverlay(context);
  const captured = customCalls[0]!;
  const overlay = captured.factory({}, null, {}, () =>
    captured.resolve(undefined),
  );
  overlay.handleInput(ESC);
  assert.equal(await pending, true);
  assert.equal(customCalls.length, 1, "no transcript view opened");
  controller.dispose();
});

test("agents overlay marks the shown agent and switches between main and task transcripts", () => {
  const rows = [makeRow("t1"), makeRow("t2")];
  const { host, calls } = makeHost(() => rows);
  const overlay = new TaskOverlay(host, null, {
    mode: "agents",
    shownTaskId: "t2",
  });
  const lines = renderLines(overlay);
  assert.ok(lines.some((line) => line.includes("Switch to:")), JSON.stringify(lines));
  assert.ok(lines.some((line) => line.includes("main")));
  assert.ok(lines.some((line) => line.includes("t2") && line.includes("(shown)")));
  assert.ok(
    lines.find((line) => line.includes("❯"))?.includes("t2"),
    "the currently shown subagent starts selected",
  );

  overlay.handleInput(UP);
  overlay.handleInput(UP);
  overlay.handleInput(ENTER);
  assert.deepEqual(calls.open, [null], "main is a selectable switch target");
  assert.deepEqual(calls.stop, [], "the switcher does not stop agents");

  const { host: mainHost, calls: mainCalls } = makeHost(() => rows);
  const fromMain = new TaskOverlay(mainHost, null, {
    mode: "agents",
    shownTaskId: null,
  });
  assert.ok(
    renderLines(fromMain).some((line) => line.includes("main") && line.includes("(shown)")),
  );
  fromMain.handleInput(DOWN);
  fromMain.handleInput(ENTER);
  assert.deepEqual(mainCalls.open, ["t1"], "a subagent opens its transcript");
});

test("agents switcher updates its shown marker when the transcript closes", async () => {
  const foreground = new Map([["t1", makeTask()]]);
  const controller = createTaskWidgetController(foreground, new Map());
  const { context, getFactory } = createOverlayContext();
  controller.ensureTaskWidget(context);

  assert.equal(await controller.openAgentSwitcher(context), true);
  const widget = getFactory()!({ terminal: { rows: 40 }, requestRender: () => {} }, null);
  const lines = (widget.render(120) as string[]).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.ok(lines.some((line) => line.includes("main") && line.includes("(shown)")));
  assert.ok(!lines.some((line) => line.includes("t1") && line.includes("(shown)")));
  controller.dispose();
});

// ── Inline agent switcher (/agents focuses the below-editor panel) ─────────

test("agents switcher focuses the below-editor panel on the shown agent", async () => {
  const foreground = new Map([
    ["t1", makeTask()],
    ["t2", makeTask({ description: "second" })],
  ]);
  const controller = createTaskWidgetController(foreground, new Map());
  const { context, customCalls, getFactory } = createOverlayContext();
  controller.ensureTaskWidget(context);
  controller.openTaskView("t1");
  assert.deepEqual(customCalls[0]!.options?.overlayOptions, {
    anchor: "top-left",
    width: "100%",
    maxHeight: "100%",
    margin: 0,
  });
  customCalls[0]!.factory({}, null, {}, (r?: unknown) => customCalls[0]!.resolve(r));

  assert.equal(await controller.openAgentSwitcher(context), true);
  assert.equal(customCalls.length, 1, "the switcher is not a modal anymore");
  assert.equal(customCalls[0]!.resolved, true, "opening the picker closes the transcript view");
  const widget = getFactory()!({ terminal: { rows: 40 }, requestRender: () => {} }, null);
  const lines = (widget.render(120) as string[]).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.ok(lines.some((l) => l.includes("Switch to:")), JSON.stringify(lines));
  assert.ok(lines.some((l) => l.includes("#t1") && l.includes("(shown)")), JSON.stringify(lines));
  assert.ok(
    lines.find((l) => l.includes("❯"))?.includes("#t1"),
    "the agent being watched starts selected",
  );
  controller.dispose();
});

test("agents switcher preselects the watched agent even when its finished row aged out", async () => {
  let clock = 100_000;
  const finished = makeTask({ status: "done", description: "aged but watched" });
  const controller = createTaskWidgetController(new Map(), new Map(), { now: () => clock });
  controller.noteTaskFinished("t-aged", finished, clock);
  const { context, customCalls, getFactory } = createOverlayContext();
  controller.ensureTaskWidget(context);
  controller.openTaskView("t-aged"); // the user is watching it when /agents fires
  customCalls[0]!.factory({}, null, {}, (r?: unknown) => customCalls[0]!.resolve(r));

  clock += 60_000; // past the done-linger window (5s): the idle list drops it
  await controller.openAgentSwitcher(context);
  const widget = getFactory()!({ terminal: { rows: 40 }, requestRender: () => {} }, null);
  const lines = (widget.render(140) as string[]).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.ok(lines.some((l) => l.includes("#t-aged")), JSON.stringify(lines));
  assert.ok(
    lines.find((l) => l.includes("❯"))?.includes("#t-aged"),
    "the watched aged agent starts selected",
  );
  controller.dispose();
});

test("agents enter restores the interrupted view if native session switching is unavailable", async () => {
  const foreground = new Map([
    ["t1", makeTask()],
    ["t2", makeTask({ description: "second" })],
  ]);
  const controller = createTaskWidgetController(foreground, new Map());
  const { context, customCalls, getFactory, createEditor } = createOverlayContext();
  controller.ensureTaskWidget(context);
  controller.openTaskView("t1");
  customCalls[0]!.factory({}, null, {}, (r?: unknown) => customCalls[0]!.resolve(r));
  await controller.openAgentSwitcher(context);

  const editor = createEditor();
  assert.ok(editor, "panel editor installed");
  editor.handleInput(DOWN); // t1 -> t2
  editor.handleInput(ENTER); // switch to t2
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(customCalls.length, 2, "the interrupted transcript is restored after the missing API");
  assert.equal(customCalls[0]!.resolved, true, "the picker closed");
  assert.equal(customCalls[1]!.options?.overlay, true, "the prior view is restored");
  const widget = getFactory()!({ terminal: { rows: 40 }, requestRender: () => {} }, null);
  const lines = (widget.render(120) as string[]).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.ok(!lines.some((l) => l.includes("Switch to:")), "picker closed after enter");
  controller.dispose();
});

test("esc closes the inline agents picker", async () => {
  const foreground = new Map([["t1", makeTask()]]);
  const controller = createTaskWidgetController(foreground, new Map());
  const { context, getFactory, createEditor } = createOverlayContext();
  controller.ensureTaskWidget(context);
  await controller.openAgentSwitcher(context);

  const editor = createEditor();
  editor.handleInput(ESC);
  const widget = getFactory()!({ terminal: { rows: 40 }, requestRender: () => {} }, null);
  const lines = (widget.render(120) as string[]).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.ok(!lines.some((l) => l.includes("Switch to:")), "picker closed");
  controller.dispose();
});

test("agents switcher falls back to the modal when another extension owns the editor", async () => {
  const foreground = new Map([["t1", makeTask({ description: "first" })]]);
  const controller = createTaskWidgetController(foreground, new Map());
  const { context, customCalls } = createOverlayContext();
  // Another extension owns the custom editor: the inline panel cannot take
  // keyboard input, so /agents must fall back to the capturing modal.
  context.ui.getEditorComponent = () => ({ handleInput() {} });

  const pending = controller.openAgentSwitcher(context);
  const modal = customCalls.at(-1)!;
  assert.equal(modal.options?.overlay, true, "fallback opens the capturing modal");
  const overlay = modal.factory({}, null, {}, (r?: unknown) => modal.resolve(r));
  const lines = (overlay.render(80) as string[]).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.ok(lines.some((l) => l.includes("Switch to:")), JSON.stringify(lines));
  assert.ok(lines.some((l) => l.includes("main") && l.includes("(shown)")), JSON.stringify(lines));
  overlay.handleInput("\x1b");
  assert.equal(await pending, true, "esc closes the fallback switcher");
  controller.dispose();
});

test("esc in the inline agents picker restores the interrupted transcript", async () => {
  const foreground = new Map([["t1", makeTask()]]);
  const controller = createTaskWidgetController(foreground, new Map());
  const { context, customCalls, createEditor } = createOverlayContext();
  controller.ensureTaskWidget(context);
  controller.openTaskView("t1");
  customCalls[0]!.factory({}, null, {}, (r?: unknown) => customCalls[0]!.resolve(r));
  await controller.openAgentSwitcher(context); // picker closes the view
  assert.equal(customCalls[0]!.resolved, true);

  const editor = createEditor();
  editor.handleInput(ESC); // cancel the picker
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(customCalls.length, 2, "the interrupted transcript is restored");
  assert.equal(customCalls[1]!.options?.overlay, true);
  controller.dispose();
});

test("typing in the inline agents picker exits without restoring the transcript", async () => {
  const foreground = new Map([["t1", makeTask()]]);
  const controller = createTaskWidgetController(foreground, new Map());
  const { context, customCalls, createEditor, getFactory } = createOverlayContext();
  controller.ensureTaskWidget(context);
  controller.openTaskView("t1");
  customCalls[0]!.factory({}, null, {}, (r?: unknown) => customCalls[0]!.resolve(r));
  await controller.openAgentSwitcher(context);

  const editor = createEditor();
  editor.handleInput("q"); // stray typing exits the picker, restores nothing
  const widget = getFactory()!({ terminal: { rows: 40 }, requestRender: () => {} }, null);
  const lines = (widget.render(120) as string[]).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.ok(!lines.some((l) => l.includes("Switch to:")), "picker closed");
  assert.equal(customCalls.length, 1, "no transcript restored on stray typing");
  controller.dispose();
});

test("createSteerEditor builds a real editor on production-shaped themes", () => {
  initTheme();
  // Production shape per the host: ui.custom themes carry fg/bg but NO
  // borderColor — the editor-theme adapter must supply it.
  const theme = {
    bg: (_token: string, text: string) => text,
    fg: (_token: string, text: string) => text,
  };
  const fakeTui = { terminal: { rows: 40 }, requestRender: () => {} };
  const editor = createSteerEditor(fakeTui, theme, { matches: () => false });

  assert.ok(editor instanceof CustomEditor, "the real CustomEditor activates");
  const lines = (editor.render(80) as string[]).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.ok(Array.isArray(lines) && lines.length > 0, "the real editor renders");
});

test("createSteerEditor falls back to the minimal editor on degraded themes", () => {
  const fakeTui = { terminal: { rows: 40 }, requestRender: () => {} };
  const editor = createSteerEditor(fakeTui, { fg: (_s: string, t: string) => t }, { matches: () => false });
  assert.ok(!(editor instanceof CustomEditor), "degraded theme gets the minimal input");
  const lines = editor.render(80).map((l: string) => l.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.ok(lines.some((l) => l.includes("❯")));
});
