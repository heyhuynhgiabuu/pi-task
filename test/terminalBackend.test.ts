import assert from "node:assert/strict";
import test from "node:test";

import {
  createDefaultCommandRunner,
  createTmuxTerminalBackend,
} from "../src/subagent/terminalBackend.js";

test("tmux terminal backend preserves the launch handle contract", async () => {
  const calls: string[][] = [];
  const backend = createTmuxTerminalBackend({
    run: async (_command, args) => {
      calls.push([...args]);
      return { stdout: "%42\n", stderr: "" };
    },
  });

  const handle = await backend.launch({
    cwd: "/repo",
    command: "pi --session task",
    direction: "right",
  });

  assert.deepEqual(handle, {
    backend: "tmux",
    resourceId: "%42",
  });
  assert.deepEqual(calls, [[
    "split-window",
    "-h",
    "-d",
    "-P",
    "-F",
    "#{pane_id}",
    "-c",
    "/repo",
    "pi --session task",
  ]]);
});

test("tmux terminal backend requires a launch command", async () => {
  const backend = createTmuxTerminalBackend({
    run: async () => {
      throw new Error("tmux should not run without a command");
    },
  });

  await assert.rejects(
    backend.launch({ cwd: "/repo" }),
    /tmux backend requires a launch command/,
  );
});

test("tmux terminal backend auto-detects from current pane geometry", async () => {
  const calls: string[][] = [];
  const backend = createTmuxTerminalBackend({
    run: async (_command, args) => {
      calls.push([...args]);
      return calls.length === 1
        ? { stdout: "120 30\n", stderr: "" }
        : { stdout: "%43\n", stderr: "" };
    },
  });

  const handle = await backend.launch({ cwd: "/repo", command: "pi" });

  assert.equal(handle.resourceId, "%43");
  assert.deepEqual(calls, [
    ["display-message", "-p", "#{pane_width} #{pane_height}"],
    [
      "split-window",
      "-h",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-c",
      "/repo",
      "pi",
    ],
  ]);
});

test("tmux terminal backend honors PI_TASK_TMUX_SPLIT", async () => {
  const previousMode = process.env.PI_TASK_TMUX_SPLIT;
  process.env.PI_TASK_TMUX_SPLIT = "vertical";
  try {
    const calls: string[][] = [];
    const backend = createTmuxTerminalBackend({
      run: async (_command, args) => {
        calls.push([...args]);
        return { stdout: "%44\n", stderr: "" };
      },
    });

    await backend.launch({ cwd: "/repo", command: "pi" });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.[1], "-v");
  } finally {
    if (previousMode === undefined) {
      delete process.env.PI_TASK_TMUX_SPLIT;
    } else {
      process.env.PI_TASK_TMUX_SPLIT = previousMode;
    }
  }
});

test("default command runner applies a kill timeout so a wedged CLI cannot stall polling", async () => {
  const t = "default command runner";
  const runner = createDefaultCommandRunner();
  const started = Date.now();
  await assert.rejects(
    runner.run("sleep", ["5"], { timeoutMs: 150 }),
    /exited unsuccessfully/,
    t + ": hung command is rejected",
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2_000, `${t}: timeout fired promptly (took ${elapsed}ms)`);
  const result = await runner.run("echo", ["hello"]);
  assert.equal(result.stdout.trim(), "hello", t + ": normal commands still resolve");
});
