/**
 * The child overlay covers every row of the screen, but pi-tui's
 * `compositeTuiLine` keeps a parent image line intact and drops the overlay's
 * own line for that row (pi-tui 1.0.4 dist/tui.js `isImageLine(baseLine)`
 * early return). A parent transcript image therefore leaves one default-
 * background hole per image row — visible as a blurred band under terminal
 * opacity. While the fullscreen child overlay is open its composites must win
 * over parent image rows; the original behavior is restored on dispose.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  TaskTranscriptOverlay,
  type SteerEditorLike,
  type TaskTranscriptOverlayHost,
} from "../src/panel/task-transcript-overlay.js";
import { backgroundAnsi, getCapabilities, rgbColor, setCapabilityOverrides, type TerminalColorMode } from "@earendil-works/pi-tui";
import {
  makeFakeEditor,
  makeHost,
  makePane,
  readAnsiCells,
  type AnsiCell,
} from "./taskTranscriptOverlay.test.js";

const KITTY_ROW = "\x1b_Ga=T,f=100,s=10,v=10;AAAA\x1b\\";
const OVERLAY_ROW = "\x1b[48;2;0;0;0mopaque child row\x1b[49m";

interface CompositeCall {
  baseLine: string;
  overlayLine: string;
}

function makeOverlayWithTui() {
  const composites: CompositeCall[] = [];
  const tui = {
    compositeLineAt(baseLine: string, overlayLine: string): string {
      composites.push({ baseLine, overlayLine });
      // pi-tui 1.0.4 semantics: image base lines pass through untouched.
      return baseLine.includes("\x1b_G") ? baseLine : overlayLine;
    },
  };
  const pane = makePane([]);
  const editor = makeFakeEditor();
  editor.editor.render = () => ["prompt"];
  const { host } = makeHost();
  const overlay = new TaskTranscriptOverlay({
    pane: pane.pane,
    host,
    theme: null,
    editor: editor.editor,
    terminalRows: () => 12,
    ui: tui as never,
  });
  return { overlay, tui };
}

test("while the child overlay is open, its composites replace parent image rows", () => {
  const { overlay, tui } = makeOverlayWithTui();
  try {
    overlay.render(40);
    const patched = (tui as unknown as {
      compositeLineAt: (base: string, line: string, col: number, w: number, total: number) => string;
    }).compositeLineAt;
    const result = patched(KITTY_ROW, OVERLAY_ROW, 0, 40, 40);
    assert.equal(result.includes("\x1b_G"), false, "the parent image escape no longer reaches the screen");
    assert.equal(result.includes("opaque child row"), true, "the overlay's opaque row wins the image row");
  } finally {
    overlay.dispose();
  }
});

test("disposing the child overlay restores the original image-row compositing", () => {
  const { overlay, tui } = makeOverlayWithTui();
  assert.notEqual(tui.compositeLineAt, undefined);
  overlay.render(40);
  overlay.dispose();
  const after = (tui as unknown as {
    compositeLineAt: (base: string, line: string, col: number, w: number, total: number) => string;
  }).compositeLineAt;
  // The fake TUI's documented semantics: image base lines pass through.
  assert.equal(after.call(tui, KITTY_ROW, OVERLAY_ROW, 0, 40, 40), KITTY_ROW);
  assert.equal(after.call(tui, "plain", OVERLAY_ROW, 0, 40, 40), OVERLAY_ROW);
});

test("a TUI without compositeLineAt leaves compositing untouched", () => {
  const pane = makePane([]);
  const editor = makeFakeEditor();
  editor.editor.render = () => ["prompt"];
  const { host } = makeHost();
  const overlay = new TaskTranscriptOverlay({
    pane: pane.pane,
    host,
    theme: null,
    editor: editor.editor,
    terminalRows: () => 12,
    ui: {} as never,
  });
  try {
    const lines = overlay.render(40);
    assert.ok(Array.isArray(lines));
  } finally {
    overlay.dispose();
  }
});

const KITTY_DELETE_ALL = "\x1b_Ga=d,d=A,q=2\x1b\\";

test("opening the child overlay clears kitty image placements; closing forces a full redraw", () => {
  const previousImages = getCapabilities().images;
  setCapabilityOverrides({ images: "kitty", trueColor: undefined, hyperlinks: undefined });
  const writes: string[] = [];
  const redraws: boolean[] = [];
  const tui = {
    terminal: { rows: 12, write: (data: string) => writes.push(data) },
    requestRender: (force = false) => redraws.push(force),
  };
  const pane = makePane([]);
  const editor = makeFakeEditor();
  editor.editor.render = () => ["prompt"];
  const { host } = makeHost();
  const overlay = new TaskTranscriptOverlay({
    pane: pane.pane,
    host,
    theme: null,
    editor: editor.editor,
    terminalRows: () => 12,
    ui: tui as never,
  });
  try {
    assert.ok(
      writes.includes(KITTY_DELETE_ALL),
      "the overlay deletes all kitty placements when it opens",
    );
  } finally {
    overlay.dispose();
  }
  assert.ok(
    redraws.includes(true),
    "dispose forces a full redraw so parent images repaint",
  );
  setCapabilityOverrides({
    images: previousImages as undefined,
    trueColor: undefined,
    hyperlinks: undefined,
  });
});

test("the child transcript flattens tool backgrounds onto the theme surface", () => {
  const surface = rgbColor(0, 0, 0);
  const mode: TerminalColorMode = "truecolor";
  const theme = {
    fg: (_token: string, text: string) => text,
    bg: (_token: string, text: string) => `${text}\x1b[49m`,
    colors: { customMessageBg: surface },
    getColorMode: () => mode,
    appearance: "dark" as const,
  };
  // A tool row as pi renders it: grey tool background with styled foreground.
  const toolRow = "\x1b[38;5;201;48;5;236m$ echo hi\x1b[49m tail";
  const pane = makePane([toolRow]);
  const editor = makeFakeEditor();
  editor.editor.render = () => ["prompt"];
  const { host } = makeHost();
  const overlay = new TaskTranscriptOverlay({
    pane: pane.pane,
    host,
    theme,
    editor: editor.editor,
    terminalRows: () => 12,
  });
  try {
    const cells = readAnsiCells(overlay.render(80).find((row) => row.includes("echo hi")) ?? "");
    const text = cells.map(({ char }) => char).join("");
    const start = text.indexOf("$ echo hi");
    assert.notEqual(start, -1);
    const surfaceBg = readAnsiCells(`${backgroundAnsi(surface, mode)}x`)[0]?.background;
    for (let offset = 0; offset < "$ echo hi".length; offset++) {
      assert.equal(
        cells[start + offset]?.background,
        surfaceBg,
        `tool cell ${offset} sits on the theme surface`,
      );
    }
    const fgCells = cells.slice(start, start + "$ echo hi".length);
    assert.ok(
      fgCells.every((cell) => cell.foreground === "38;5;201"),
      "the tool row keeps its foreground styling",
    );
  } finally {
    overlay.dispose();
  }
});
