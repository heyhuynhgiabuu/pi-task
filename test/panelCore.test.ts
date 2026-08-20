import test from "node:test";
import assert from "node:assert/strict";

import {
  DONE_ROW_LINGER_MS,
  FAILED_ROW_LINGER_MS,
  dispatchPanelKey,
  initialPanelState,
  isPanelFocused,
  panelRows,
  selectAt,
  selectionIndex,
  type TaskPanelRow,
} from "../src/panel/panel-core.js";

function row(over: Partial<TaskPanelRow> & { id: string }): TaskPanelRow {
  return {
    agentType: "general",
    description: "run",
    status: "running",
    startedAt: 1000,
    ...over,
  };
}

test("panelRows keeps running tasks first in spawn order", () => {
  const rows = panelRows(
    [
      row({ id: "b", startedAt: 2000 }),
      row({ id: "a", startedAt: 1000 }),
      row({ id: "z", startedAt: 3000, status: "done", finishedAt: 4000 }),
    ],
    6000,
    false,
  );
  assert.deepEqual(
    rows.map((r) => r.id),
    ["a", "b", "z"],
  );
});

test("panelRows orders finished newest first and ages done rows out of the idle view", () => {
  const oldDone = row({
    id: "old",
    status: "done",
    finishedAt: 1000,
    startedAt: 0,
  });
  const freshDone = row({
    id: "fresh",
    status: "done",
    finishedAt: 6000 - 100,
    startedAt: 0,
  });
  const now = 6000;
  assert.deepEqual(
    panelRows([oldDone, freshDone], now, false).map((r) => r.id),
    ["fresh"],
  );
  // Focused view retains aged-out rows.
  assert.deepEqual(
    panelRows([oldDone, freshDone], now, true).map((r) => r.id),
    ["fresh", "old"],
  );
});

test("panelRows uses per-status linger for non-done finishes", () => {
  const now = 100_000;
  const oldFailed = row({
    id: "old",
    status: "failed",
    finishedAt: now - FAILED_ROW_LINGER_MS - 1,
  });
  const freshFailed = row({
    id: "fresh",
    status: "failed",
    finishedAt: now - FAILED_ROW_LINGER_MS + 1,
  });
  const justDone = row({ id: "done", status: "done", finishedAt: now - 1 });
  const rows = panelRows([oldFailed, freshFailed, justDone], now, false);
  assert.deepEqual(
    rows.map((r) => r.id),
    ["done", "fresh"],
  );
  // Done linger is shorter than failed linger.
  const agedDone = row({ id: "aged", status: "done", finishedAt: now - DONE_ROW_LINGER_MS - 1 });
  assert.ok(!panelRows([agedDone], now, false).some((r) => r.id === "aged"));
});

test("selectionIndex maps main to 0, tasks to row index + 1, and self-corrects vanished tasks", () => {
  const rows = [row({ id: "a" }), row({ id: "b" })];
  assert.equal(selectionIndex(null, rows), null);
  assert.equal(selectionIndex("main", rows), 0);
  assert.equal(selectionIndex({ taskId: "a" }, rows), 1);
  assert.equal(selectionIndex({ taskId: "b" }, rows), 2);
  assert.equal(selectionIndex({ taskId: "gone" }, rows), 0);
});

test("selectAt clamps to the row range and maps index 0 to main", () => {
  const rows = [row({ id: "a" }), row({ id: "b" })];
  assert.equal(selectAt(rows, 0), "main");
  assert.deepEqual(selectAt(rows, 1), { taskId: "a" });
  assert.deepEqual(selectAt(rows, 2), { taskId: "b" });
  assert.deepEqual(selectAt(rows, 99), { taskId: "b" });
  assert.equal(selectAt(rows, -5), "main");
  assert.equal(selectAt([], 1), "main");
});

