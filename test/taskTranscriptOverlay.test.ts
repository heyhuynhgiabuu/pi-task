/**
 * The transcript view is a full-screen modal (`ctx.ui.custom` with
 * `overlay: true`) that shows ONLY the viewed task's transcript — the main
 * conversation stays behind it. Keys: ↑↓/pgup/pgdn scroll the pane (and never
 * reach the steer editor), esc returns to main, and every other key feeds the
 * embedded steer editor (full editing like the parent editor; enter submits).
 * Wheel events over the overlay scroll the pane. The editor is injected so
 * these tests can pin the routing without a real TUI.
 */

import { strict as assert } from "node:assert";
import { CustomEditor, getSelectListTheme, initTheme } from "@earendil-works/pi-coding-agent";
import {
  backgroundAnsi,
  CombinedAutocompleteProvider,
  CURSOR_MARKER,
  getKeybindings,
  KeybindingsManager,
  rgbColor,
  setKeybindings,
  TUI_KEYBINDINGS,
  visibleWidth,
  type Color,
  type KeybindingDefinitions,
  type TerminalColorMode,
} from "@earendil-works/pi-tui";
import { test } from "node:test";

import { createSteerEditor } from "../src/lifecycle/widget.js";
import { TaskPanelEditor } from "../src/panel/task-editor.js";
import { routeChildBuiltinCommand } from "../src/panel/child-prompts.js";

import {
  TaskTranscriptOverlay,
  type SteerEditorLike,
  type TaskTranscriptOverlayHost,
  type TaskTranscriptOverlayTheme,
} from "../src/panel/task-transcript-overlay.js";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const PGUP = "\x1b[5~";
const PGDN = "\x1b[6~";
const ESC = "\x1b";
const ENTER = "\r";
const BACKSPACE = "\x7f";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";

interface FakePane {
  scrolled: number[];
  disposed: boolean;
  pane: {
    scrollBy(delta: number): void;
    render(width: number): string[];
    invalidate(): void;
    dispose(): void;
  };
}

function makePane(lines: string[] = ["transcript-line-a", "transcript-line-b"]): FakePane {
  const fake: FakePane = {
    scrolled: [],
    disposed: false,
    pane: {
      scrollBy(delta: number) {
        fake.scrolled.push(delta);
      },
      render(width: number) {
        return lines.slice(0, Math.max(0, width));
      },
      invalidate() {},
      dispose() {
        fake.disposed = true;
      },
    },
  };
  return fake;
}

interface FakeEditor {
  keys: string[];
  text: string;
  cleared: number;
  disposed: boolean;
  setText(text: string): void;
  editor: SteerEditorLike;
}

function makeFakeEditor(): FakeEditor {
  const fake: FakeEditor = {
    keys: [],
    text: "",
    cleared: 0,
    disposed: false,
    setText(text: string) {
      fake.text = text;
    },
    editor: {
      handleInput(data: string) {
        fake.keys.push(data);
        // Emulate text-input behavior: printable characters append, delete
        // removes the last character, escape sequences are ignored.
        if (data === "\x7f") {
          const chars = [...fake.text];
          chars.pop();
          fake.text = chars.join("");
          return;
        }
        if (data >= " " && !data.startsWith("\x1b")) fake.text += data;
      },
      render(width: number) {
        return [`❯ ${fake.text}`.slice(0, Math.max(0, width))];
      },
      getText() {
        return fake.text;
      },
      setText(text: string) {
        fake.text = text;
      },
      clear() {
        fake.text = "";
        fake.cleared += 1;
      },
      dispose() {
        fake.disposed = true;
      },
    },
  };
  return fake;
}

function makeHost() {
  const calls = { steers: [] as string[], closes: 0, renders: 0 };
  const host: TaskTranscriptOverlayHost = {
    taskId: "t1",
    onSteer: (text) => calls.steers.push(text),
    onClose: () => calls.closes += 1,
    requestRender: () => calls.renders += 1,
  };
  return { host, calls };
}

function makeOverlay() {
  const pane = makePane();
  const editor = makeFakeEditor();
  const { host, calls } = makeHost();
  const overlay = new TaskTranscriptOverlay({
    pane: pane.pane,
    host,
    theme: null,
    editor: editor.editor,
    terminalRows: () => 40,
  });
  const strip = (raw: string[]) => raw.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
  return { overlay, pane, editor, calls, strip };
}

interface AnsiCell {
  char: string;
  foreground: string | undefined;
  background: string | undefined;
  italic: boolean;
}

/** Interpret the SGR subset used by the overlay so tests can assert cell state. */
function readAnsiCells(line: string): AnsiCell[] {
  const cells: AnsiCell[] = [];
  let foreground: string | undefined;
  let background: string | undefined;
  let italic = false;
  const appendText = (text: string) => {
    for (const char of text) cells.push({ char, foreground, background, italic });
  };
  const applySgr = (parameters: string) => {
    const codes = parameters === "" ? [0] : parameters.split(";").map(Number);
    for (let index = 0; index < codes.length; index++) {
      const code = codes[index];
      if (code === 0) {
        foreground = undefined;
        background = undefined;
        italic = false;
      } else if (code === 3) {
        italic = true;
      } else if (code === 23) {
        italic = false;
      } else if (code === 39) {
        foreground = undefined;
      } else if (code === 49) {
        background = undefined;
      } else if (code === 38 || code === 48) {
        const mode = codes[index + 1];
        if (mode === 5 && codes[index + 2] !== undefined) {
          const color = `${code};5;${codes[index + 2]}`;
          if (code === 38) foreground = color;
          else background = color;
          index += 2;
        } else if (mode === 2 && codes[index + 4] !== undefined) {
          const color = `${code};2;${codes[index + 2]};${codes[index + 3]};${codes[index + 4]}`;
          if (code === 38) foreground = color;
          else background = color;
          index += 4;
        }
      } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
        foreground = String(code);
      } else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
        background = String(code);
      }
    }
  };

  const sgrPattern = /\x1b\[([0-9;]*)m/g;
  let cursor = 0;
  for (const match of line.matchAll(sgrPattern)) {
    const position = match.index ?? cursor;
    appendText(line.slice(cursor, position));
    applySgr(match[1] ?? "");
    cursor = position + match[0].length;
  }
  appendText(line.slice(cursor));
  return cells;
}

