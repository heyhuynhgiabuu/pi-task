import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { CustomMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import {
  Box,
  type TuiMouseButton,
  type TuiMouseEvent,
  type TuiMouseEventType,
} from "@earendil-works/pi-tui";

import { createTaskCompleteRenderer } from "../src/tool/taskComplete.js";

{
  const t = "parenthesized expand hint closes dim paren";
  const src = readFileSync(
    fileURLToPath(new URL("../src/tool/renderTaskResultBody.ts", import.meta.url)),
    "utf8",
  );
  assert.ok(src.includes("parenthesizedExpandHint"), t);
  assert.ok(
    src.includes('theme.fg("dim", ")")'),
    t + " trailing paren dim",
  );
  assert.ok(!src.includes('` (${expandHint})`'), t + " no broken wrapper");
}

{
  const t = "renderCall uses description before live stats";
  const src = readFileSync(
    fileURLToPath(new URL("../src/tool/renderCall.ts", import.meta.url)),
    "utf8",
  );
  assert.ok(src.includes("toolUses === 0 && elapsedMs < 1_000"), t);
  assert.ok(src.includes("renderTaskTitleText"), t);
}

{
  // Background completion cards (custom `task-complete` messages) are hosted by
  // pi's CustomMessageComponent, a Container. Like a native tool card, a left
  // click on the title row toggles only that card; the TUI forwards the event
  // Container -> Box -> title region, so the real classes are driven here.
  const t = "task-complete card title click toggles";
  initTheme();
  const W = 80;
  const renderer = createTaskCompleteRenderer();
  const message = {
    role: "custom" as const,
    customType: "task-complete",
    content: "",
    display: true,
    timestamp: 0,
    details: {
      background: true,
      agent_type: "explore",
      description: "Map the module",
      summary: "one line summary",
      findings: "what changed",
      structured_result: true,
    },
  };
  const stripAnsi = (line: string) =>
    line
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
      .replace(/\x1b\][^\x07]*\x07/g, "");
  const card = new CustomMessageComponent(message as never, renderer as never);
  const lines = () => card.render(W).map(stripAnsi);
  const rowOf = (needle: string) => {
    const y = lines().findIndex((line) => line.includes(needle));
    assert.ok(y >= 0, `${t}: row with "${needle}"`);
    return y;
  };
  const mouse = (
    y: number,
    type: TuiMouseEventType = "click",
    button: TuiMouseButton = "left",
    extra: Partial<TuiMouseEvent> = {},
  ): TuiMouseEvent => ({
    type,
    button,
    x: 2,
    y,
    screenX: 2,
    screenY: y,
    width: W,
    height: lines().length,
    shift: false,
    alt: false,
    ctrl: false,
    ...extra,
  });

  assert.ok(
    card.children.some((child) => child instanceof Box),
    t + " card is a Box",
  );
  const isExpanded = () => lines().some((line) => line.includes("what changed"));
  assert.equal(isExpanded(), false, t + " starts collapsed");
  assert.ok(
    lines().some((line) => line.includes("to expand")),
    t + " collapsed hint",
  );

  const titleY = rowOf("explore");
  const bodyY = rowOf("one line summary");
  assert.ok(bodyY !== titleY, t + " body row distinct from title");

  let result = card.handleMouse(mouse(titleY));
  assert.equal(result?.handled, true, t + " title click handled");
  assert.equal(result?.focus, undefined, t + " no focus steal");
  assert.equal(result?.render, undefined, t + " click keeps TUI repaint default");
  assert.equal(isExpanded(), true, t + " first click expands");
  assert.ok(
    lines().some((line) => line.includes("to collapse")),
    t + " expanded hint",
  );

  result = card.handleMouse(mouse(rowOf("explore")));
  assert.equal(result?.handled, true, t + " second title click handled");
  assert.equal(isExpanded(), false, t + " second click collapses");

  // Unrelated input falls through to the TUI untouched.
  const before = lines();
  for (const [label, event] of [
    ["body click", mouse(bodyY)],
    ["title wheel", mouse(titleY, "wheel", "none", { wheelDelta: -3 })],
    ["title right click", mouse(titleY, "click", "right")],
    ["title press", mouse(titleY, "press")],
    ["title release", mouse(titleY, "release")],
    ["title move", mouse(titleY, "move", "none")],
    ["below card", mouse(lines().length)],
  ] as const) {
    assert.equal(card.handleMouse(event), undefined, `${t}: ${label} ignored`);
  }
  assert.deepEqual(lines(), before, t + " ignored input leaves card unchanged");

  // Per-card state: a second card with the same renderer is independent.
  const other = new CustomMessageComponent(message as never, renderer as never);
  const otherLines = () => other.render(W).map(stripAnsi);
  const otherExpanded = () =>
    otherLines().some((line) => line.includes("what changed"));
  assert.equal(
    card.handleMouse(mouse(rowOf("explore")))?.handled,
    true,
    t + " toggle first card",
  );
  assert.equal(isExpanded(), true, t + " first card expanded");
  assert.equal(otherExpanded(), false, t + " second card untouched");
  const otherTitleY = otherLines().findIndex((line) => line.includes("explore"));
  assert.equal(
    other.handleMouse({
      ...mouse(otherTitleY),
      height: otherLines().length,
    })?.handled,
    true,
    t + " toggle second card",
  );
  assert.equal(otherExpanded(), true, t + " second card expanded");
  assert.equal(isExpanded(), true, t + " first card keeps its choice");

  // The renderer-supplied flag (Ctrl+O) seeds the card. Rebuilding through
  // setExpanded re-runs the renderer, so a global toggle resets a local click.
  card.setExpanded(true);
  assert.equal(isExpanded(), true, t + " supplied expanded respected");
  assert.equal(
    card.handleMouse(mouse(rowOf("explore")))?.handled,
    true,
    t + " collapse while globally expanded",
  );
  assert.equal(isExpanded(), false, t + " local collapse under global expand");
  card.setExpanded(false);
  assert.equal(isExpanded(), false, t + " global collapse keeps it collapsed");
  card.setExpanded(true);
  assert.equal(isExpanded(), true, t + " global expand resets local choice");

  // No details: the renderer still returns undefined so pi falls back to its
  // default custom-message rendering instead of an empty card.
  assert.equal(
    renderer(
      { details: { phase: "done" } },
      {} as never,
      { fg: (_s: string, text: string) => text, bg: (_s: string, text: string) => text } as never,
    ),
    undefined,
    t + " empty renderer returns undefined",
  );
  const bare = new CustomMessageComponent(
    { ...message, details: { phase: "done" } } as never,
    renderer as never,
  );
  assert.ok(
    bare.render(W).some((line) => stripAnsi(line).includes("[task-complete]")),
    t + " host falls back to default rendering",
  );
}

console.log("renderHint.test.ts: all passed");