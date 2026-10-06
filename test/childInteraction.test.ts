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
import { visibleWidth } from "@earendil-works/pi-tui";
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
  const replacementTaskId = "sdk-replacement-command-task";
  const replacementTask = {
    ...task,
    sessionName: "sdk-replacement-command",
    description: "replacement command view",
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
    new Map([[taskId, task as never], [replacementTaskId, replacementTask as never]]),
    new Map(),
    {
      getCommands: () => [],
      getPromptAgentDir: () => join(root, "agent"),
      runChildBuiltinCommand: async (_task: unknown, _id: string, command: { name: string; argument: string; rawText: string }) => {
        childCommands.push(command.rawText);
        if (command.rawText === "/thinking high") {
          lateCommandStarted();
          await lateCommand;
        }
        if (command.argument === "openai/broken") {
          return { level: "error", message: "Child model update failed." };
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
    const renderedOverlay = () => overlay.render(90).join("\n");
    submit("/model openai/gpt-test");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(childCommands, ["/model openai/gpt-test"]);
    assert.deepEqual(parentSteering, [], "a Pi built-in never reaches the parent-steering path");
    assert.match(renderedOverlay(), /child ran \/model openai\/gpt-test/, "the child result is rendered inside its overlay");
    assert.deepEqual(notices, [], "a child command result never uses the parent notification surface");

    submit("/thinking medium");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.match(renderedOverlay(), /child ran \/thinking medium/, "the child thinking result is rendered in its overlay");
    assert.deepEqual(notices, [], "a child thinking result never uses the parent notification surface");

    submit("/model openai/broken");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(childCommands, ["/model openai/gpt-test", "/thinking medium", "/model openai/broken"]);
    assert.match(renderedOverlay(), /Child model update failed/, "child execution errors are rendered inside the overlay");
    assert.deepEqual(notices, [], "a child command error never uses the parent notification surface");

    submit("/logout openai");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(
      childCommands,
      ["/model openai/gpt-test", "/thinking medium", "/model openai/broken"],
      "credential commands never reach the child",
    );
    assert.deepEqual(parentSteering, [], "credential commands never reach the parent");
    assert.match(renderedOverlay(), /credential/i, "child command denials are rendered inside the overlay");
    assert.deepEqual(notices, [], "a child command denial never uses the parent notification surface");

    submit("/thinking high");
    await Promise.race([
      commandStarted,
      new Promise((_, reject) => setTimeout(() => reject(new Error("child command did not start")), 1000)),
    ]);
    controller.closeTaskView(taskId);
    controller.openTaskView(replacementTaskId);
    assert.ok(factory, "a different child view can be opened");
    const replacementOverlay = factory(
      { terminal: { rows: 30, columns: 90 }, requestRender: () => {} },
      { fg: (_token: string, text: string) => text, bg: (_token: string, text: string) => text },
      { matches: () => false },
      () => {},
    );
    assert.doesNotMatch(
      replacementOverlay.render(90).join("\n"),
      /credential|child ran/,
      "view-local feedback is cleared when the child view is reopened",
    );
    const noticeCount = notices.length;
    releaseLateCommand();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(notices.length, noticeCount, "a stale command result never reaches the parent notification surface");
    assert.doesNotMatch(
      replacementOverlay.render(90).join("\n"),
      /child ran \/thinking high/,
      "a command finishing for the previous view cannot replace feedback in the new view",
    );
    assert.deepEqual(parentSteering, []);
    overlay.dispose();
    replacementOverlay.dispose();
  } finally {
    controller.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a settled child can open read-only /session info but cannot mutate or steer", async () => {
  initTheme();
  const root = mkdtempSync(join(tmpdir(), "pi-task-settled-session-info-"));
  const taskId = "sdk-settled-session-task";
  const sessionPath = join(root, "settled-child.jsonl");
  const usage = {
    input: 10,
    output: 20,
    cacheRead: 30,
    cacheWrite: 40,
    totalTokens: 30,
    cost: { input: 0.004, output: 0.006, cacheRead: 0, cacheWrite: 0, total: 0.01 },
  };
  writeFileSync(sessionPath, [
    JSON.stringify({ type: "session", id: "settled-session-id", cwd: root }),
    JSON.stringify({ type: "session_info", name: "settled child" }),
    JSON.stringify({ type: "model_change", provider: "openai", modelId: "gpt-test" }),
    JSON.stringify({ type: "thinking_level_change", thinkingLevel: "high" }),
    JSON.stringify({ type: "message", message: { role: "user", content: "task" } }),
    JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }], usage } }),
  ].join("\n"));
  const task = {
    agentType: "general",
    sessionName: "settled child",
    originalPane: null,
    description: "settled session info test",
    startedAt: Date.now() - 1000,
    toolUses: 2,
    turns: 1,
    recentCalls: [],
    dir: root,
    cwd: root,
    sessionPath,
    backend: "sdk",
    status: "done",
  };
  const commands: string[] = [];
  const steers: string[] = [];
  let factory: ((tui: unknown, theme: unknown, keys: unknown, done: () => void) => TaskTranscriptOverlay) | undefined;
  const context = {
    mode: "tui",
    hasUI: true,
    cwd: root,
    isProjectTrusted: () => true,
    ui: {
      getEditorComponent: () => undefined,
      setEditorComponent: () => {},
      setWidget: () => {},
      notify() {},
      custom: (make: typeof factory) => {
        factory = make;
        return new Promise<unknown>(() => {});
      },
    },
  } as never;
  const controller = createTaskWidgetController(new Map(), new Map([[taskId, task as never]]), {
    getCommands: () => [],
    runChildBuiltinCommand: async (_task, _id, command) => {
      commands.push(command.rawText);
      return {
        level: "info",
        message: "Session information",
        sessionInfo: {
          sessionId: "settled-session-id",
          sessionName: "settled child",
          model: "openai/gpt-test",
          thinkingLevel: "high",
          cwd: root,
          counts: {
            scope: "session",
            userMessages: 1,
            assistantMessages: 1,
            toolCalls: 0,
            toolResults: 0,
            totalMessages: 2,
          },
          tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, total: 100 },
          cost: 0.01,
        },
      } as never;
    },
    steerTask: (_task, _id, text) => { steers.push(text); return null; },
    stopTask: () => null,
  } as never);

  try {
    controller.ensureTaskWidget(context);
    controller.openTaskView(taskId);
    assert.ok(factory);
    const overlay = factory(
      { terminal: { rows: 24, columns: 80 }, requestRender() {} },
      { fg: (_token: string, text: string) => text, bg: (_token: string, text: string) => text },
      { matches: () => false },
      () => {},
    );
    const editor = (overlay as unknown as { editor: { setText(text: string): void } }).editor;
    const submit = (text: string) => { editor.setText(text); overlay.handleInput("\r"); };
    submit("/session");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(commands, [], "settled session inspection reads the child's durable JSONL instead of a disposed SDK handle");
    assert.match(overlay.render(80).join("\n"), /settled-session-id/);
    for (let page = 0; page < 3; page++) overlay.handleInput("\x1b[6~");
    assert.match(overlay.render(80).join("\n"), /Cache read/);

    submit("/thinking high");
    submit("please continue");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(commands, [], "settled-child mutation is not dispatched");
    assert.deepEqual(steers, [], "settled-child steering is not dispatched");
    overlay.dispose();
  } finally {
    controller.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("settled durable /resume browses attributed history without resuming or steering a task", async () => {
  initTheme();
  const root = mkdtempSync(join(tmpdir(), "pi-task-settled-resume-history-"));
  mkdirSync(join(root, ".pi", "prompts"), { recursive: true });
  const taskId = "durable-settled-current";
  const task = {
    agentType: "general",
    sessionName: "durable current",
    originalPane: null,
    description: "settled durable history browser",
    startedAt: Date.now() - 1000,
    toolUses: 1,
    turns: 1,
    recentCalls: [],
    dir: root,
    piDir: root,
    cwd: root,
    backend: "durable",
    conversationId: "current-conversation",
    ownerSessionId: "parent-session",
    ownerLeafId: "parent-leaf",
    status: "done",
  };
  const option = {
    taskId: "durable-old-child",
    agentType: "reviewer",
    description: "old review",
    sessionName: "old review session",
    status: "done",
    cwd: root,
    startedAt: Date.now() - 2000,
  };
  const commands: string[] = [];
  const historyReads: string[] = [];
  const steers: string[] = [];
  let factory: ((tui: unknown, theme: unknown, keys: unknown, done: () => void) => TaskTranscriptOverlay) | undefined;
  const context = {
    mode: "tui",
    hasUI: true,
    cwd: root,
    isProjectTrusted: () => true,
    ui: {
      getEditorComponent: () => undefined,
      setEditorComponent: () => {},
      setWidget: () => {},
      notify() {},
      custom: (make: typeof factory) => {
        factory = make;
        return new Promise<unknown>(() => {});
      },
    },
  } as never;
  const controller = createTaskWidgetController(new Map(), new Map([[taskId, task as never]]), {
    getCommands: () => [],
    getPromptAgentDir: () => join(root, "agent"),
    runChildBuiltinCommand: async (_task, _id, command) => {
      commands.push(command.rawText);
      return {
        level: "info",
        message: "history picker",
        historyPicker: { currentTaskId: taskId, sessions: [option] },
      } as never;
    },
    readDurableChildHistory: async (_task, currentTaskId, selectedTaskId) => {
      historyReads.push(`${currentTaskId}:${selectedTaskId}`);
      return {
        option,
        items: [
          { type: "user", text: "old prompt", timestamp: "2026-01-01T00:00:00.000Z" },
          { type: "assistant", text: "old durable transcript", timestamp: "2026-01-01T00:00:01.000Z" },
        ],
        agent: { cwd: root, model: "openai/gpt-test", thinkingLevel: "high" },
      };
    },
    steerTask: (_task, _id, text) => { steers.push(text); return null; },
    stopTask: () => { assert.fail("browsing durable history must not stop a task"); },
  } as never);

  const waitFor = async (predicate: () => boolean) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail("timed out waiting for durable history navigation");
  };
  try {
    controller.ensureTaskWidget(context);
    controller.openTaskView(taskId);
    assert.ok(factory);
    const overlay = factory(
      { terminal: { rows: 24, columns: 80 }, requestRender() {} },
      { fg: (_token: string, text: string) => text, bg: (_token: string, text: string) => text },
      { matches: () => false },
      () => {},
    );
    const editor = (overlay as unknown as { editor: { setText(text: string): void } }).editor;
    const submit = (text: string) => { editor.setText(text); overlay.handleInput("\r"); };
    submit("/resume");
    await waitFor(() => overlay.render(80).join("\n").includes("Browse Durable Child History"));
    assert.deepEqual(commands, ["/resume"]);
    overlay.handleInput("\r");
    await waitFor(() => overlay.render(80).join("\n").includes("old durable transcript"));
    assert.deepEqual(historyReads, [`${taskId}:durable-old-child`]);
    assert.deepEqual(steers, [], "the history selection is not steered into the current or selected task");
    assert.equal(task.status, "done", "browsing does not alter the settled task lifecycle");

    overlay.handleInput("\x1b");
    assert.match(overlay.render(80).join("\n"), /enter steer/, "Escape returns to the original child view");
    submit("/thinking high");
    submit("continue working");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(commands, ["/resume"], "settled-child controls stay read-only after browsing");
    assert.deepEqual(steers, []);
    overlay.dispose();
  } finally {
    controller.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("no-argument child model and thinking commands open searchable child-local pickers", async () => {
  initTheme();
  const root = mkdtempSync(join(tmpdir(), "pi-task-child-selectors-"));
  mkdirSync(join(root, ".pi", "prompts"), { recursive: true });
  const taskId = "sdk-selector-task";
  const task = {
    agentType: "general",
    sessionName: "sdk-selector",
    originalPane: null,
    description: "child selector test",
    startedAt: Date.now(),
    toolUses: 0,
    turns: 0,
    recentCalls: [],
    dir: root,
    cwd: root,
    backend: "sdk",
    status: "running",
  };
  const commandCalls: string[] = [];
  const notices: Array<{ message: string; level: string }> = [];
  const terminal = { rows: 30, columns: 90 };
  let factory: ((tui: unknown, theme: unknown, keys: unknown, done: () => void) => TaskTranscriptOverlay) | undefined;
  let closes = 0;
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
  let selectedModel = "openai/gpt-1";
  let selectedThinking = "off";
  const controller = createTaskWidgetController(new Map([[taskId, task as never]]), new Map(), {
    getCommands: () => [],
    getPromptAgentDir: () => join(root, "agent"),
    runChildBuiltinCommand: async (_task, _id, command) => {
      commandCalls.push(command.rawText);
      if (command.name === "model" && !command.argument) {
        return {
          level: "info",
          message: "child model picker",
          selector: {
            kind: "model",
            currentModel: { provider: "openai", id: selectedModel.split("/")[1] },
            models: [
              { provider: "openai", id: "gpt-1", name: "GPT One" },
              { provider: "openai", id: "gpt-2", name: "GPT Two" },
              {
                provider: "provider-with-a-readable-long-name",
                id: "model-with-a-readable-long-identifier-2026",
                name: "Long Model",
              },
            ],
          },
        } as never;
      }
      if (command.name === "thinking" && !command.argument) {
        return {
          level: "info",
          message: "child thinking picker",
          selector: {
            kind: "thinking",
            currentLevel: selectedThinking,
            levels: ["off", "minimal", "low", "medium", "high"],
          },
        } as never;
      }
      if (command.name === "model") selectedModel = command.argument;
      if (command.name === "thinking") selectedThinking = command.argument;
      return { level: "info", message: `child selected ${command.rawText}` };
    },
    steerTask: () => {
      assert.fail("a child selector choice must not use the steering path");
    },
    stopTask: () => null,
  } as never);

  const waitFor = async (predicate: () => boolean) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail("timed out waiting for child selector state");
  };
  const makeMountedOverlay = () => {
    assert.ok(factory, "the child transcript overlay was created");
    const overlay = factory(
      { terminal, requestRender: () => {} },
      { fg: (_token: string, text: string) => text, bg: (_token: string, text: string) => text },
      { matches: () => false },
      () => { closes++; },
    );
    const editor = (overlay as unknown as { editor: { setText(text: string): void } }).editor;
    (editor as { isShowingAutocomplete?: () => boolean }).isShowingAutocomplete = () => false;
    return { overlay, editor };
  };

  try {
    controller.ensureTaskWidget(context);
    controller.openTaskView(taskId);
    const { overlay, editor } = makeMountedOverlay();
    const render = () => overlay.render(90).join("\n");
    const submit = (text: string) => {
      editor.setText(text);
      overlay.handleInput("\r");
    };

    submit("/model");
    await waitFor(() => /GPT Two/.test(render()));
    const modelPicker = (
      overlay as unknown as {
        childSelector: { focused: boolean; searchInput: { focused: boolean } };
      }
    ).childSelector;
    assert.equal(modelPicker.focused, true, "keyboard focus moves to the active child selector");
    assert.equal(modelPicker.searchInput.focused, true, "the selector's search input owns the cursor");
    assert.equal((editor as { focused?: boolean }).focused, false, "the hidden steer editor is not focused during selection");
    assert.match(render(), /Ctrl\+S[\s\S]*disabled[\s\S]*affects only this child/i, "model picker explains child-only default behavior");
    assert.deepEqual(commandCalls, ["/model"], "opening a picker only reads structured child state");
    const fullModelScreen = overlay.render(90);
    assert.equal(fullModelScreen.length, terminal.rows, "the model picker masks the full terminal height");
    assert.ok(fullModelScreen.every((line) => visibleWidth(line) === 90), "the model picker paints opaque full-width rows with no parent bleed");
    terminal.columns = 150;
    const wideModelScreen = overlay.render(150).join("\n");
    assert.match(wideModelScreen, /provider-with-a-readable-long-name\/model-with-a-readable-long-identifier-2026/, "wide model rows show the complete provider/model reference");
    terminal.columns = 90;
    terminal.rows = 10;
    const narrowPicker = overlay.render(40);
    assert.equal(narrowPicker.length, 10, "the selector respects the available row count");
    assert.ok(narrowPicker.every((line) => visibleWidth(line) <= 40), "the selector fits a narrow terminal width");
    terminal.rows = 30;
    assert.equal(overlay.render(90).length, terminal.rows, "resizing back restores a full-height model mask");
    overlay.handleInput("\x13");
    assert.deepEqual(commandCalls, ["/model"], "Ctrl+S cannot select or save a shared default");
    for (const character of "two") overlay.handleInput(character);
    assert.match(render(), /GPT Two/);
    assert.doesNotMatch(render(), /GPT One/, "the model catalog is searchable by model name");
    overlay.handleInput("\r");
    await waitFor(() => selectedModel === "openai/gpt-2");
    assert.deepEqual(commandCalls, ["/model", "/model openai/gpt-2"]);
    assert.equal((editor as { focused?: boolean }).focused, true, "selecting a model restores focus to the child editor");
    assert.equal(closes, 0, "selecting a model stays in the child transcript view");
    assert.deepEqual(notices, [], "child selector operations never notify in the parent UI");

    submit("/model");
    await waitFor(() => /GPT One/.test(render()));
    for (const character of "gpt") overlay.handleInput(character);
    assert.match(render(), /GPT One/);
    assert.match(render(), /GPT Two/, "the filtered model catalog keeps all fuzzy matches");
    overlay.handleInput("\x1b[B");
    overlay.handleInput("\r");
    await waitFor(() => selectedModel === "openai/gpt-1");
    assert.deepEqual(commandCalls.slice(-2), ["/model", "/model openai/gpt-1"], "arrow navigation selects within the child catalog");

    submit("/thinking");
    await waitFor(() => /Thinking Level/.test(render()));
    const fullThinkingScreen = overlay.render(90);
    assert.equal(fullThinkingScreen.length, terminal.rows, "the thinking picker masks the full terminal height");
    assert.doesNotMatch(fullThinkingScreen.join("\n"), /~\d+k tokens|\d+k tokens/, "thinking help does not invent token budgets");
    overlay.handleInput("\x1b");
    assert.equal(closes, 0, "Escape cancels the picker before it can close the child view");
    assert.equal(selectedThinking, "off", "cancelling the thinking picker makes no mutation");
    assert.doesNotMatch(render(), /Thinking Level/, "Escape returns to the child editor");

    submit("/thinking");
    await waitFor(() => /Thinking Level/.test(render()));
    for (const character of "high") overlay.handleInput(character);
    assert.match(render(), /high/);
    assert.doesNotMatch(render(), /minimal|medium/, "thinking search filters to supported canonical choices");
    assert.match(render(), /Ctrl\+S[\s\S]*disabled[\s\S]*affects only this child/i, "thinking picker explains child-only default behavior");
    overlay.handleInput("\r");
    await waitFor(() => selectedThinking === "high");
    assert.deepEqual(commandCalls.slice(-2), ["/thinking", "/thinking high"]);

    submit("/model");
    await waitFor(() => /GPT Two/.test(render()));
    task.status = "done";
    for (const character of "two") overlay.handleInput(character);
    overlay.handleInput("\r");
    await waitFor(() => /read-only/.test(render()));
    assert.equal(selectedModel, "openai/gpt-1", "a selection after settlement cannot mutate the child");
    assert.equal(commandCalls.at(-1), "/model", "late selection is refused before reaching the child API");
    assert.deepEqual(notices, [], "settled-child feedback stays inside its view");
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

test("completed historical tools do not show a synthetic Took duration", () => {
  const items: TranscriptItem[] = [toolItem()];
  const pane = makePane(items);
  const lines = pane.render(80, 20).join("\n");
  assert.equal(/Took\s/.test(lines), false, "no synthetic Took on a completed historical tool");
  assert.ok(lines.includes("echo hi"), "the command row still renders");
  pane.dispose();
});

test("in-progress tools with partial output keep their Elapsed ticker", () => {
  const items: TranscriptItem[] = [toolItem({ inProgress: true })];
  const pane = makePane(items);
  const lines = pane.render(80, 20);
  assert.ok(/Elapsed\s/.test(lines.join("\n")), "a running tool with partial output still shows Elapsed");
  // The bash renderer keeps a 1s Elapsed interval while partial; settle the
  // component so the interval cannot hold the test process open.
  for (let row = lines.length - 1; row >= 0; row--) {
    const hit = pane.hitTest?.(row);
    if (hit) {
      (hit.component as unknown as {
        updateResult?: (result: unknown, isPartial: boolean) => void;
      }).updateResult?.({ content: [{ type: "text", text: "done" }], details: {} }, false);
      break;
    }
  }
  pane.dispose();
});

test("settled tools render their real persisted duration via the built-in Took line", () => {
  const items: TranscriptItem[] = [toolItem({
    startedAt: Date.parse("2026-10-06T00:00:00Z"),
    endedAt: Date.parse("2026-10-06T00:00:01.5Z"),
  })];
  const pane = makePane(items);
  const lines = pane.render(80, 20).join("\n");
  assert.ok(/Took 1\.5s/.test(lines), `expected a real Took duration, got: ${lines.slice(-200)}`);
  pane.dispose();
});

test("settled tools without persisted timings stay silent instead of showing 0.0s", () => {
  const items: TranscriptItem[] = [toolItem()];
  const pane = makePane(items);
  const lines = pane.render(80, 20).join("\n");
  assert.equal(/Took\s/.test(lines), false, "no fabricated duration without timings");
  pane.dispose();
});
