/**
 * Child-view interaction parity: per-tool click expand, the configured
 * `app.tools.expand` toggle, effective editor/transcript settings, and
 * command-safe steering. Prompt-template completion/expansion is covered by
 * childPrompts.test.ts, which reloads the native file-backed resources without
 * loading extensions and uses Pi's native expansion implementation.
 *
 * The pane renders native pi components into lines, so click routing needs an
 * explicit line → component map (the overlay has no layout geometry of its
 * own). These tests pin that map, the click/drag distinction, the expansion
 * state surviving live item replacement, and that nothing mutates the host's
 * own tool-expansion setting.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { initTheme } from "@earendil-works/pi-coding-agent";
import { createTaskWidgetController } from "../src/lifecycle/widget.js";
import { createTaskTranscriptPane, type TaskTranscriptPane } from "../src/panel/task-pane.js";
import { TaskTranscriptOverlay, type SteerEditorLike } from "../src/panel/task-transcript-overlay.js";
import type { TranscriptItem } from "../src/panel/transcript.js";

const TUI = { terminal: { rows: 30, columns: 100 }, requestRender: () => {} } as never;

function toolItem(over: Partial<Extract<TranscriptItem, { type: "tool" }>> = {}): TranscriptItem {
  return {
    type: "tool",
    name: "bash",
    toolCallId: "call-1",
    args: { command: "echo hi" },
    result: Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"),
    timestamp: "",
    inProgress: false,
    ...over,
  };
}

function makePane(items: TranscriptItem[], opts: { outputPad?: number; toolsExpanded?: boolean } = {}) {
  initTheme();
  return createTaskTranscriptPane(
    TUI,
    { fg: (_style: string, text: string) => text } as never,
    {
      taskId: "t1",
      cwd: "/tmp",
      sig: () => "sig-1",
      read: () => items,
      ...opts,
    },
  );
}

test("pane maps a visible tool row to its component and the row inside it", () => {
  const items: TranscriptItem[] = [
    { type: "user", text: "do the thing", timestamp: "" },
    toolItem(),
  ];
  const pane = makePane(items);
  const lines = pane.render(80, 20);
  const hit = pane.hitTest?.(lines.length - 2);
  assert.ok(hit, `expected a tool hit, rendered ${lines.length} lines`);
  assert.equal(typeof hit.component.handleMouse, "function", "the hit is a native tool component");
  assert.ok(hit.y >= 0 && hit.y < hit.height, `local row ${hit.y} inside ${hit.height}`);
  assert.ok(hit.height > 0);
  pane.dispose();
});

test("pane hit-test ignores non-tool rows and rows outside the transcript", () => {
  const items: TranscriptItem[] = [
    { type: "user", text: "do the thing", timestamp: "" },
    { type: "assistant", text: "on it", timestamp: "" },
  ];
  const pane = makePane(items);
  const lines = pane.render(80, 20);
  for (let row = 0; row < lines.length; row++) {
    assert.equal(pane.hitTest?.(row), undefined, `row ${row} is not a tool row`);
  }
  assert.equal(pane.hitTest?.(lines.length + 5), undefined, "rows past the pane are not hits");
  pane.dispose();
});

test("pane drops stale hit geometry when its viewport has no rows", () => {
  const pane = makePane([toolItem()]);
  const previous = pane.render(80, 20);
  assert.ok(pane.hitTest?.(previous.length - 2), "the tool row is initially hit-testable");
  assert.deepEqual(pane.render(80, 0), [], "a zero-row viewport renders no transcript");
  assert.equal(pane.hitTest?.(previous.length - 2), undefined, "old rows are no longer clickable");
  pane.dispose();
});

test("pane hit-test follows the scroll window", () => {
  const items: TranscriptItem[] = [
    { type: "user", text: "first", timestamp: "" },
    toolItem(),
  ];
  // A collapsed tool fits entirely in the viewport, so scrolling cannot
  // change the row→component mapping. Expand it to exercise a real scroll.
  const pane = makePane(items, { toolsExpanded: true });
  const top = pane.render(80, 20);
  const beforeScroll = pane.hitTest?.(top.length - 2);
  pane.scrollBy(6);
  const scrolled = pane.render(80, 20);
  const afterScroll = pane.hitTest?.(scrolled.length - 2);
  assert.ok(beforeScroll, "the tool is clickable at the tail");
  assert.ok(afterScroll, "the tool stays clickable after scrolling");
  assert.notEqual(
    afterScroll.y,
    beforeScroll.y,
    "scrolling shifts which row of the tool the pointer lands on",
  );
  pane.dispose();
});

test("toggling tool expansion survives live item replacement", () => {
  let revision = 0;
  let items: TranscriptItem[] = [toolItem()];
  initTheme();
  const pane = createTaskTranscriptPane(
    TUI,
    { fg: (_style: string, text: string) => text } as never,
    { taskId: "t1", cwd: "/tmp", sig: () => String(revision), read: () => items },
  );
  const collapsed = pane.render(80, 24).length;
  assert.equal(pane.toggleToolsExpanded?.(), true, "the first toggle expands every tool row");
  const expanded = pane.render(80, 24).length;
  assert.ok(expanded > collapsed, `expanded (${expanded}) is taller than collapsed (${collapsed})`);

  // Live transcript updates replace the item objects; the state must persist.
  items = [
    toolItem({
      result: Array.from({ length: 30 }, (_, index) => `updated line ${index}`).join("\n"),
    }),
  ];
  revision++;
  const afterReplacement = pane.render(80, 24).length;
  assert.ok(afterReplacement > collapsed, "the replacement inherits the expanded state");
  assert.equal(pane.toggleToolsExpanded?.(), false, "toggling back collapses");
  assert.ok(
    pane.render(80, 24).length < afterReplacement,
    "the replaced item follows the pane's expansion state",
  );
  pane.dispose();
});

test("native tool click uses overlay coordinates, toggles only that row, and survives live replacement", () => {
  initTheme();
  const makePrefixedTool = (toolCallId: string, prefix: string): TranscriptItem =>
    toolItem({
      toolCallId,
      args: { command: `echo ${prefix}` },
      result: Array.from({ length: 30 }, (_, index) => `${prefix} line ${index}`).join("\n"),
    });
  let revision = 0;
  let items = [makePrefixedTool("call-a", "A"), makePrefixedTool("call-b", "B")];
  const pane = createTaskTranscriptPane(
    TUI,
    { fg: (_style: string, text: string) => text } as never,
    { taskId: "t-click", cwd: "/tmp", sig: () => String(revision), read: () => items },
  );
  const editor: SteerEditorLike = {
    handleInput() {},
    render: () => ["> "],
    getText: () => "",
    setText() {},
  };
  const overlay = new TaskTranscriptOverlay({
    pane,
    host: { taskId: "t-click", onSteer() {}, onClose() {}, requestRender() {} },
    theme: null,
    editor,
    terminalRows: () => 100,
  });

  try {
    const before = overlay.render(80);
    const clickRow = before.findIndex((line) => line.includes("A line 27"));
    assert.ok(clickRow >= 0, "the first tool result is visible in the overlay");
    const result = overlay.handleMouse?.(
      mouseEvent({ x: 6, y: clickRow, screenX: 6, screenY: clickRow, height: 100 }),
    );
    assert.equal(result?.handled, true, "the native result region consumes the click");

    const expanded = overlay.render(80).join("\n");
    assert.ok(expanded.includes("A line 0"), "the clicked tool expands to its earlier output");
    assert.ok(!expanded.includes("B line 0"), "the other tool stays collapsed");

    items = [makePrefixedTool("call-a", "A updated"), makePrefixedTool("call-b", "B updated")];
    revision++;
    const replaced = overlay.render(80).join("\n");
    assert.ok(replaced.includes("A updated line 0"), "the per-tool state follows a replacement item");
    assert.ok(!replaced.includes("B updated line 0"), "replacement does not expand unrelated tools");
  } finally {
    overlay.dispose();
  }
});

test("pane honours the effective transcript padding", () => {
  const items: TranscriptItem[] = [{ type: "user", text: "hello", timestamp: "" }];
  const padded = makePane(items, { outputPad: 1 });
  const flush = makePane(items, { outputPad: 0 });
  const paddedLine = padded.render(40, 6).find((line) => line.includes("hello")) ?? "";
  const flushLine = flush.render(40, 6).find((line) => line.includes("hello")) ?? "";
  assert.ok(paddedLine, "the padded pane renders the message");
  assert.ok(flushLine, "the flush pane renders the message");
  assert.notEqual(
    paddedLine.indexOf("hello"),
    flushLine.indexOf("hello"),
    "outputPad changes the message indentation",
  );
  padded.dispose();
  flush.dispose();
});

test("task view receives effective Pi editor and transcript padding settings", () => {
  initTheme();
  const taskId = "t-settings";
  const task = {
    agentType: "general",
    sessionName: "settings",
    originalPane: null,
    description: "settings test",
    startedAt: Date.now(),
    toolUses: 0,
    turns: 0,
    recentCalls: [],
    dir: "/tmp/pi-task-settings-test",
    cwd: "/tmp",
    backend: "durable",
    status: "running",
  };

  const renderWithSettings = (settings: { editorPaddingX: number; outputPad: 0 | 1 }) => {
    let factory: ((tui: unknown, theme: unknown, keys: unknown, done: () => void) => TaskTranscriptOverlay) | undefined;
    const context = {
      mode: "tui",
      hasUI: true,
      cwd: "/tmp",
      ui: {
        getEditorComponent: () => undefined,
        setEditorComponent: () => {},
        setWidget: () => {},
        notify: () => {},
        custom: (make: typeof factory) => {
          factory = make;
          return new Promise<unknown>(() => {});
        },
      },
    } as never;
    const controller = createTaskWidgetController(
      new Map([[taskId, task as never]]),
      new Map(),
      { getDisplaySettings: () => settings, steerTask: () => null, stopTask: () => null },
    );
    controller.ensureTaskWidget(context);
    controller.setLiveTranscript(taskId, [{ type: "user", text: "padding marker", timestamp: "" }]);
    controller.openTaskView(taskId);
    assert.ok(factory, "the task view registered its overlay factory");
    const overlay = factory(
      { terminal: { rows: 40, columns: 80 }, requestRender: () => {} },
      { fg: (_token: string, text: string) => text, bg: (_token: string, text: string) => text },
      { matches: () => false },
      () => {},
    );
    overlay.handleInput("X");
    const lines = overlay.render(80).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
    const messageLine = lines.find((line) => line.includes("padding marker")) ?? "";
    const inputLine = lines.find((line) => line.includes("X")) ?? "";
    const result = {
      messageColumn: messageLine.indexOf("padding marker"),
      inputColumn: inputLine.indexOf("X"),
    };
    overlay.dispose();
    controller.dispose();
    return result;
  };

  const defaults = renderWithSettings({ editorPaddingX: 0, outputPad: 1 });
  const configured = renderWithSettings({ editorPaddingX: 2, outputPad: 0 });
  assert.notEqual(configured.messageColumn, defaults.messageColumn, "outputPad reaches the transcript renderer");
  assert.equal(configured.inputColumn - defaults.inputColumn, 2, "editorPaddingX reaches the embedded editor");
});

interface FakePaneOptions {
  hit?: {
    component: { handleMouse(event: unknown): { handled?: boolean } | undefined };
    y: number;
    height: number;
  } | undefined;
  lines?: string[];
}

function makeOverlay(
  options: {
    pane?: FakePaneOptions;
    keybindings?: { matches(data: string, action: string): boolean };
  } = {},
) {
  const calls = { scrolled: [] as number[], toggles: 0, renders: 0, steers: [] as string[], editorKeys: [] as string[] };
  const pane: TaskTranscriptPane = {
    scrollBy: (delta) => calls.scrolled.push(delta),
    render: (width: number) => (options.pane?.lines ?? ["row-0", "row-1"]).map((l) => l.padEnd(width)),
    invalidate: () => {},
    dispose: () => {},
    ...(options.pane && "hit" in options.pane ? { hitTest: () => options.pane?.hit } : {}),
    toggleToolsExpanded: () => {
      calls.toggles += 1;
      return true;
    },
  };
  let editorText = "";
  const editor: SteerEditorLike = {
    handleInput: (data) => {
      calls.editorKeys.push(data);
      editorText += data;
    },
    render: (width: number) => [`> ${editorText}`.padEnd(width)],
    getText: () => editorText,
    setText: (text) => {
      editorText = text;
    },
  };
  const overlay = new TaskTranscriptOverlay({
    pane,
    host: {
      taskId: "t1",
      onSteer: (text) => calls.steers.push(text),
      onClose: () => {},
      requestRender: () => {
        calls.renders += 1;
      },
    },
    theme: null,
    editor,
    terminalRows: () => 30,
    ...(options.keybindings ? { keybindings: options.keybindings } : {}),
  });
  return { overlay, calls, pane };
}

function mouseEvent(over: Record<string, unknown>) {
  return {
    type: "click",
    button: "left",
    x: 5,
    y: 0,
    screenX: 5,
    screenY: 0,
    width: 80,
    height: 30,
    shift: false,
    alt: false,
    ctrl: false,
    ...over,
  } as never;
}

test("a click routes to the tool under the pointer and is consumed", () => {
  const clicks: unknown[] = [];
  const { overlay, calls } = makeOverlay({
    pane: {
      lines: ["row-0", "row-1"],
      hit: {
        component: {
          handleMouse: (event: unknown) => {
            clicks.push(event);
            return { handled: true };
          },
        },
        y: 3,
        height: 9,
      },
    },
  });
  overlay.render(80);
  const result = overlay.handleMouse?.(mouseEvent({ y: 1, screenY: 17, screenX: 23 }));
  assert.deepEqual(result, { handled: true }, "the overlay consumes the tool click");
  assert.equal(clicks.length, 1, "the tool component received the click");
  const forwarded = clicks[0] as { x: number; y: number; width: number; height: number; screenX: number; screenY: number };
  assert.deepEqual(
    { x: forwarded.x, y: forwarded.y, width: forwarded.width, height: forwarded.height },
    { x: 4, y: 3, width: 78, height: 9 },
    "local coordinates include the Box's horizontal inset and the row inside the native component",
  );
  assert.equal(forwarded.screenX, 23, "absolute x survives retargeting");
  assert.equal(forwarded.screenY, 17, "absolute y survives retargeting");
  assert.equal(calls.renders, 1, "the view repaints after a toggle");
  overlay.dispose();
});

test("clicks that miss a tool, and every drag, stay with the host", () => {
  const { overlay, calls } = makeOverlay({ pane: { lines: ["row-0"], hit: undefined } });
  overlay.render(80);
  assert.equal(overlay.handleMouse?.(mouseEvent({ y: 0 })), undefined, "a miss is not consumed");
  assert.equal(overlay.handleMouse?.(mouseEvent({ x: 0, y: 0 })), undefined, "the Box's left padding is not a tool hit");
  assert.equal(calls.renders, 0, "a miss does not repaint");

  const toolClicks: unknown[] = [];
  const withTool = makeOverlay({
    pane: {
      lines: ["row-0"],
      hit: { component: { handleMouse: (e: unknown) => (toolClicks.push(e), { handled: true }) }, y: 0, height: 4 },
    },
  });
  withTool.overlay.render(80);
  for (const type of ["press", "drag", "release", "move"]) {
    assert.equal(
      withTool.overlay.handleMouse?.(mouseEvent({ type, y: 0 })),
      undefined,
      `${type} is left to the host so text selection keeps working`,
    );
  }
  assert.equal(toolClicks.length, 0, "no component saw a drag");
  withTool.overlay.dispose();
  overlay.dispose();
});

test("wheel scrolling still belongs to the overlay", () => {
  const { overlay, calls } = makeOverlay();
  overlay.render(80);
  assert.deepEqual(overlay.handleMouse?.(mouseEvent({ type: "wheel", button: "none", wheelDelta: -5 })), {
    handled: true,
  });
  assert.deepEqual(calls.scrolled, [5]);
  overlay.dispose();
});

test("slash-like text is steered verbatim instead of invoking parent or child commands", () => {
  const { overlay, calls } = makeOverlay();
  for (const text of ["/model", "/compact", "/quit"]) {
    overlay.handleInput(text);
    overlay.handleInput("\r");
  }
  assert.deepEqual(calls.steers, ["/model", "/compact", "/quit"]);
  overlay.dispose();
});

test("child built-ins are dispatched to the viewed child, unsafe commands are denied, and stale results are ignored", async () => {
  initTheme();
  const root = mkdtempSync(join(tmpdir(), "pi-task-child-command-view-"));
  mkdirSync(join(root, ".pi", "prompts"), { recursive: true });
  writeFileSync(
    join(root, ".pi", "prompts", "model.md"),
    "This same-named template must never shadow the native child /model command.",
    "utf8",
  );
  const taskId = "sdk-command-task";
  const task = {
    agentType: "general",
    sessionName: "sdk-command",
    originalPane: null,
    description: "command routing test",
    startedAt: Date.now(),
    toolUses: 0,
    turns: 0,
    recentCalls: [],
    dir: root,
    cwd: root,
    backend: "sdk",
    status: "running",
  };
  let factory: ((tui: unknown, theme: unknown, keys: unknown, done: () => void) => TaskTranscriptOverlay) | undefined;
  const notices: Array<{ message: string; level: string }> = [];
  const context = {
    mode: "tui",
    hasUI: true,
    cwd: root,
    isProjectTrusted: () => true,
    ui: {
      getEditorComponent: () => undefined,
      setEditorComponent: () => {},
      setWidget: () => {},
      notify: (message: string, level: string) => notices.push({ message, level }),
      custom: (make: typeof factory) => {
        factory = make;
        return new Promise<unknown>(() => {});
      },
    },
  } as never;
  const childCommands: string[] = [];
  const parentSteering: string[] = [];
  let releaseLateCommand!: () => void;
  const lateCommand = new Promise<void>((resolve) => { releaseLateCommand = resolve; });
  let lateCommandStarted!: () => void;
  const commandStarted = new Promise<void>((resolve) => { lateCommandStarted = resolve; });
  const controller = createTaskWidgetController(
    new Map([[taskId, task as never]]),
    new Map(),
    {
      getCommands: () => [],
      getPromptAgentDir: () => join(root, "agent"),
      runChildBuiltinCommand: async (_task: unknown, _id: string, command: { name: string; rawText: string }) => {
        childCommands.push(command.rawText);
        if (command.name === "thinking") {
          lateCommandStarted();
          await lateCommand;
        }
        return { level: "info", message: `child ran ${command.rawText}` };
      },
      steerTask: (_task, _id, text) => {
        parentSteering.push(text);
        return null;
      },
      stopTask: () => null,
    } as never,
  );
  try {
    controller.ensureTaskWidget(context);
    controller.openTaskView(taskId);
    assert.ok(factory, "the child transcript overlay was created");
    const overlay = factory(
      { terminal: { rows: 30, columns: 90 }, requestRender: () => {} },
      { fg: (_token: string, text: string) => text, bg: (_token: string, text: string) => text },
      { matches: () => false },
      () => {},
    );
    const editor = (overlay as unknown as {
      editor: { setText(text: string): void; isShowingAutocomplete?: () => boolean };
    }).editor;
    editor.isShowingAutocomplete = () => false;

    const submit = (text: string) => {
      editor.setText(text);
      overlay.handleInput("\r");
    };
    submit("/model openai/gpt-test");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(childCommands, ["/model openai/gpt-test"]);
    assert.deepEqual(parentSteering, [], "a Pi built-in never reaches the parent-steering path");
    assert.ok(notices.some(({ message, level }) => level === "info" && message.includes("child ran")));

    submit("/logout openai");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(childCommands, ["/model openai/gpt-test"], "credential commands never reach the child");
    assert.deepEqual(parentSteering, [], "credential commands never reach the parent");
    assert.ok(notices.some(({ message, level }) => level === "error" && /credential/i.test(message)));

    submit("/thinking high");
    await Promise.race([
      commandStarted,
      new Promise((_, reject) => setTimeout(() => reject(new Error("child command did not start")), 1000)),
    ]);
    controller.closeTaskView(taskId);
    const noticeCount = notices.length;
    releaseLateCommand();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(notices.length, noticeCount, "a command result from a closed view is not shown in a stale UI");
    assert.deepEqual(parentSteering, []);
    overlay.dispose();
  } finally {
    controller.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the configured app.tools.expand key toggles every tool and never reaches the editor", () => {
  const { overlay, calls } = makeOverlay({
    keybindings: { matches: (data: string, action: string) => action === "app.tools.expand" && data === "CTRL_O" },
  });
  overlay.render(80);
  overlay.handleInput("CTRL_O");
  assert.equal(calls.toggles, 1, "the pane toggled its tool rows");
  assert.deepEqual(calls.editorKeys, [], "the editor never saw the expand key");
  assert.equal(calls.renders, 1, "the toggle repaints the view");

  overlay.handleInput("x");
  assert.deepEqual(calls.editorKeys, ["x"], "other keys still edit the steer prompt");
  overlay.dispose();
});