function backgroundState(color: Color, mode: TerminalColorMode): string | undefined {
  return readAnsiCells(`${backgroundAnsi(color, mode)}x`)[0]?.background;
}

function backgroundStateFromAnsi(backgroundAnsi: string): string | undefined {
  return readAnsiCells(`${backgroundAnsi}x`)[0]?.background;
}

function assertSolidBackground(lines: string[], expected: string | undefined): void {
  assert.ok(lines.length > 0, "overlay renders cells");
  for (const [row, line] of lines.entries()) {
    const cells = readAnsiCells(line);
    assert.ok(cells.length > 0, `row ${row} contains cells`);
    for (const [column, cell] of cells.entries()) {
      assert.equal(cell.background, expected, `row ${row}, column ${column} has the overlay surface`);
    }
  }
}

function assertTextBackground(cells: AnsiCell[], text: string, expected: string | undefined): void {
  const rendered = cells.map(({ char }) => char).join("");
  const start = rendered.indexOf(text);
  assert.notEqual(start, -1, `rendered cells contain ${JSON.stringify(text)}`);
  for (let offset = 0; offset < text.length; offset++) {
    assert.equal(cells[start + offset]?.background, expected, `${text} cell ${offset} retains its background`);
  }
}

function makeSurfaceOverlay(
  theme: TaskTranscriptOverlayTheme,
  paneLines: string[] = [],
  editorLines: string[] = ["prompt"],
  terminalRows = 5,
): TaskTranscriptOverlay {
  const pane = makePane(paneLines);
  const editor = makeFakeEditor();
  editor.editor.render = () => editorLines;
  const { host } = makeHost();
  return new TaskTranscriptOverlay({ pane: pane.pane, host, theme, editor: editor.editor, terminalRows: () => terminalRows });
}

function wheel(delta: number) {
  return {
    type: "wheel" as const,
    button: "none" as const,
    x: 5,
    y: 5,
    screenX: 5,
    screenY: 5,
    width: 100,
    height: 30,
    shift: false,
    alt: false,
    ctrl: false,
    wheelDelta: delta,
  };
}

test("esc closes the overlay without touching the steer editor", () => {
  const { overlay, editor, calls } = makeOverlay();
  overlay.handleInput(ESC);
  assert.equal(calls.closes, 1);
  assert.deepEqual(editor.keys, [], "esc is overlay-level, not editor input");
});

test("arrow keys scroll the pane toward older lines and skip the editor", () => {
  const { overlay, pane, editor } = makeOverlay({ keybindings: { matches: () => false } });
  overlay.handleInput(UP);
  overlay.handleInput(DOWN);
  assert.deepEqual(pane.scrolled, [3, -3], "up shows older lines, down returns toward the tail");
  assert.deepEqual(editor.keys, []);
});

test("plain horizontal arrows navigate siblings only for an exactly empty focused editor", async () => {
  const pane = makePane();
  const editor = makeFakeEditor();
  editor.editor.focused = true;
  const navigations: Array<{ direction: number; eligible: boolean }> = [];
  const host: any = {
    taskId: "child-source",
    onSteer() {},
    onNavigateSibling(direction: number, eligible: () => boolean) {
      navigations.push({ direction, eligible: eligible() });
    },
    onClose() {},
    requestRender() {},
  };
  const overlay = new TaskTranscriptOverlay({ pane: pane.pane, host, theme: null, editor: editor.editor, terminalRows: () => 40 });
  overlay.focused = false;
  assert.equal(editor.editor.focused, false, "TUI focus loss reaches the embedded editor");
  overlay.focused = true;
  assert.equal(editor.editor.focused, true, "TUI focus gain reaches the embedded editor");

  overlay.handleInput(LEFT);
  await new Promise((resolve) => setImmediate(resolve));
  overlay.handleInput(RIGHT);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(navigations.map(({ direction }) => direction), [-1, 1]);
  assert.deepEqual(editor.keys, [], "eligible plain arrows are not cursor movement");
  assert.ok(navigations.every(({ eligible }) => eligible), "the callback receives an eligible post-await guard");

  editor.setText(" ");
  overlay.handleInput(RIGHT);
  assert.equal(navigations.length, 2, "whitespace is an actual draft, not empty after trim");
  assert.equal(editor.keys.at(-1), RIGHT, "nonempty text keeps native cursor handling");

  editor.setText("first line\nsecond line");
  overlay.handleInput(LEFT);
  assert.equal(navigations.length, 2, "multiline text keeps native cursor handling");
  assert.equal(editor.keys.at(-1), LEFT);

  editor.setText("");
  editor.editor.focused = false;
  overlay.handleInput(RIGHT);
  assert.equal(navigations.length, 2, "an unfocused editor cannot trigger sibling navigation");
  assert.equal(editor.keys.at(-1), RIGHT);
  overlay.dispose();
});

