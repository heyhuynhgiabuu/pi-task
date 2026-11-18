import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { killAgentPane, killAgentPaneStrict, killAgentPaneStrictAsync, splitWindowPane } from "../src/subagent/tmux.js";

type Pane = { pane_id: string; pane_width: number; pane_height: number; pane_index: number };

function withFakeTmux(
  panes: Pane[],
  mode: string | undefined,
  run: (calls: () => string[][]) => void,
  extra: Record<string, string> = {},
): void {
  const root = mkdtempSync(join(tmpdir(), "pi-task-tmux-largest-"));
  const log = join(root, "calls.jsonl");
  const executable = join(root, "tmux");
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_TMUX_LOG, JSON.stringify(args) + '\\n');
const panes = JSON.parse(process.env.FAKE_TMUX_PANES).map(p => ({ window_id: '@1', pid: '1234', ...p }));
const format = (s, p) => s.replace(/#\\{([^}]+)\\}/g, (_, key) => String(key === 'pane_active' ? +(p?.pane_id === (process.env.FAKE_FOCUSED || '%1')) : (p?.[key] ?? '')));
if (args[0] === 'display-message') {
  const fmt = args[args.length - 1];
  if (process.env.FAKE_DISPLAY_ERROR) { process.stderr.write(process.env.FAKE_DISPLAY_ERROR + '\\n'); process.exit(1); }
  const target = args.includes('-t') ? args[args.indexOf('-t') + 1] : (process.env.FAKE_FOCUSED || '%1');
  const pane = panes.find(p => p.pane_id === target);
  if (!pane) { process.stderr.write("can't find pane\\n"); process.exit(1); }
  process.stdout.write((process.env.FAKE_DISPLAY_OUTPUT ?? format(fmt, pane)) + '\\n');
} else if (args[0] === 'if-shell') {
  const target = args[args.indexOf('-t') + 1];
  if (process.env.FAKE_CHILD_VANISHED || !panes.some(p => p.pane_id === target)) { process.stderr.write("can't find pane\\n"); process.exit(1); }
  if (target === (process.env.FAKE_FOCUS_AT_SELECT || process.env.FAKE_FOCUSED || '%1')) {
    fs.appendFileSync(process.env.FAKE_TMUX_LOG, JSON.stringify(args[args.length - 1].split(' ')) + '\\n');
  }
} else if (args[0] === 'list-panes') {
  if (process.env.FAKE_LIST_FAIL) { process.stderr.write('list failed\\n'); process.exit(1); }
  const fmt = args[args.indexOf('-F') + 1];
  process.stdout.write(panes.map(p => format(fmt, p)).join('\\n') + '\\n');
} else if (args[0] === 'split-window') {
  const marker = process.env.FAKE_TMUX_LOG + '.split-failed';
  if (process.env.FAKE_FAIL_SPLIT && !fs.existsSync(marker)) {
    fs.writeFileSync(marker, 'failed');
    process.stderr.write(process.env.FAKE_FAIL_SPLIT + '\\n');
    process.exit(1);
  }
  process.stdout.write('%99\\n');
}
`);
  chmodSync(executable, 0o755);
  const env: Record<string, string | undefined> = {
    PATH: `${root}:${process.env.PATH ?? ""}`,
    TMUX_PANE: "%1",
    TMUX: "/tmp/fake,1234,0",
    PI_TASK_TMUX_TARGET: mode,
    PI_TASK_TMUX_SPLIT: undefined,
    FAKE_TMUX_LOG: log,
    FAKE_TMUX_PANES: JSON.stringify(panes),
    FAKE_LIST_FAIL: undefined,
    FAKE_FAIL_SPLIT: undefined,
    FAKE_FOCUSED: undefined,
    FAKE_FOCUS_AT_SELECT: undefined,
    FAKE_CHILD_VANISHED: undefined,
    FAKE_DISPLAY_ERROR: undefined,
    FAKE_DISPLAY_OUTPUT: undefined,
    ...extra,
  };
  const previous = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    run(() => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]));
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

const panes: Pane[] = [
  { pane_id: "%1", pane_width: 70, pane_height: 60, pane_index: 0 },
  { pane_id: "%2", pane_width: 130, pane_height: 45, pane_index: 1 },
  { pane_id: "%3", pane_width: 40, pane_height: 40, pane_index: 2 },
];

function splitArgs(calls: string[][]): string[] {
  const split = calls.find((call) => call[0] === "split-window");
  assert.ok(split, "split-window invoked");
  return split;
}

test("largest target splits the largest pane without shifting focus or losing the parent", { skip: process.platform === "win32" }, () => {
  withFakeTmux(panes, "largest", (calls) => {
    assert.deepEqual(splitWindowPane("/tmp", "echo ok"), { paneId: "%99", originalPane: "%1" });
    const commands = calls();
    const list = commands.find((call) => call[0] === "list-panes");
    assert.ok(list, "panes are enumerated");
    assert.equal(list[list.indexOf("-t") + 1], "%1", "listing is scoped to the parent's window");
    const split = splitArgs(commands);
    assert.equal(split[split.indexOf("-t") + 1], "%2");
    assert.ok(split.includes("-h"), "orientation uses the largest pane's geometry");
    assert.ok(split.includes("-d"), "split does not take focus");
    assert.equal(commands.filter((call) => call[0] === "select-pane" || call[0] === "select-layout").length, 0);
    assert.equal(commands.length, 2, "largest mode needs just one listing and one split");
    killAgentPane("%99", "%1");
    assert.equal(calls().some((call) => call[0] === "select-pane"), false, "missing child does not change focus");
  });
});

test("largest mode preserves the Pi parent when another pane has focus", { skip: process.platform === "win32" }, () => {
  withFakeTmux(panes, "largest", (calls) => {
    assert.deepEqual(splitWindowPane("/tmp", "echo ok"), { paneId: "%99", originalPane: "%1" });
    const list = calls().find((call) => call[0] === "list-panes");
    assert.ok(list);
    assert.equal(list[list.indexOf("-t") + 1], "%1");
  }, { FAKE_FOCUSED: "%3" });
});

test("default mode preserves the current-pane split and command count", { skip: process.platform === "win32" }, () => {
  withFakeTmux(panes, undefined, (calls) => {
    assert.deepEqual(splitWindowPane("/tmp", "echo ok"), { paneId: "%99", originalPane: "%1" });
    const commands = calls();
    assert.equal(commands.some((call) => call[0] === "list-panes"), false);
    assert.equal(commands.length, 3);
    const split = splitArgs(commands);
    assert.equal(split[split.indexOf("-t") + 1], "%1");
    assert.ok(split.includes("-v"));
  });
});

test("largest targeting respects orientation overrides and resolves ties deterministically", { skip: process.platform === "win32" }, () => {
  const tied = [panes[0]!, panes[1]!, { pane_id: "%4", pane_width: 130, pane_height: 45, pane_index: 3 }];
  withFakeTmux(tied, "largest", (calls) => {
    splitWindowPane("/tmp", "echo ok");
    const split = splitArgs(calls());
    assert.equal(split[split.indexOf("-t") + 1], "%2");
    assert.ok(split.includes("-v"));
  }, { PI_TASK_TMUX_SPLIT: "vertical" });
});

test("successive launches re-read geometry rather than caching the target", { skip: process.platform === "win32" }, () => {
  withFakeTmux(panes, "largest", (calls) => {
    splitWindowPane("/tmp", "echo ok");
    process.env.FAKE_TMUX_PANES = JSON.stringify([
      panes[0], { ...panes[1], pane_width: 20 }, { ...panes[2], pane_width: 200 },
    ]);
    splitWindowPane("/tmp", "echo ok");
    const splits = calls().filter((call) => call[0] === "split-window");
    assert.deepEqual(splits.map((call) => call[call.indexOf("-t") + 1]), ["%2", "%3"]);
    assert.equal(calls().filter((call) => call[0] === "list-panes").length, 2);
  });
});

test("stale parent identity falls back to the current pane", { skip: process.platform === "win32" }, () => {
  withFakeTmux(panes, "largest", (calls) => {
    assert.deepEqual(splitWindowPane("/tmp", "echo ok"), { paneId: "%99", originalPane: "%3" });
    const list = calls().filter((call) => call[0] === "list-panes");
    assert.deepEqual(list.map((call) => call[call.indexOf("-t") + 1]), ["%1", "%3"]);
  }, { TMUX: "/tmp/fake,9999,0", FAKE_FOCUSED: "%3" });
});

test("a vanished largest pane is retried once against the parent", { skip: process.platform === "win32" }, () => {
  withFakeTmux(panes, "largest", (calls) => {
    assert.deepEqual(splitWindowPane("/tmp", "echo ok"), { paneId: "%99", originalPane: "%1" });
    const splits = calls().filter((call) => call[0] === "split-window");
    assert.equal(splits.length, 2);
    assert.equal(splits[0]![splits[0]!.indexOf("-t") + 1], "%2");
    assert.equal(splits[1]![splits[1]!.indexOf("-t") + 1], "%1");
    assert.ok(splits[1]!.includes("-v"), "fallback uses parent geometry");
  }, { FAKE_FAIL_SPLIT: "can't find pane: %2" });
});

test("ambiguous split failure is not retried", { skip: process.platform === "win32" }, () => {
  withFakeTmux(panes, "largest", (calls) => {
    assert.throws(() => splitWindowPane("/tmp", "echo ok"));
    assert.equal(calls().filter((call) => call[0] === "split-window").length, 1);
  }, { FAKE_FAIL_SPLIT: "server failed" });
});

test("a failed pane listing falls back to the original pane", { skip: process.platform === "win32" }, () => {
  withFakeTmux(panes, "largest", (calls) => {
    assert.deepEqual(splitWindowPane("/tmp", "echo ok"), { paneId: "%99", originalPane: "%1" });
    const split = splitArgs(calls());
    assert.equal(split[split.indexOf("-t") + 1], "%1");
  }, { FAKE_LIST_FAIL: "1" });
});

for (const [name, cleanup] of [["best-effort", killAgentPane], ["strict", killAgentPaneStrict]] as const) {
  test(`${name} cleanup restores focus only for an active, existing child`, { skip: process.platform === "win32" }, () => {
    for (const [child, focused, shouldSelect] of [["%2", "%2", true], ["%2", "%3", false], ["%99", "%3", false]] as const) {
      withFakeTmux(panes, undefined, (calls) => {
        cleanup(child, "%1");
        assert.equal(calls().some((call) => call[0] === "select-pane"), shouldSelect);
        if (shouldSelect) assert.deepEqual(calls().find((call) => call[0] === "select-pane"), ["select-pane", "-t", "%1"]);
        assert.equal(calls().some((call) => call[0] === "kill-pane"), name === "best-effort" || child !== "%99");
      }, { FAKE_FOCUSED: focused });
    }
  });

  test(`${name} cleanup rechecks focus and existence at selection`, { skip: process.platform === "win32" }, () => {
    for (const extra of [{ FAKE_FOCUS_AT_SELECT: "%3" }, { FAKE_CHILD_VANISHED: "1" }]) {
      withFakeTmux(panes, undefined, (calls) => {
        cleanup("%2", "%1");
        assert.equal(calls().some((call) => call[0] === "select-pane"), false);
        assert.equal(calls().some((call) => call[0] === "kill-pane"), true);
      }, { FAKE_FOCUSED: "%2", ...extra });
    }
  });
}

test("strict sync cleanup retains missing, unavailable, and identity semantics", { skip: process.platform === "win32" }, () => {
  for (const [error, throws] of [["can't find pane: %2", false], ["no server running", true]] as const) {
    withFakeTmux(panes, undefined, (calls) => {
      if (throws) assert.throws(() => killAgentPaneStrict("%2", "%1"), /no server running/);
      else killAgentPaneStrict("%2", "%1");
      assert.deepEqual(calls().map((call) => call[0]), ["display-message"]);
    }, { FAKE_DISPLAY_ERROR: error });
  }
  withFakeTmux(panes, undefined, (calls) => {
    killAgentPaneStrict("%2", "%1");
    assert.deepEqual(calls().map((call) => call[0]), ["display-message"]);
  }, { FAKE_DISPLAY_OUTPUT: "" });
  withFakeTmux(panes, undefined, (calls) => {
    assert.throws(() => killAgentPaneStrict("%2", "%1"), /identity mismatch/);
    assert.deepEqual(calls().map((call) => call[0]), ["display-message"]);
  }, { FAKE_DISPLAY_OUTPUT: "%3 1" });
});

test("strict async cleanup preserves kill error semantics and ignores focus errors", async () => {
  for (const mode of ["select-error", "kill-missing", "kill-unavailable"] as const) {
    const calls: string[] = [];
    const run = async (args: readonly string[]) => {
      calls.push(args[0]!);
      if (args[0] === "display-message") return "%2 1";
      if (args[0] === "if-shell" && mode === "select-error") throw new Error("can't find pane: %1");
      if (args[0] === "kill-pane" && mode === "kill-missing") throw new Error("can't find pane: %2");
      if (args[0] === "kill-pane" && mode === "kill-unavailable") throw new Error("no server running");
      return "";
    };
    if (mode === "kill-unavailable") await assert.rejects(killAgentPaneStrictAsync("%2", "%1", run), /no server running/);
    else await killAgentPaneStrictAsync("%2", "%1", run);
    assert.deepEqual(calls, ["display-message", "if-shell", "kill-pane"]);
  }
});

test("strict async cleanup restores only an active child and rechecks races", async () => {
  for (const scenario of ["active", "other", "missing", "empty", "focus-changed", "child-gone", "unavailable", "mismatch"] as const) {
    const calls: string[][] = [];
    let selected = false;
    const run = async (args: readonly string[]) => {
      calls.push([...args]);
      if (args[0] === "display-message") {
        if (scenario === "missing") throw new Error("can't find pane: %2");
        if (scenario === "empty") return "";
        if (scenario === "unavailable") throw new Error("no server running");
        if (scenario === "mismatch") return "%3 1";
        return `%2 ${scenario === "other" ? "0" : "1"}`;
      }
      if (args[0] === "if-shell") {
        if (scenario === "child-gone") throw new Error("can't find pane: %2");
        selected = scenario === "active";
      }
      return "";
    };
    if (scenario === "unavailable") await assert.rejects(killAgentPaneStrictAsync("%2", "%1", run), /no server running/);
    else if (scenario === "mismatch") await assert.rejects(killAgentPaneStrictAsync("%2", "%1", run), /identity mismatch/);
    else await killAgentPaneStrictAsync("%2", "%1", run);
    assert.deepEqual(calls[0], ["display-message", "-p", "-t", "%2", "#{pane_id} #{pane_active}"]);
    assert.equal(selected, scenario === "active", scenario);
    assert.equal(calls.some((call) => call[0] === "kill-pane"), !["missing", "empty", "unavailable", "mismatch"].includes(scenario), scenario);
    if (calls.some((call) => call[0] === "if-shell")) {
      assert.deepEqual(calls.find((call) => call[0] === "if-shell"), ["if-shell", "-F", "-t", "%2", "#{pane_active}", "select-pane -t %1"]);
    }
  }
});
