import test from "node:test";
import assert from "node:assert/strict";

import { renderTaskWidget, type WidgetTask } from "../src/task-widget.js";

test("task widget prefixes in-progress spinner with a leading space", () => {
  const lines = renderTaskWidget({
    foregroundTasks: [
      [
        "task-1",
        {
          agentType: "general",
          description: "foreground run",
          startedAt: 0,
          toolUses: 0,
          recentCalls: [],
        },
      ],
    ],
    backgroundTasks: [
      [
        "task-2",
        {
          agentType: "reviewer",
          description: "background run",
          startedAt: 0,
          toolUses: 0,
          recentCalls: [],
        },
      ],
    ],
    foregroundCount: 1,
    backgroundCount: 1,
    width: 120,
    now: 0,
  });

  assert.match(lines[0] ?? "", /^ ⠋ /, "foreground header has leading space before spinner");
  assert.match(lines[2] ?? "", /· 0 tools$/, "background header shows metadata only");
  assert.match(lines[3] ?? "", /  └─  ⠋ waiting$/, "background tool detail uses a tree connector with spinner");
});

test("background widget uses tree connector and collapses older tool calls", () => {
  const lines = renderTaskWidget({
    foregroundTasks: [],
    backgroundTasks: [["task-1", {
      agentType: "general",
      description: "background run",
      startedAt: 0,
      toolUses: 3,
      recentCalls: [
        { name: "read", detail: "a.ts", status: "done" },
        { name: "grep", detail: "pattern", status: "done" },
        { name: "edit", detail: "b.ts", status: "in_progress" },
      ],
    }]],
    foregroundCount: 0,
    backgroundCount: 1,
    width: 120,
    now: 0,
  });

  assert.match(lines[0] ?? "", /· 3 tools$/, "background header stays single metadata line");
  assert.match(lines[1] ?? "", /  └─  ⠋ edit  b\.ts \(\+2 more\)$/, "background detail line shows latest call with collapsed count");
});

test("background latest tool spacing is consistent for done and error states", () => {
  const doneLines = renderTaskWidget({
    foregroundTasks: [],
    backgroundTasks: [["task-1", {
      agentType: "general",
      description: "done run",
      startedAt: 0,
      toolUses: 1,
      recentCalls: [{ name: "read", detail: "a.ts", status: "done" }],
    }]],
    foregroundCount: 0,
    backgroundCount: 1,
    width: 120,
    now: 0,
  });
  const errorLines = renderTaskWidget({
    foregroundTasks: [],
    backgroundTasks: [["task-2", {
      agentType: "general",
      description: "error run",
      startedAt: 0,
      toolUses: 1,
      recentCalls: [{ name: "bash", detail: "fail", status: "error" }],
    }]],
    foregroundCount: 0,
    backgroundCount: 1,
    width: 120,
    now: 0,
  });

  assert.match(doneLines[1] ?? "", /  └─ ✓  read  a\.ts$/, "done status keeps tree layout and two spaces after marker");
  assert.match(errorLines[1] ?? "", /  └─ ✗  bash  fail$/, "error status keeps tree layout and two spaces after marker");
});

test("foreground widget renders a single tree connector for the latest tool call", () => {
  const lines = renderTaskWidget({
    foregroundTasks: [
      [
        "task-1",
        {
          agentType: "general",
          description: "foreground run",
          startedAt: 0,
          toolUses: 3,
          recentCalls: [
            { name: "read", detail: "a.ts", status: "done" },
            { name: "grep", detail: "pattern", status: "done" },
            { name: "edit", detail: "b.ts", status: "in_progress" },
          ],
        },
      ],
    ],
    backgroundTasks: [],
    foregroundCount: 1,
    backgroundCount: 0,
    width: 120,
    now: 0,
  });

  assert.equal(lines.filter((line) => line.includes("└─")).length, 1, "renders only one connector line");
  assert.match(lines[1] ?? "", /└─ .*edit  b\.ts \(\+2 more\)$/, "shows latest call and collapses older ones");
});

test("task widget shows the running phase next to an advancing spinner frame", () => {
  const task: WidgetTask = {
    agentType: "general",
    description: "search the repo",
    startedAt: 0,
    toolUses: 1,
    activity: { phase: "tool", label: "Running websearch\u2026" },
    recentCalls: [{ id: "c1", name: "websearch", detail: "pi task", status: "in_progress" }],
  };
  const render = (now: number) =>
    renderTaskWidget({
      foregroundTasks: [["task-1", task]],
      backgroundTasks: [],
      foregroundCount: 1,
      backgroundCount: 0,
      width: 120,
      now,
    });

  const first = render(0)[0] ?? "";
  assert.match(first, /Running websearch\u2026/, "the row names the phase it is in");
  assert.match(first, /^ \u280B /, "frame 0 of the spinner");
  assert.match(render(80)[0] ?? "", /^ \u2819 /, "the next frame follows one interval later");

  const background = renderTaskWidget({
    foregroundTasks: [],
    backgroundTasks: [["task-2", { ...task, activity: { phase: "running", label: "Running\u2026" } }]],
    foregroundCount: 0,
    backgroundCount: 1,
    width: 120,
    now: 0,
  });
  assert.match(
    background[0] ?? "",
    /\u00b7 Running\u2026 \u2022 /,
    "background rows name their phase too",
  );
});