test("native horizontal arrows retain cursor movement for whitespace and multiline pasted drafts", (t) => {
  initTheme();
  const previousKeybindings = getKeybindings();
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
  setKeybindings(keybindings);
  t.after(() => setKeybindings(previousKeybindings));
  const tui = { terminal: { rows: 40, columns: 80 }, requestRender() {} };
  const editor = createSteerEditor(tui as never, {
    fg: (_token: string, text: string) => text,
    bg: (_token: string, text: string) => text,
  }, keybindings as never);
  editor.focused = true;
  const navigations: number[] = [];
  const host: any = {
    taskId: "child-source",
    onSteer() {},
    onNavigateSibling(direction: number) { navigations.push(direction); },
    onClose() {},
    requestRender() {},
  };
  const overlay = new TaskTranscriptOverlay({ pane: makePane().pane, host, theme: null, editor, terminalRows: () => 40 });
  overlay.focused = true;
  const native = editor as CustomEditor & { getCursor(): { line: number; col: number } };

  editor.setText("  ");
  const spacesCursor = native.getCursor();
  overlay.handleInput(LEFT);
  assert.notDeepEqual(native.getCursor(), spacesCursor, "literal spaces keep left-arrow cursor movement");
  assert.equal(editor.getText(), "  ");

  editor.setText("");
  editor.handleInput("\x1b[200~pasted text\nsecond pasted line\x1b[201~");
  assert.equal(editor.getText(), "pasted text\nsecond pasted line", "bracketed multiline paste remains an actual nonempty draft");
  const pastedCursor = native.getCursor();
  overlay.handleInput(LEFT);
  assert.notDeepEqual(native.getCursor(), pastedCursor, "left arrow still moves within a pasted multiline draft");
  assert.deepEqual(navigations, [], "neither whitespace nor pasted text navigates siblings");
  overlay.dispose();
});

test("autocomplete and modified horizontal arrows retain native editor ownership", () => {
  const pane = makePane();
  const editor = makeFakeEditor();
  editor.editor.focused = true;
  let autocomplete = true;
  const navigations: number[] = [];
  const host: any = {
    taskId: "child-source",
    onSteer() {},
    onNavigateSibling(direction: number) { navigations.push(direction); },
    onClose() {},
    requestRender() {},
  };
  const nativeEditor = { ...editor.editor, isShowingAutocomplete: () => autocomplete };
  const overlay = new TaskTranscriptOverlay({ pane: pane.pane, host, theme: null, editor: nativeEditor, terminalRows: () => 40 });
  overlay.focused = true;

  overlay.handleInput(LEFT);
  autocomplete = false;
  overlay.handleInput("\x1b[1;5C"); // Ctrl+Right
  assert.deepEqual(navigations, [], "completion and modified arrows are not sibling navigation");
  assert.deepEqual(editor.keys, [LEFT, "\x1b[1;5C"], "the native editor receives both keys");
  overlay.dispose();
});

test("historical read-only roots support sibling arrows but nested read-only screens own their arrows", async () => {
  const pane = makePane();
  const editor = makeFakeEditor();
  editor.editor.focused = false;
  const navigations: number[] = [];
  const host: any = {
    taskId: "historical-source",
    readOnly: () => true,
    onSteer() {},
    onNavigateSibling(direction: number) { navigations.push(direction); },
    onClose() {},
    requestRender() {},
  };
  const overlay = new TaskTranscriptOverlay({ pane: pane.pane, host, theme: null, editor: editor.editor, terminalRows: () => 40 });
  overlay.handleInput(LEFT);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(navigations, [-1], "read-only historical transcript navigation does not need an editor");

  overlay.openChildSessionInfo({ sessionId: "child-info" });
  overlay.handleInput(RIGHT);
  assert.deepEqual(navigations, [-1], "the session-info subview keeps ownership of its keys");
  overlay.openChildHistoryTranscript(makePane().pane, {
    taskId: "nested-history", agentType: "general", description: "nested history",
    sessionName: "nested", status: "done", cwd: "/tmp", startedAt: 1,
  });
  overlay.handleInput(RIGHT);
  assert.deepEqual(navigations, [-1], "nested /resume history keeps its own arrow handling");
  assert.deepEqual(editor.keys, [], "read-only subviews never send keys to the hidden editor");
  overlay.dispose();
});

test("pageUp/pageDown page the pane", () => {
  const { overlay, pane, editor } = makeOverlay({ keybindings: { matches: () => false } });
  overlay.handleInput(PGUP);
  overlay.handleInput(PGDN);
  assert.deepEqual(pane.scrolled, [10, -10]);
  assert.deepEqual(editor.keys, []);
});

test("typing forwards to the editor; enter submits and clears it", () => {
  const { overlay, editor, calls } = makeOverlay();
  overlay.handleInput("h");
  assert.deepEqual(editor.keys, ["h"], "printable keys reach the editor");
  editor.setText("hi");
  overlay.handleInput(ENTER);
  assert.deepEqual(calls.steers, ["hi"], "enter submits the editor text");
  assert.equal(editor.text, "", "the editor is cleared after submit");
  overlay.handleInput(ENTER);
  assert.deepEqual(calls.steers, ["hi"], "empty editor does not steer again");
});

