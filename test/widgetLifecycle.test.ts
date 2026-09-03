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

test("transcript view sig/read survive a hostile session dir", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-widget-pane-"));
  try {
    // `dir` is a FILE, so transcriptSig/readTaskTranscript underneath throw.
    const hostileDir = join(root, "not-a-dir");
    writeFileSync(hostileDir, "x");
    const backgroundTasks = new Map<string, any>();
    backgroundTasks.set("t-hostile", {
      dir: hostileDir,
      sessionName: "task-t-hostile",
      agentType: "general",
      description: "hostile dir",
      startedAt: Date.now(),
      toolUses: 0,
      turns: 0,
      recentCalls: [],
      backend: "tmux",
    });
    // sdk transcriptDir is task.dir itself, so a FILE dir makes sig()/read()
    // actually throw (ENOTDIR) through the guarded closures — the tmux task
    // above only exercises the not-found short-circuit.
    backgroundTasks.set("t-sdk", {
      dir: hostileDir,
      sessionName: "task-t-sdk",
      agentType: "general",
      description: "sdk hostile dir",
      startedAt: Date.now(),
      toolUses: 0,
      turns: 0,
      recentCalls: [],
      backend: "sdk",
    });

    const widgets = new Map<string, any>();
    let editorFactory: ((tui: any, theme: any, kb: any) => any) | undefined;
    const context = {
      mode: "tui",
      hasUI: true,
      cwd: root,
      ui: {
        setWidget(name: string, value: unknown) {
          widgets.set(name, value);
        },
        getEditorComponent() {
          return undefined;
        },
        setEditorComponent(factory: any) {
          editorFactory = factory;
        },
        notify() {},
      },
    } as any;

    const controller = createTaskWidgetController(new Map(), backgroundTasks);
    controller.ensureTaskWidget(context);
    assert.ok(editorFactory, "editor factory installed");

    // Construct the panel editor (Editor's constructor only stores these) and
    // reach the host to open the transcript view the way Enter on a row does.
    const fakeTui = { terminal: { rows: 40 } };
    const editor = editorFactory!(fakeTui, { borderColor: "#000" }, {});
    const host = (editor as unknown as { host: { onEnter(id: string | null): void } })
      .host;
    host.onEnter("t-hostile");

    const paneFactory = widgets.get("task-transcript");
    assert.ok(typeof paneFactory === "function", "transcript pane registered");
    const fakeTheme = { fg: (_style: string, text: string) => text };
    const lines = paneFactory(fakeTui, fakeTheme).render(80);
    assert.ok(Array.isArray(lines), "tmux not-found path renders");

    const paneSdk = widgets.get("task-transcript");
    assert.ok(typeof paneSdk === "function", "sdk transcript pane registered");
    void paneSdk; // replaced per openView call; re-open for the sdk task
    const editor2 = editorFactory!(fakeTui, { borderColor: "#000" }, {});
    const host2 = (editor2 as unknown as { host: { onEnter(id: string | null): void } }).host;
    host2.onEnter("t-sdk");
    const paneFactorySdk = widgets.get("task-transcript");
    const linesSdk = paneFactorySdk(fakeTui, fakeTheme).render(80);
    assert.ok(Array.isArray(linesSdk), "sdk ENOTDIR path renders without throwing");
    controller.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
