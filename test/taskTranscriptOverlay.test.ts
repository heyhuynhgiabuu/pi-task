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
import { CustomEditor, initTheme } from "@earendil-works/pi-coding-agent";
import {
  CombinedAutocompleteProvider,
  CURSOR_MARKER,
  getKeybindings,
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
  type KeybindingDefinitions,
} from "@earendil-works/pi-tui";
import { test } from "node:test";

import { createSteerEditor } from "../src/lifecycle/widget.js";

import {
  TaskTranscriptOverlay,
  type SteerEditorLike,
  type TaskTranscriptOverlayHost,
} from "../src/panel/task-transcript-overlay.js";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const PGUP = "\x1b[5~";
const PGDN = "\x1b[6~";
const ESC = "\x1b";
const ENTER = "\r";
const BACKSPACE = "\x7f";

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
  assert.equal(lines.length, terminalRows, "the overlay frame covers every terminal row");
  const editorRow = lines.findIndex((line) => line.includes("editor last line"));
  const footerRow = lines.findIndex((line) => line.includes("esc back"));
  assert.ok(editorRow >= 0, "the editor renders");
  assert.ok(footerRow > editorRow, "the footer sits under the editor, as pi's own screen does");
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
