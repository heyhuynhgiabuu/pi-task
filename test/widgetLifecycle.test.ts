import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTaskWidgetController } from "../src/lifecycle/widget";

function createTuiContext() {
  let widgetFactory: ((tui: { requestRender(): void }, theme: unknown) => unknown) | undefined;
  const setWidgetCalls: unknown[] = [];
  return {
    context: {
      mode: "tui",
      ui: {
        setWidget(_name: string, value: unknown) {
          setWidgetCalls.push(value);
          widgetFactory = value as typeof widgetFactory;
        },
      },
    } as any,
    getWidgetFactory: () => widgetFactory,
    setWidgetCalls,
  };
}

test("task widget renders only when explicitly refreshed", () => {
  const foregroundTasks = new Map();
  const backgroundTasks = new Map();
  const { context, getWidgetFactory } = createTuiContext();
  const controller = createTaskWidgetController(foregroundTasks, backgroundTasks);
  let renders = 0;

  controller.ensureTaskWidget(context);
  const widget = getWidgetFactory()?.(
    { requestRender: () => renders++ },
    undefined,
  );

  assert.ok(widget);
  assert.equal(renders, 0, "widget registration must not start a repaint loop");
  controller.requestRender();
  assert.equal(renders, 1);
  controller.requestRender();
  assert.equal(renders, 2);
  controller.dispose();
});

test("hostile session dirs degrade to an empty transcript instead of a render error", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-widget-hostile-"));
  try {
    // `dir` is a FILE, so any readdir/stat underneath throws.
    const hostileDir = join(root, "not-a-dir");
    writeFileSync(hostileDir, "x");
    const backgroundTasks = new Map<string, any>();
    backgroundTasks.set("t-hostile", {
      dir: hostileDir,
      sessionName: "task-t-hostile",
      agentType: "general",
      description: "hostile dir",
      startedAt: Date.now(),
      toolUses: 1,
      turns: 1,
      recentCalls: [],
    });
    const { context, getWidgetFactory } = createTuiContext();
    const controller = createTaskWidgetController(new Map(), backgroundTasks);
    controller.ensureTaskWidget(context);
    const widget = getWidgetFactory()?.({ requestRender: () => {} }, undefined) as {
      render: (width: number) => string[];
    };
    const lines = widget.render(100);
    const joined = lines.join("\n");
    assert.match(joined, /general/, "task row still renders");
    assert.doesNotMatch(joined, /render error/, "no render-error fallback line");
    controller.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