test("task widget leaves settled tasks without a phase segment", () => {
  const lines = renderTaskWidget({
    foregroundTasks: [
      [
        "task-1",
        {
          agentType: "general",
          description: "finished run",
          startedAt: 0,
          toolUses: 1,
          status: "done",
          recentCalls: [{ id: "c1", name: "read", detail: "a.ts", status: "done" }],
        },
      ],
    ],
    backgroundTasks: [],
    foregroundCount: 1,
    backgroundCount: 0,
    width: 120,
    now: 0,
  });

  assert.doesNotMatch(lines[0] ?? "", /Running|Thinking|Streaming/, "no phase for a settled task");
  assert.match(lines[0] ?? "", /\u2022 1 tool$/, "the row still renders its metadata");
});

import { visibleWidth } from "@earendil-works/pi-tui";
import { renderTaskPanel } from "../src/task-widget.js";

test("renderTaskPanel shows the main row and task rows with identity-tracked selection", () => {
  const lines = renderTaskPanel({
    rows: [
      {
        id: "t1",
        agentType: "general",
        description: "implement fix",
        status: "running",
        startedAt: 1000,
        activity: "$ git status",
      },
      {
        id: "t2",
        agentType: "reviewer",
        description: "audit diff",
        status: "done",
        startedAt: 2000,
        finishedAt: 9000,
      },
    ],
    selection: { taskId: "t1" },
    viewTaskId: null,
    now: 10_000,
    width: 120,
  });
  assert.equal(lines.length, 4);
  assert.match(lines[0] ?? "", /tasks \(2\)/);
  assert.match(lines[1] ?? "", /^   main$/);
  assert.match(lines[2] ?? "", /^❯ ✻ general/);
  assert.match(lines[2] ?? "", /\$ git status/);
  assert.match(lines[3] ?? "", /^  ✓ reviewer/);
});

test("renderTaskPanel view mode labels typing destination and marks the viewed row", () => {
  const lines = renderTaskPanel({
    rows: [
      {
        id: "t1",
        agentType: "general",
        description: "implement fix",
        status: "running",
        startedAt: 1000,
      },
    ],
    selection: { taskId: "t1" },
    viewTaskId: "t1",
    now: 5000,
    width: 120,
  });
  assert.match(lines[0] ?? "", /viewing @t1/);
  assert.match(lines[0] ?? "", /typing goes to the task/);
  assert.match(lines[2] ?? "", /^❯ ✻ general/);
});

test("renderTaskPanel selection of main shows marker on the main row", () => {
  const lines = renderTaskPanel({
    rows: [
      {
        id: "t1",
        agentType: "general",
        description: "implement fix",
        status: "running",
        startedAt: 1000,
      },
    ],
    selection: "main",
    viewTaskId: null,
    now: 5000,
    width: 120,
  });
  assert.match(lines[1] ?? "", /^❯  main$/);
  assert.match(lines[2] ?? "", /^  ✻ general/);
});

test("renderTaskPanel truncates rows to the terminal width", () => {
  const lines = renderTaskPanel({
    rows: [
      {
        id: "t1",
        agentType: "general",
        description: "x".repeat(500),
        status: "running",
        startedAt: 1000,
      },
    ],
    selection: null,
    viewTaskId: null,
    now: 5000,
    width: 40,
  });
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= 40, `line too wide: ${visibleWidth(line)}`);
  }
});

test("finished section renders failure/abort icons instead of a green check", () => {
  const failedLines = renderTaskWidget({
    foregroundTasks: [],
    backgroundTasks: [],
    foregroundCount: 0,
    backgroundCount: 0,
    width: 120,
    now: 0,
    finishedTasks: [
      ["t-failed", { agentType: "general", description: "boom", startedAt: 0, toolUses: 0, status: "failed" }],
    ],
  });
  assert.match(failedLines[0] ?? "", /✗/, "failed tasks show an error icon");
  assert.doesNotMatch(failedLines[0] ?? "", /✓/, "failed tasks must not show a green check");

  const abortedLines = renderTaskWidget({
    foregroundTasks: [],
    backgroundTasks: [],
    foregroundCount: 0,
    backgroundCount: 0,
    width: 120,
    now: 0,
    finishedTasks: [
      ["t-abort", { agentType: "general", description: "halt", startedAt: 0, toolUses: 0, status: "aborted" }],
    ],
  });
  assert.match(abortedLines[0] ?? "", /■/, "aborted tasks show a stop icon");
});
