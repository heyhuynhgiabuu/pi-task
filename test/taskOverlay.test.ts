/**
 * The /task overlay is a centered modal (`ctx.ui.custom` with `overlay: true`)
 * for browsing the session's tasks: ↑↓ select, enter opens the live transcript
 * view, x stops/dismisses, esc closes. The component is a plain pi-tui
 * Component, so its keys are pinned here against the same panel dispatch the
 * below-editor panel uses — and the controller wiring is pinned against a mock
 * ui.custom: center anchor, live rows, and enter handing off to the live view.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createTaskWidgetController } from "../src/lifecycle/widget.js";
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
  open: string[];
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
  options?: { overlay?: boolean; overlayOptions?: { anchor?: string } };
  resolve: (result: unknown) => void;
}

function createOverlayContext() {
  const setWidgetCalls: Array<{ key: string; placement?: string }> = [];
  const customCalls: CapturedCustom[] = [];
  const ui: any = {
    setWidget(key: string, value: unknown, options?: { placement?: string }) {
      setWidgetCalls.push({ key, placement: options?.placement });
    },
    getEditorComponent: () => undefined,
    setEditorComponent: () => {},
    notify: () => {},
    custom(
      factory: CapturedCustom["factory"],
      options?: CapturedCustom["options"],
    ): Promise<unknown> {
      return new Promise((resolve) => {
        customCalls.push({ factory, options, resolve });
      });
    },
  };
  return {
    context: { mode: "tui", hasUI: true, cwd: "/tmp", ui } as any,
    setWidgetCalls,
    customCalls,
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
  assert.ok(
    setWidgetCalls.some((c) => c.key === "task-transcript"),
    "live transcript view opened",
  );
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
  assert.equal(
    setWidgetCalls.some((c) => c.key === "task-transcript"),
    false,
    "no transcript view",
  );
  controller.dispose();
});
