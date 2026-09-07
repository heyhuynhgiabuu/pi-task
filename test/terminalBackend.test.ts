import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CLI_TIMEOUT_MS,
  createDefaultCommandRunner,
  createTmuxTerminalBackend,
} from "../src/subagent/terminalBackend.js";
import {
  probePane,
  probePaneAsync,
  tmuxSteerPaneAsync,
} from "../src/subagent/tmux.js";

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

test("tmux pane probes distinguish alive, missing, and unavailable", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-tmux-probe-"));
  const originalPath = process.env.PATH;
  try {
    const binDir = join(root, "bin");
    mkdirSync(binDir);
    const tmux = join(binDir, "tmux");
    writeFileSync(
      tmux,
      `#!/bin/sh
case "$PI_TASK_TEST_TMUX_PROBE" in
  alive) printf '%%42\\n' ;;
  missing) printf '%s\\n' "can't find pane: %%42" >&2; exit 1 ;;
  unavailable) printf '%s\\n' 'no server running on /tmp/tmux' >&2; exit 1 ;;
esac
`,
    );
    chmodSync(tmux, 0o755);
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;

    process.env.PI_TASK_TEST_TMUX_PROBE = "alive";
    assert.deepEqual(probePane("%42"), { state: "alive" });
    process.env.PI_TASK_TEST_TMUX_PROBE = "missing";
    assert.deepEqual(probePane("%42"), { state: "missing" });
    process.env.PI_TASK_TEST_TMUX_PROBE = "unavailable";
    const result = probePane("%42");
    assert.equal(result.state, "unavailable");
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    delete process.env.PI_TASK_TEST_TMUX_PROBE;
    rmSync(root, { recursive: true, force: true });
  }
});

test("async tmux pane probes preserve missing versus unavailable", async () => {
  let mode: "alive" | "missing" | "unavailable" = "alive";
  const run = async () => {
    if (mode === "alive") return "%42\n";
    const error = new Error("tmux command failed") as Error & { stderr: string };
    error.stderr = mode === "missing"
      ? "can't find pane: %42"
      : "no server running on /tmp/tmux";
    throw error;
  };

  assert.deepEqual(await probePaneAsync("%42", run), { state: "alive" });
  mode = "missing";
  assert.deepEqual(await probePaneAsync("%42", run), { state: "missing" });
  mode = "unavailable";
  const unavailable = await probePaneAsync("%42", run);
  assert.equal(unavailable.state, "unavailable");
});

test("async tmux steering uses argument-safe command calls", async () => {
  const calls: Array<{ args: string[]; input?: string }> = [];
  await tmuxSteerPaneAsync("%42", "hello\nworld", async (args, input) => {
    calls.push({ args: [...args], input });
    return "";
  });

  assert.deepEqual(calls.map(({ args }) => args[0]), [
    "load-buffer",
    "paste-buffer",
    "delete-buffer",
    "send-keys",
  ]);
  assert.equal(calls[0]?.input, "hello\nworld");
  assert.deepEqual(calls[1]?.args.slice(0, 4), ["paste-buffer", "-b", calls[0]?.args[2], "-t"]);
  assert.deepEqual(calls[3]?.args.slice(0, 3), ["send-keys", "-t", "%42"]);
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

test("CLI_TIMEOUT_MS pins the default kill bound at 30 seconds", () => {
  // The hung-command test above only exercises the timeoutMs override; this
  // pins the default value the polling latch relies on.
  assert.equal(CLI_TIMEOUT_MS, 30_000);
});