test("Enter lets native slash completion run before submitting its completed text", () => {
  const pane = makePane();
  const steered: string[] = [];
  const handled: string[] = [];
  let text = "/rev";
  let editor: SteerEditorLike;
  editor = {
    handleInput(data) {
      handled.push(data);
      text = "/review ";
      editor.onSubmit?.(text.trim());
      text = "";
    },
    render: () => [text],
    getText: () => text,
    setText: (value) => { text = value; },
    isShowingAutocomplete: () => true,
  };
  const overlay = new TaskTranscriptOverlay({
    pane: pane.pane,
    host: { taskId: "t-completion", onSteer: (value) => steered.push(value), onClose() {}, requestRender() {} },
    theme: null,
    editor,
    terminalRows: () => 40,
  });
  overlay.handleInput(ENTER);
  assert.deepEqual(handled, [ENTER], "the selected item is accepted by the native editor first");
  assert.deepEqual(steered, ["/review"], "native submission is routed exactly once");
  assert.equal(text, "", "native submission clears the editor");
  overlay.dispose();
});

test("a child view's panel editor routes /model to the child, never the parent dispatcher", async () => {
  initTheme();
  const previousKeybindings = getKeybindings();
  const keybindings = new KeybindingsManager({
    ...TUI_KEYBINDINGS,
    "app.tools.expand": { defaultKeys: "ctrl+o" },
  });
  setKeybindings(keybindings);

  const parentSubmissions: string[] = [];
  const childSteers: string[] = [];
  const childBuiltinExecutions: Array<{ name: string; argument: string; rawText: string }> = [];
  const childWork: Promise<void>[] = [];
  let viewTaskId: string | null = "durable-child";
  const host = {
    panelState: () => ({ selection: null, viewTaskId }),
    taskMonitorVisible: () => true,
    panelRows: () => [],
    onSelect() {},
    onEnter() {},
    onStop() {},
    onSteer(text: string) {
      childWork.push((async () => {
        const route = await routeChildBuiltinCommand(text, "durable");
        if (route?.kind === "supported") childBuiltinExecutions.push(route.command);
        else if (!route) childSteers.push(text);
      })());
    },
    onScrollView() {},
    onExitView() {},
    requestRender() {},
  };
  const tui = { terminal: { rows: 40, columns: 100 }, requestRender() {} };
  const editor = new TaskPanelEditor(
    tui as never,
    { borderColor: (text: string) => text, selectList: getSelectListTheme() } as never,
    keybindings as never,
    host,
  );
  editor.onSubmit = (text) => parentSubmissions.push(text);
  editor.setAutocompleteProvider(new CombinedAutocompleteProvider([{ name: "model" }], "/tmp"));

  try {
    assert.ok(editor instanceof CustomEditor, "the regression exercises Pi's real CustomEditor");
    for (const character of "/model") editor.handleInput(character);
    for (let i = 0; i < 50 && !editor.isShowingAutocomplete(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(editor.isShowingAutocomplete(), true, "the attached child provider opened its slash menu");

    editor.handleInput(ENTER);
    await Promise.all(childWork);

    assert.deepEqual(parentSubmissions, [], "the parent editor's submit/command dispatcher is unreachable");
    assert.deepEqual(childBuiltinExecutions, [{ name: "model", argument: "", rawText: "/model" }]);

    for (const character of "/unknown-child-command arg") editor.handleInput(character);
    editor.handleInput(ENTER);
    await Promise.all(childWork);
    assert.deepEqual(childSteers, ["/unknown-child-command arg"], "unknown slash text remains child steering");
    assert.deepEqual(parentSubmissions, [], "unknown child slash text also stays out of the parent");

    viewTaskId = null;
    for (const character of "/model") editor.handleInput(character);
    for (let i = 0; i < 50 && !editor.isShowingAutocomplete(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    editor.handleInput(ENTER);
    assert.deepEqual(parentSubmissions, ["/model"], "parent commands still work when no child is viewed");
  } finally {
    setKeybindings(previousKeybindings);
  }
});

test("the parent/main editor keeps its native horizontal cursor keys outside child overlays", () => {
  initTheme();
  const previousKeybindings = getKeybindings();
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
  setKeybindings(keybindings);
  const tui = { terminal: { rows: 40, columns: 80 }, requestRender() {} };
  const enters: Array<string | null> = [];
  const parentEditor = new TaskPanelEditor(
    tui as never,
    { borderColor: (text: string) => text, selectList: getSelectListTheme() } as never,
    keybindings as never,
    {
      panelState: () => ({ selection: null, viewTaskId: null }),
      taskMonitorVisible: () => true,
      panelRows: () => [],
      onSelect() {},
      onEnter: (taskId) => enters.push(taskId),
      onStop() {},
      onSteer() {},
      onScrollView() {},
      onExitView() {},
      requestRender() {},
    },
  );
  try {
    parentEditor.setText("parent draft");
    const before = parentEditor.getCursor();
    parentEditor.handleInput(LEFT);
    assert.notDeepEqual(parentEditor.getCursor(), before, "a native parent/snapshot editor still moves its cursor");
    assert.deepEqual(enters, [], "parent-editor arrows never invoke child navigation");
  } finally {
    setKeybindings(previousKeybindings);
  }
});

test("native completion navigation and cancel keys stay with the real editor", async () => {
  initTheme();
  const previousKeybindings = getKeybindings();
  const definitions = {
    ...TUI_KEYBINDINGS,
    "app.tools.expand": { defaultKeys: "ctrl+o" },
  } satisfies KeybindingDefinitions;
  const keybindings = new KeybindingsManager(definitions, {
    "tui.select.up": ["up", "ctrl+p"],
    "tui.select.down": ["down", "ctrl+n"],
  });
  setKeybindings(keybindings);
  let overlay: TaskTranscriptOverlay | undefined;

  try {
    const commands = [{ name: "review" }, { name: "rebase" }, { name: "revise" }];
    const provider = new CombinedAutocompleteProvider(commands, "/tmp");
    const suggestions = await provider.getSuggestions(["/"], 0, 1, { signal: new AbortController().signal });
    assert.equal(suggestions?.items.length, 3, "the real provider exposes multiple slash candidates");
    const tui = { terminal: { rows: 40, columns: 100 }, requestRender() {} };
    const theme = { fg: (_style: string, text: string) => text, bg: (_style: string, text: string) => text };
    const editor = createSteerEditor(tui, theme, keybindings);
    assert.ok(editor instanceof CustomEditor, "the regression exercises Pi's real CustomEditor");
    editor.setAutocompleteProvider?.(provider);

    const pane = makePane();
    let expansions = 0;
    const paneWithExpand = Object.assign(pane.pane, {
      toggleToolsExpanded: () => { expansions++; return true; },
    });
    const { host, calls } = makeHost();
    const activeOverlay = new TaskTranscriptOverlay({
      pane: paneWithExpand,
      host,
      theme: null,
      editor,
      terminalRows: () => 40,
      keybindings,
    });
    overlay = activeOverlay;
    const waitForMenu = async () => {
      for (let i = 0; i < 50 && !editor.isShowingAutocomplete?.(); i++) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      assert.equal(editor.isShowingAutocomplete?.(), true, "native slash completion menu opened");
    };

    activeOverlay.handleInput("/");
    await waitForMenu();

    activeOverlay.handleInput(PGUP);
    activeOverlay.handleInput(PGDN);
    assert.deepEqual(pane.scrolled, [], "native editor page bindings do not scroll the transcript while the menu is open");
    assert.equal(editor.isShowingAutocomplete?.(), true, "page navigation leaves completion active");

    activeOverlay.handleInput(DOWN);
    assert.deepEqual(pane.scrolled, [], "the configured selection arrow does not scroll the transcript");
    assert.equal(editor.isShowingAutocomplete?.(), true, "the menu remains active after moving selection");

    activeOverlay.handleInput("\x0e"); // ctrl+n is also configured as tui.select.down
    assert.deepEqual(pane.scrolled, [], "the remapped selection key also belongs to the menu");
    activeOverlay.handleInput(ENTER);
    assert.deepEqual(calls.steers, [`/${suggestions!.items[2]!.value}`], "Enter accepts and submits the selected native candidate");
    assert.equal(editor.getText(), "", "native slash acceptance submits and clears the editor");

    activeOverlay.handleInput("/");
    await waitForMenu();
    activeOverlay.handleInput("\x0f"); // ctrl+o: app.tools.expand
    assert.equal(expansions, 1, "the overlay tool-expansion action is not captured by the menu");
    assert.equal(editor.isShowingAutocomplete?.(), true, "tool expansion leaves completion open");

    activeOverlay.handleInput(ESC);
    assert.equal(calls.closes, 0, "first Escape dismisses the native menu, not the task view");
    assert.equal(editor.isShowingAutocomplete?.(), false);
    assert.equal(editor.getText(), "/", "dismissing completion preserves the input");
    activeOverlay.handleInput(ESC);
    assert.equal(calls.closes, 1, "second Escape closes the task view");
  } finally {
    overlay?.dispose();
    setKeybindings(previousKeybindings);
  }
});

test("Enter accepts a file completion without submitting it", () => {
  const pane = makePane();
  const steered: string[] = [];
  let text = "@src/fi";
  const editor: SteerEditorLike = {
    handleInput: () => { text = "@src/file.ts "; },
    render: () => [text],
    getText: () => text,
    setText: (value) => { text = value; },
    isShowingAutocomplete: () => true,
  };
  const overlay = new TaskTranscriptOverlay({
    pane: pane.pane,
    host: { taskId: "t-file-completion", onSteer: (value) => steered.push(value), onClose() {}, requestRender() {} },
    theme: null,
    editor,
    terminalRows: () => 40,
  });
  overlay.handleInput(ENTER);
  assert.deepEqual(steered, [], "file completion only edits the input");
  assert.equal(text, "@src/file.ts ");
  overlay.dispose();
});

test("backspace reaches the editor", () => {
  const { overlay, editor, calls } = makeOverlay();
  overlay.handleInput("a");
  overlay.handleInput("b");
  overlay.handleInput(BACKSPACE);
  overlay.handleInput(ENTER);
  assert.equal(editor.keys.filter((k) => k === BACKSPACE).length, 1);
  assert.deepEqual(calls.steers, ["a"]);
});

test("wheel-up scrolls toward older lines and stops propagation", () => {
  const { overlay, pane, editor } = makeOverlay();
  const result = overlay.handleMouse?.(wheel(-5));
  assert.deepEqual(result, { handled: true });
  assert.deepEqual(pane.scrolled, [5], "wheel-up (negative delta) shows older lines");
  assert.deepEqual(editor.keys, []);
});

test("non-wheel mouse events are ignored", () => {
  const { overlay, pane, editor } = makeOverlay();
  const event = { ...wheel(0), type: "move" as const, wheelDelta: undefined };
  assert.equal(overlay.handleMouse?.(event), undefined);
  assert.deepEqual(pane.scrolled, []);
  assert.deepEqual(editor.keys, []);
});

test("renders the pane body, the key hints, and the editor prompt", () => {
  const { overlay, editor, calls } = makeOverlay();
  const lines = overlay.render(100).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
  // No `context` provider: the footer keeps the key hints and no facts are
  // invented for a host that has none.
  assert.ok(lines.some((l) => l.includes("esc back")), JSON.stringify(lines));
  assert.ok(lines.some((l) => l.includes("enter steer")), JSON.stringify(lines));
  assert.ok(lines.some((l) => l.includes("transcript-line-a")), JSON.stringify(lines));
  assert.ok(lines.some((l) => l.includes("❯")), "the steer editor renders its prompt");
});

test("dispose disposes the pane and the editor", () => {
  const { overlay, pane, editor } = makeOverlay();
  overlay.dispose();
  assert.equal(pane.disposed, true);
  assert.equal(editor.disposed, true);
});

test("editor lines keep the overlay fill after internal ANSI resets", () => {
  // Match Pi's theme contract: background start + text + background reset.
  const bgStart = "\x1b[48;5;235m";
  const theme = {
    bg: (_token: string, text: string) => `${bgStart}${text}\x1b[49m`,
    fg: (_token: string, text: string) => text,
  };
  const pane = {
    scrolled: [] as number[],
    scrollBy() {},
    render: () => ["body"],
    invalidate() {},
    dispose() {},
  };
  // The editor renders a cursor block whose reset would punch a hole in the fill.
  const editor: SteerEditorLike = {
    handleInput() {},
    render: () => ["\x1b[7m▊\x1b[0m after cursor"],
    getText: () => "",
    setText() {},
  };
  const host: TaskTranscriptOverlayHost = {
    taskId: "t1",
    onSteer() {},
    onClose() {},
    requestRender() {},
  };
  const overlay = new TaskTranscriptOverlay({
    pane,
    host,
    theme,
    editor,
    terminalRows: () => 40,
  });
  const lines = overlay.render(100);

  const editorLine = lines.find((l) => l.includes("after cursor"));
  assert.ok(editorLine, JSON.stringify(lines));
  assert.ok(
    editorLine.includes(`\x1b[0m${bgStart}`),
    "the panel fill is re-applied after the editor's internal reset",
  );
  overlay.dispose();
});

test("overlay fill is restored after background resets in transcript and editor lines", () => {
  const bgStart = "\x1b[48;5;235m";
  const theme = {
    bg: (_token: string, text: string) => `${bgStart}${text}\x1b[49m`,
    fg: (_token: string, text: string) => text,
  };
  const pane = {
    scrollBy() {},
    render: () => ["tool row\x1b[49m after pane reset"],
    invalidate() {},
    dispose() {},
  };
  const editor: SteerEditorLike = {
    handleInput() {},
    render: () => ["editor row\x1b[39;49m after editor reset"],
    getText: () => "",
    setText() {},
  };
  const host: TaskTranscriptOverlayHost = {
    taskId: "t-reset",
    onSteer() {},
    onClose() {},
    requestRender() {},
  };
  const overlay = new TaskTranscriptOverlay({
    pane,
    host,
    theme,
    editor,
    terminalRows: () => 12,
  });

  try {
    const lines = overlay.render(80);
    const paneLine = lines.find((line) => line.includes("after pane reset"));
    const editorLine = lines.find((line) => line.includes("after editor reset"));
    assert.ok(paneLine?.includes(`\x1b[49m${bgStart} after pane reset`));
    assert.ok(editorLine?.includes(`\x1b[39;49m${bgStart} after editor reset`));
  } finally {
    overlay.dispose();
  }
});

test("resolved theme surface fills content, padding, and blank rows and refreshes by frame", () => {
  let color = rgbColor(24, 36, 48);
  let mode: TerminalColorMode = "truecolor";
  const theme = {
    fg: (_token: string, text: string) => text,
    // This realistic default-token result has no explicit background of its own.
    bg: (_token: string, text: string) => `${text}\x1b[49m`,
    get colors() { return { customMessageBg: color }; },
    getColorMode: () => mode,
    appearance: "dark" as const,
  };
  const thinking = "\x1b[3;38;5;201mthinking\x1b[23;39m";
  const overlay = makeSurfaceOverlay(theme, [thinking]);

  try {
    const firstFrame = overlay.render(12);
    const firstBackground = backgroundState(color, mode);
    assertSolidBackground(firstFrame, firstBackground);
    assert.ok(firstFrame[1], "the transcript includes a blank filler row");
    assert.ok(readAnsiCells(firstFrame[1] ?? "").every((cell) => cell.char === " "), "filler row stays blank");

    const transcriptCells = readAnsiCells(firstFrame[0] ?? "");
    const thinkingCells = transcriptCells.filter(({ char }) => "thinking".includes(char));
    assert.equal(thinkingCells.length, "thinking".length);
    for (const cell of thinkingCells) {
      assert.equal(cell.foreground, "38;5;201", "thinking keeps its transcript foreground");
      assert.equal(cell.italic, true, "thinking remains italic");
    }
    assert.equal(transcriptCells[0]?.background, firstBackground, "left Box padding has the surface");
    assert.equal(transcriptCells.at(-1)?.background, firstBackground, "right Box padding has the surface");

    color = rgbColor(62, 74, 86);
    mode = "256color";
    const secondFrame = overlay.render(12);
    const secondBackground = backgroundState(color, mode);
    assert.notEqual(secondBackground, firstBackground, "the test changes both color and encoding");
    assertSolidBackground(secondFrame, secondBackground);
  } finally {
    overlay.dispose();
  }
});

test("legacy concrete theme background takes precedence over appearance fallback", () => {
  const legacyBg = "\x1b[48;5;235m";
  const theme = {
    fg: (_token: string, text: string) => text,
    bg: (_token: string, text: string) => `${legacyBg}${text}\x1b[49m`,
    appearance: "light" as const,
  };
  const overlay = makeSurfaceOverlay(theme);
  try {
    assertSolidBackground(overlay.render(12), backgroundStateFromAnsi(legacyBg));
  } finally {
    overlay.dispose();
  }
});

test("default-only legacy theme backgrounds fall back to appearance black or white", () => {
  for (const appearance of ["dark", "light"] as const) {
    const theme = {
      fg: (_token: string, text: string) => text,
      bg: (_token: string, text: string) => `${text}\x1b[49m`,
      appearance,
      getColorMode: () => "truecolor" as const,
    };
    const overlay = makeSurfaceOverlay(theme);
    const fallback = appearance === "dark" ? rgbColor(0, 0, 0) : rgbColor(255, 255, 255);
    try {
      assertSolidBackground(overlay.render(12), backgroundState(fallback, "truecolor"));
    } finally {
      overlay.dispose();
    }
  }
});

test("combined SGR reset keeps explicit tool backgrounds and ignores RGB channel values", () => {
  const surface = rgbColor(24, 36, 48);
  const mode: TerminalColorMode = "truecolor";
  const theme = {
    fg: (_token: string, text: string) => text,
    bg: (_token: string, text: string) => `${text}\x1b[49m`,
    colors: { customMessageBg: surface },
    getColorMode: () => mode,
    appearance: "dark" as const,
  };
  const line = "\x1b[0;48;5;88mindexed-tool\x1b[49m outside " +
    "\x1b[48;2;0;49;0mtruecolor-tool\x1b[49m tail";
  const overlay = makeSurfaceOverlay(theme, [line]);

  try {
    const frame = overlay.render(80);
    const cells = readAnsiCells(frame.find((row) => row.includes("indexed-tool")) ?? "");
    assertTextBackground(cells, "indexed-tool", "48;5;88");
    assertTextBackground(cells, "outside", backgroundState(surface, mode));
    assertTextBackground(cells, "truecolor-tool", "48;2;0;49;0");
    assertTextBackground(cells, "tail", backgroundState(surface, mode));
  } finally {
    overlay.dispose();
  }
});

test("fills the terminal height and keeps the editor above the footer", () => {
  const terminalRows = 12;
  const pane = {
    scrollBy() {},
    render: () => ["transcript line"],
    invalidate() {},
    dispose() {},
  };
  const editor: SteerEditorLike = {
    handleInput() {},
    render: () => ["editor first line", "editor last line"],
    getText: () => "",
    setText() {},
  };
  const host: TaskTranscriptOverlayHost = {
    taskId: "t1",
    onSteer() {},
    notice: () => ({ message: "child command result that is wider than the panel", level: "info" }),
    onClose() {},
    requestRender() {},
  };
  const overlay = new TaskTranscriptOverlay({
    pane,
    host,
    theme: null,
    editor,
    terminalRows: () => terminalRows,
  });

  const lines = overlay.render(60);
  assert.equal(lines.length, terminalRows, "the overlay frame covers every terminal row with command feedback");
  assert.ok(lines.some((line) => line.includes("child command result")), "command feedback is visible in the overlay");
  assert.ok(
    lines.every((line) => visibleWidth(line.replace(/\x1b\[[0-9;]*m/g, "")) <= 60),
    "command feedback and existing chrome stay within the requested width",
  );
  const editorRow = lines.findIndex((line) => line.includes("editor last line"));
  const footerRow = lines.findIndex((line) => line.includes("esc back"));
  assert.ok(editorRow >= 0, "the editor renders");
  assert.ok(footerRow > editorRow, "the footer sits under the editor, as pi's own screen does");
  overlay.dispose();
});

test("child session info is a scrollable read-only screen that reflows on resize", () => {
  let terminalRows = 8;
  const pane = makePane().pane;
  const editor = makeFakeEditor();
  const { host, calls } = makeHost();
  const overlay = new TaskTranscriptOverlay({
    pane,
    host,
    theme: null,
    editor: editor.editor,
    terminalRows: () => terminalRows,
  });
  const info = {
    sessionId: "child-session-id-123456789",
    sessionName: "review child",
    storagePath: "/tmp/pi-task/very-long-storage-directory/child-session.jsonl",
    model: "provider-with-long-name/model-with-long-identifier",
    thinkingLevel: "high",
    cwd: "/work/child/project",
    counts: {
      scope: "session" as const,
      userMessages: 12,
      assistantMessages: 9,
      toolCalls: 7,
      toolResults: 7,
      totalMessages: 28,
    },
    tokens: { input: 1234, output: 2345, cacheRead: 3456, cacheWrite: 4567, total: 11602 },
    cost: 0.1234,
    contextUsage: { tokens: 9000, contextWindow: 128000, percent: 7.03 },
  };

  assert.equal((overlay as unknown as { openChildSessionInfo(data: unknown): boolean }).openChildSessionInfo(info), true);
  const first = overlay.render(34);
  assert.equal(first.length, terminalRows, "the info screen fills the terminal height");
  assert.ok(first.join("\n").includes("Session Info"));
  assert.ok(first.join("\n").includes("Session ID"));
  assert.ok(
    first.every((line) => visibleWidth(line.replace(/\x1b\[[0-9;]*m/g, "")) <= 34),
    "long child paths and model references wrap within a narrow terminal",
  );
  assert.deepEqual(editor.keys, [], "read-only navigation never reaches the steer editor");

  const pages = [first.join("\n")];
  for (let page = 0; page < 10; page++) {
    overlay.handleInput(PGDN);
    pages.push(overlay.render(34).join("\n"));
  }
  const later = overlay.render(34);
  assert.match(pages.join("\n"), /Cache read/i, "paging visits the cache-read total");
  assert.match(pages.join("\n"), /Cache write/i, "paging visits the cache-write total");
  assert.match(pages.join("\n"), /Cost/);
  assert.equal(later.length, terminalRows);
  overlay.handleMouse?.(wheel(-1));
  terminalRows = 5;
  const resized = overlay.render(28);
  assert.equal(resized.length, terminalRows, "a resize recomputes the scroll viewport");
  assert.ok(
    resized.every((line) => visibleWidth(line.replace(/\x1b\[[0-9;]*m/g, "")) <= 28),
    "the resized info screen still fits every row",
  );
  for (const rows of [2, 1, 0]) {
    terminalRows = rows;
    const tiny = overlay.render(8);
    assert.equal(tiny.length, rows, `${rows}-row session-info terminal is not clipped`);
    assert.ok(
      tiny.every((line) => visibleWidth(line.replace(/\x1b\[[0-9;]*m/g, "")) <= 8),
      "even the smallest info viewport respects terminal width",
    );
  }

  terminalRows = 8;
  overlay.handleInput(ESC);
  assert.equal(calls.closes, 0, "escape leaves the session-info screen and returns to the child editor");
  overlay.handleInput("x");
  assert.ok(editor.keys.includes("x"), "the child editor regains input focus after leaving info");
  overlay.dispose();
});

test("durable history selection opens a read-only transcript and returns to the child view", () => {
  initTheme();
  const pane = makePane().pane;
  const editor = makeFakeEditor();
  const { host, calls } = makeHost();
  const selected: string[] = [];
  host.onResumeHistory = (taskId) => selected.push(taskId);
  const terminal = { rows: 20, columns: 80 };
  const overlay = new TaskTranscriptOverlay({
    pane,
    host,
    theme: null,
    editor: editor.editor,
    terminalRows: () => terminal.rows,
    ui: { terminal, requestRender() {} } as never,
  });
  const option = {
    taskId: "history-task",
    agentType: "reviewer",
    description: "historical review",
    sessionName: "reviewer history",
    status: "done",
    cwd: "/work/repo",
    startedAt: 1234,
  };
  assert.equal(overlay.openChildHistoryPicker({ sessions: [option], currentTaskId: "history-task" }), true);
  const picker = overlay.render(80).join("\n");
  assert.match(picker, /Browse Durable Child History/);
  assert.match(picker, /history-task/);
  assert.match(picker, /no task is resumed/i);
  assert.deepEqual(editor.keys, [], "the child steer editor is not active while picking history");
  overlay.handleInput(ENTER);
  assert.deepEqual(selected, ["history-task"], "selection invokes the history browser callback, not child steering");
  assert.deepEqual(calls.steers, []);

  const historical = makePane(["historical transcript body"]);
  const historicalPane = historical.pane;
  assert.equal(overlay.openChildHistoryTranscript(historicalPane, option), true);
  const historyFrame = overlay.render(80).join("\n");
  assert.match(historyFrame, /Historical child transcript/);
  assert.match(historyFrame, /historical transcript body/);
  overlay.handleInput(UP);
  assert.deepEqual(historical.scrolled, [3], "scroll keys navigate the historical transcript, not the active child pane");
  overlay.handleInput(ESC);
  assert.ok(overlay.render(80).join("\n").includes("❯"), "escape returns to the original child editor");
  assert.equal(calls.closes, 0, "history navigation never closes the parent Pi overlay");
  overlay.dispose();
});

test("short terminals fit the editor and retain its cursor row", () => {
  for (const terminalRows of [8, 5]) {
    const pane = {
      scrollBy() {},
      render: (_width: number, availableRows?: number) =>
        availableRows === 0 ? [] : ["transcript line"],
      invalidate() {},
      dispose() {},
    };
    const editorLines = [
      "editor top border",
      "editor line 1",
      "editor line 2",
      `cursor row ${CURSOR_MARKER}`,
      "editor line 4",
      "editor line 5",
      "editor bottom border",
    ];
    const editor: SteerEditorLike = {
      handleInput() {},
      render: () => editorLines,
      getText: () => "",
      setText() {},
    };
    const host: TaskTranscriptOverlayHost = {
      taskId: "t-short",
      onSteer() {},
      onClose() {},
      requestRender() {},
    };
    const overlay = new TaskTranscriptOverlay({
      pane,
      host,
      theme: null,
      editor,
      terminalRows: () => terminalRows,
    });

    try {
      const lines = overlay.render(60);
      assert.equal(lines.length, terminalRows, `${terminalRows}-row terminal is not clipped`);
      assert.ok(lines.some((line) => line.includes(CURSOR_MARKER)), "cursor remains in the viewport");
    } finally {
      overlay.dispose();
    }
  }
});