test("dispatchPanelKey: down enters navigation from main and moves through rows", () => {
  const rows = [row({ id: "a" })];
  const first = dispatchPanelKey("\x1b[B", null, rows, "panel");
  assert.deepEqual(first, { kind: "select", selection: { taskId: "a" } });
  // Up at main exits navigation in panel mode.
  const up = dispatchPanelKey("\x1b[A", "main", rows, "panel");
  assert.deepEqual(up, { kind: "clear" });
});

test("dispatchPanelKey: enter opens the selected task or returns to main", () => {
  const rows = [row({ id: "a" }), row({ id: "b" })];
  assert.deepEqual(dispatchPanelKey("\r", "main", rows, "panel"), {
    kind: "enter",
    taskId: null,
  });
  assert.deepEqual(dispatchPanelKey("\r", { taskId: "b" }, rows, "panel"), {
    kind: "enter",
    taskId: "b",
  });
});

test("dispatchPanelKey: x stops or dismisses a task row only", () => {
  const rows = [row({ id: "a" })];
  assert.deepEqual(dispatchPanelKey("x", "main", rows, "panel"), {
    kind: "unhandled",
  });
  assert.deepEqual(dispatchPanelKey("x", { taskId: "a" }, rows, "panel"), {
    kind: "stop",
    taskId: "a",
  });
});

test("dispatchPanelKey: escape clears and non-panel keys are unhandled", () => {
  const rows = [row({ id: "a" })];
  assert.deepEqual(dispatchPanelKey("\x1b", { taskId: "a" }, rows, "panel"), {
    kind: "clear",
  });
  assert.deepEqual(dispatchPanelKey("a", { taskId: "a" }, rows, "panel"), {
    kind: "unhandled",
  });
});

test("dispatchPanelKey: view mode holds at main so one up + enter returns to the conversation", () => {
  const rows = [row({ id: "a" })];
  assert.deepEqual(dispatchPanelKey("\x1b[A", "main", rows, "view"), {
    kind: "select",
    selection: "main",
  });
  // Up on a task moves toward main.
  assert.deepEqual(dispatchPanelKey("\x1b[A", { taskId: "a" }, rows, "view"), {
    kind: "select",
    selection: "main",
  });
  // Typing in the view is forwarded to the editor (steering).
  assert.deepEqual(dispatchPanelKey("t", { taskId: "a" }, rows, "view"), {
    kind: "unhandled",
  });
});

test("initialPanelState is unfocused", () => {
  const state = initialPanelState();
  assert.equal(isPanelFocused(state), false);
  assert.equal(state.selection, null);
  assert.equal(state.viewTaskId, null);
  state.viewTaskId = "a";
  assert.equal(isPanelFocused(state), true);
});
import {
  pruneFinishedEntries,
  DONE_ROW_LINGER_MS,
  FAILED_ROW_LINGER_MS,
} from "../src/panel/panel-core.js";

test("pruneFinishedEntries expires finished entries after their linger window", () => {
  const now = 100_000;
  const entries = [
    { id: "done-old", task: { status: "done" }, finishedAt: now - DONE_ROW_LINGER_MS - 1 },
    { id: "done-fresh", task: { status: "done" }, finishedAt: now - DONE_ROW_LINGER_MS + 1 },
    { id: "failed-fresh", task: { status: "failed" }, finishedAt: now - FAILED_ROW_LINGER_MS + 1 },
  ];
  const retained = pruneFinishedEntries(entries, null, now);
  assert.deepEqual(
    retained.map((e) => e.id),
    ["done-fresh", "failed-fresh"],
  );
});

test("pruneFinishedEntries retains the viewed task past its linger window", () => {
  const now = 100_000;
  const entries = [
    { id: "viewed", task: { status: "done" }, finishedAt: now - 60_000 },
    { id: "other", task: { status: "done" }, finishedAt: now - DONE_ROW_LINGER_MS - 1 },
  ];
  const retained = pruneFinishedEntries(entries, "viewed", now);
  assert.deepEqual(
    retained.map((e) => e.id),
    ["viewed"],
  );
});
