/**
 * Layout contract of the live child panel: the transcript, then the compact
 * child status row, then the editor (whose top border carries the working
 * indicator through pi's own `CustomEditor` chrome), then the footer with the
 * child's recorded facts and the key hints.
 *
 * The tests pin the order, the height budget (no chrome row is ever clipped),
 * and the states — running, settled, failed, and a child whose model/thinking
 * were never recorded.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";

import { CustomEditor, initTheme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";

import { createSteerEditor } from "../src/lifecycle/widget.js";
import {
  TaskTranscriptOverlay,
  type SteerEditorLike,
  type TaskTranscriptOverlayHost,
} from "../src/panel/task-transcript-overlay.js";
import type { TaskContextInfo } from "../src/panel/task-context.js";

const PRODUCTION_THEME = {
  bg: (_token: string, text: string) => text,
  fg: (_token: string, text: string) => text,
};

const DURABLE_CHILD: TaskContextInfo = {
  taskId: "t1",
  agentType: "general",
  description: "search the repo",
  backend: "durable",
  cwd: `${homedir()}/dev/podcast`,
  model: "opencode-go/deepseek-flash",
  thinkingLevel: "high",
  elapsedMs: 12_340,
  toolUses: 3,
  taskIndex: 2,
  taskCount: 3,
};

function makeTui(rows: number) {
  return { terminal: { rows }, requestRender: () => {} } as never;
}

function makePane() {
  return {
    scrollBy: () => {},
    render: (width: number, availableRows?: number) =>
      availableRows === 0
        ? []
        : ["TRANSCRIPT_ONE", "TRANSCRIPT_TWO"].slice(0, availableRows).map((line) => line.padEnd(width)),
    invalidate: () => {},
    dispose: () => {},
  };
}

function makeOverlay(options: {
  rows: number;
  info?: TaskContextInfo | undefined;
  activity?: () => { phase: "tool"; label: string } | undefined;
  editor?: SteerEditorLike;
  theme?: unknown;
}) {
  const editor =
    options.editor ??
    createSteerEditor(
      makeTui(options.rows),
      options.theme ?? PRODUCTION_THEME,
      { matches: () => false } as never,
    );
  const host: TaskTranscriptOverlayHost = {
    taskId: "t1",
    onSteer: () => {},
    onClose: () => {},
    requestRender: () => {},
    activity: options.activity ?? (() => ({ phase: "tool", label: "Running websearch…" })),
    ...(options.info === undefined && "info" in options
      ? {}
      : { context: () => options.info ?? DURABLE_CHILD }),
  };
  return new TaskTranscriptOverlay({
    pane: makePane(),
    host,
    theme: (options.theme ?? PRODUCTION_THEME) as never,
    editor,
    terminalRows: () => options.rows,
    ui: makeTui(options.rows),
  });
}

function plain(lines: string[]): string[] {
  return lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
}

function indexOf(lines: readonly string[], needle: string | RegExp): number {
  return lines.findIndex((line) =>
    typeof needle === "string" ? line.includes(needle) : needle.test(line),
  );
}

test("live child panel stacks transcript, child status, editor chrome, footer", () => {
  initTheme();
  const overlay = makeOverlay({ rows: 16 });
  try {
    const lines = plain(overlay.render(100));
    const transcript = indexOf(lines, "TRANSCRIPT_TWO");
    const status = indexOf(lines, "task 2/3 · general — search the repo");
    const borderTop = indexOf(lines, /Running websearch…/);
    const footer = indexOf(lines, "esc back");

    assert.ok(transcript >= 0, `transcript renders: ${JSON.stringify(lines)}`);
    assert.ok(status > transcript, "the child status row sits under the transcript");
    assert.ok(borderTop > status, "the working indicator sits in the editor's top border");
    assert.match(lines[borderTop] ?? "", /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/, "the border carries a spinner frame");
    assert.ok(footer > borderTop, "the footer sits under the editor");
    assert.ok(
      lines.slice(borderTop + 1, footer).some((line) => /^─+$/.test(line.trim())),
      "the editor's bottom border closes the input above the footer",
    );
    assert.equal(indexOf(lines, "enter steer") > borderTop, true, "key hints live in the footer");
    assert.doesNotMatch(lines[0] ?? "", /@t1|scroll/, "no custom top header");
  } finally {
    overlay.dispose();
  }
});

test("the working indicator is embedded in the editor's top border, not a detached row", () => {
  initTheme();
  let activity: { phase: "tool"; label: string } | undefined = {
    phase: "tool",
    label: "Running websearch…",
  };
  const editor = createSteerEditor(makeTui(12), PRODUCTION_THEME, { matches: () => false } as never);
  assert.ok(editor instanceof CustomEditor, "production hosts get pi's CustomEditor");
  const attached: Array<unknown> = [];
  const original = editor.setWorkingStatusIndicator?.bind(editor);
  editor.setWorkingStatusIndicator = (indicator) => {
    attached.push(indicator);
    original?.(indicator as never);
  };

  const overlay = makeOverlay({ rows: 12, activity: () => activity, editor });
  try {
    const running = plain(overlay.render(100));
    assert.match(
      running[indexOf(running, /Running websearch…/)] ?? "",
      /^ *── /,
      "spinner opens the border",
    );
    assert.equal(attached.length, 1, "the indicator is attached once");
    assert.ok(attached[0], "an indicator instance is attached");
    // The phase is stated in the border only — the status row stays free of it.
    const status = running[indexOf(running, "task 2/3")] ?? "";
    assert.doesNotMatch(status, /Running websearch/, "no duplicate phase in the status row");

    activity = undefined;
    const settled = plain(overlay.render(100));
    assert.equal(attached.at(-1), undefined, "the settled child detaches the indicator");
    assert.doesNotMatch(settled.join("\n"), /Running websearch…/, "no spinner text when settled");
    assert.match(
      settled.find((line) => /^ *──+$/.test(line)) ?? "",
      /^ *──+$/,
      "the border renders normally again",
    );
  } finally {
    overlay.dispose();
  }
});

test("the embedded indicator advances frames while the child runs", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  initTheme();
  const overlay = makeOverlay({ rows: 12 });
  try {
    const frame = (): string => {
      const line = plain(overlay.render(100)).find((candidate) => /Running websearch…/.test(candidate)) ?? "";
      return line.match(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/)?.[0] ?? "";
    };
    const first = frame();
    assert.ok(first, "a frame renders");
    t.mock.timers.tick(80);
    assert.notEqual(frame(), first, "the border spinner advances on the animation interval");
  } finally {
    overlay.dispose();
  }
});

test("settled children state their outcome and stop the indicator", () => {
  initTheme();
  for (const status of ["done", "failed", "cancelled"]) {
    const overlay = makeOverlay({
      rows: 12,
      info: { ...DURABLE_CHILD, status },
      activity: () => undefined,
    });
    try {
      const lines = plain(overlay.render(100));
      assert.match(
        lines[indexOf(lines, "task 2/3")] ?? "",
        new RegExp(`· ${status} · `),
        `${status} is stated in the status row`,
      );
      assert.doesNotMatch(lines.join("\n"), /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/, "no spinner for a settled child");
    } finally {
      overlay.dispose();
    }
  }
});

test("the footer states only facts the panel actually has", () => {
  initTheme();
  const withFacts = makeOverlay({ rows: 12 });
  try {
    const footer = plain(withFacts.render(100)).find((line) => line.includes("#t1")) ?? "";
    assert.match(footer, /#t1 · durable · ~\/dev\/podcast · deepseek-flash · thinking high/);
  } finally {
    withFacts.dispose();
  }

  const withoutModel = makeOverlay({
    rows: 12,
    info: { ...DURABLE_CHILD, model: undefined, thinkingLevel: undefined },
  });
  try {
    const footer = plain(withoutModel.render(100)).find((line) => line.includes("#t1")) ?? "";
    assert.equal(footer.includes("thinking"), false, "no thinking level is invented");
    assert.equal(footer.includes("deepseek"), false, "no model is invented");
    assert.match(footer, /#t1 · durable · ~\/dev\/podcast/);
  } finally {
    withoutModel.dispose();
  }

  const claudeChild = makeOverlay({
    rows: 12,
    info: {
      ...DURABLE_CHILD,
      backend: "sdk",
      runtime: "claude",
      model: "anthropic/claude-sonnet-4",
      thinkingLevel: "medium",
    },
  });
  try {
    const footer = plain(claudeChild.render(100)).find((line) => line.includes("#t1")) ?? "";
    assert.match(footer, /sdk\/claude · ~\/dev\/podcast · claude-sonnet-4 · thinking medium/);
  } finally {
    claudeChild.dispose();
  }
});

test("no chrome row is clipped on narrow or short terminals", () => {
  initTheme();
  for (const rows of [20, 12, 8, 6, 5, 4, 3, 2, 1]) {
    for (const width of [120, 80, 60, 40]) {
      const overlay = makeOverlay({ rows });
      try {
        const raw = overlay.render(width);
        const text = plain(raw);
        assert.ok(
          raw.length <= rows,
          `rows=${rows} width=${width}: rendered ${raw.length} lines`,
        );
        for (const line of raw) {
          assert.ok(
            visibleWidth(line) <= width,
            `rows=${rows} width=${width}: line too wide (${visibleWidth(line)}): ${JSON.stringify(line)}`,
          );
        }
        if (rows >= 3) {
          assert.ok(
            indexOf(text, /[\u280b\u2819\u2838\u2834\u2826\u2827\u2807\u280f]/) >= 0,
            `rows=${rows} width=${width}: the working indicator stays visible`,
          );
        }
        if (rows >= 8) {
          assert.ok(indexOf(text, "task 2/3") >= 0, `rows=${rows}: the status row fits`);
          assert.ok(indexOf(text, "scroll") > 0, `rows=${rows}: the footer fits`);
          assert.ok(indexOf(text, "TRANSCRIPT_ONE") >= 0, `rows=${rows}: the transcript fits`);
        }
        if (rows === 5) {
          assert.ok(indexOf(text, "#t1") >= 0, "a 5-row terminal keeps the footer facts");
          assert.ok(indexOf(text, "TRANSCRIPT_ONE") >= 0, "and still shows the transcript");
          assert.equal(indexOf(text, "task 2/3"), -1, "the status row yields before the footer");
        }
      } finally {
        overlay.dispose();
      }
    }
  }
});

test("short terminals keep the editor's cursor row and drop chrome, not content", () => {
  initTheme();
  for (const rows of [8, 5, 3]) {
    const editor: SteerEditorLike = {
      handleInput: () => {},
      render: () => [
        "EDITOR_TOP",
        "EDITOR_INPUT",
        `EDITOR_CURSOR${CURSOR_MARKER}`,
        "EDITOR_BOTTOM",
      ],
      getText: () => "",
      setText: () => {},
    };
    const overlay = makeOverlay({ rows, editor });
    try {
      const lines = overlay.render(60);
      assert.equal(lines.length, rows, `rows=${rows} frame is exactly the terminal`);
      assert.ok(
        lines.some((line) => line.includes(CURSOR_MARKER)),
        `rows=${rows} keeps the editor cursor row`,
      );
      if (rows >= 4) {
        assert.ok(
          lines.some((line) => line.includes("TRANSCRIPT_ONE")),
          `rows=${rows} keeps the transcript when the budget allows`,
        );
      }
    } finally {
      overlay.dispose();
    }
  }
});

test("the phase is stated once, whether or not the editor can embed it", () => {
  initTheme();
  // Embedding editor (production): the phase lives in the border only.
  const embedded = makeOverlay({ rows: 12 });
  try {
    const lines = plain(embedded.render(100));
    const mentions = lines.filter((line) => line.includes("Running websearch…"));
    assert.equal(mentions.length, 1, "the border states the phase exactly once");
    assert.match(mentions[0] ?? "", /^ *── /);
  } finally {
    embedded.dispose();
  }

  // Editor without border support: the detached row states it, not the status row.
  const detached = makeOverlay({
    rows: 12,
    editor: {
      handleInput: () => {},
      render: (width: number) => ["steer".padEnd(width)],
      getText: () => "",
      setText: () => {},
    },
  });
  try {
    const lines = plain(detached.render(100));
    const mentions = lines.filter((line) => line.includes("Running websearch…"));
    assert.equal(mentions.length, 1, "the detached row states the phase exactly once");
    assert.equal(mentions[0]?.includes("──"), false, "the detached row is not editor chrome");
  } finally {
    detached.dispose();
  }
});

test("hosts without child context get transcript, editor, and hints only", () => {
  initTheme();
  const overlay = makeOverlay({ rows: 12, info: undefined });
  try {
    const lines = plain(overlay.render(100));
    assert.ok(indexOf(lines, "TRANSCRIPT_ONE") >= 0);
    assert.ok(indexOf(lines, "esc back") >= 0, "key hints survive without context");
    assert.equal(indexOf(lines, "#t1"), -1, "no facts row without context");
    assert.equal(indexOf(lines, "task 2/3"), -1, "no status row without context");
  } finally {
    overlay.dispose();
  }
});
