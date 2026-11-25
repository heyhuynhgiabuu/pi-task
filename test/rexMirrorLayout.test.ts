import test from "node:test";
import assert from "node:assert/strict";

import {
  launchAutoRexMirror,
  type RexMirrorLaunchInput,
  type RexMirrorLaunchOptions,
} from "../src/subagent/rex-mirror.js";

interface FakeWindow {
  windowId: string;
  blocks: string[];
}

interface FakeCall {
  command: string;
  args: readonly string[];
}

/** In-memory Rex session: inspect reads it, split/run mutate it. */
function createFakeRex(
  windows: FakeWindow[],
  inspectOverride?: () => string,
  windowIdInResponse = true,
) {
  const calls: FakeCall[] = [];
  let counter = 0;
  const runner: NonNullable<RexMirrorLaunchOptions["runner"]> = {
    async run(command, args) {
      calls.push({ command, args });
      // Yield so unserialized callers would interleave inspect and placement.
      await new Promise((resolve) => setTimeout(resolve, 2));
      if (command !== "rex") throw new Error(`unexpected command ${command}`);
      if (args[0] === "session" && args[1] === "inspect") {
        if (inspectOverride) return { stdout: inspectOverride(), stderr: "" };
        return {
          stdout: JSON.stringify({
            session_id: args[2],
            windows: windows.map((window) => ({
              window_id: window.windowId,
              label: "Window",
              layers: [
                {
                  layer_id: `layer-${window.windowId}`,
                  kind: "tiled",
                  blocks: window.blocks.map((blockId) => ({ block_id: blockId, label: "x" })),
                },
              ],
            })),
          }),
          stderr: "",
        };
      }
      const newId = `blk-new-${++counter}`;
      let createdWindowId: string | undefined;
      if (args[0] === "split") {
        const anchor = args[args.indexOf("-b") + 1]!;
        const target = windows.find((window) => window.blocks.includes(anchor));
        if (!target) throw new Error("rex exited unsuccessfully: block not found");
        target.blocks.push(newId);
      } else if (args[0] === "run") {
        createdWindowId = `win-new-${counter}`;
        windows.push({ windowId: createdWindowId, blocks: [newId] });
      } else {
        throw new Error(`unexpected rex subcommand ${args[0]}`);
      }
      const created: Record<string, unknown> = { block_ids: [newId] };
      if (createdWindowId && windowIdInResponse) created.window_id = createdWindowId;
      return { stdout: JSON.stringify(created), stderr: "" };
    },
  };
  return { calls, runner, windows };
}

function input(taskId: string): RexMirrorLaunchInput {
  return {
    taskId,
    agentType: "scout",
    description: "look around",
    cwd: "/repo",
    snapshotPath: `/tmp/${taskId}/live-transcript.json`,
  };
}

function options(
  runner: NonNullable<RexMirrorLaunchOptions["runner"]>,
  session: string,
  block = "blk-parent",
): RexMirrorLaunchOptions {
  return {
    env: { REX_SESSION: session, REX_BLOCK: block },
    execPath: "/usr/local/bin/node",
    viewerPath: "/pkg/rex-view.js",
    runner,
  };
}

function placements(calls: FakeCall[]): FakeCall[] {
  return calls.filter((call) => call.args[0] === "split" || call.args[0] === "run");
}

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

test("rex layout: four parallel launches go parent-right, new window, overflow-right, new window", async () => {
  const fake = createFakeRex([
    { windowId: "win-parent", blocks: ["blk-parent"] },
    { windowId: "win-user", blocks: ["blk-user-a"] },
  ]);
  const results = await Promise.all(
    ["t-1", "t-2", "t-3", "t-4"].map((taskId) =>
      launchAutoRexMirror(input(taskId), options(fake.runner, "sess-four")),
    ),
  );
  assert.deepEqual(
    results.map((result) => result.ok),
    [true, true, true, true],
  );

  const placed = placements(fake.calls);
  assert.deepEqual(
    placed.map((call) => call.args[0]),
    ["split", "run", "split", "run"],
  );
  assert.equal(flag(placed[0]!.args, "-b"), "blk-parent");
  assert.equal(flag(placed[0]!.args, "--split") ?? placed[0]!.args.find((a) => a.startsWith("--split=")), "--split=right");
  // Overflow right split anchors on the block the second launch created.
  assert.deepEqual(results[1], { ok: true, blockId: "blk-new-2" });
  assert.equal(flag(placed[2]!.args, "-b"), "blk-new-2");
  assert.ok(placed[2]!.args.includes("--split=right"));
  assert.ok(!placed[1]!.args.includes("-b"));

  // Never more than two blocks in a window, and the user's window is untouched.
  for (const window of fake.windows) assert.ok(window.blocks.length <= 2, window.windowId);
  assert.deepEqual(fake.windows.find((w) => w.windowId === "win-user")!.blocks, ["blk-user-a"]);
  assert.equal(fake.windows.length, 4);
});

test("rex layout: a parent window with a user block is never split", async () => {
  const fake = createFakeRex([{ windowId: "win-parent", blocks: ["blk-parent", "blk-user"] }]);
  const result = await launchAutoRexMirror(input("t-1"), options(fake.runner, "sess-full"));
  assert.deepEqual(result, { ok: true, blockId: "blk-new-1" });
  const placed = placements(fake.calls);
  assert.equal(placed.length, 1);
  assert.equal(placed[0]!.args[0], "run");
  assert.deepEqual(fake.windows[0]!.blocks, ["blk-parent", "blk-user"]);
});

test("rex layout: an overflow window that gained another block is no longer reused", async () => {
  const fake = createFakeRex([{ windowId: "win-parent", blocks: ["blk-parent", "blk-user"] }]);
  const sessionOptions = options(fake.runner, "sess-gone");
  const first = await launchAutoRexMirror(input("t-1"), sessionOptions);
  assert.deepEqual(first, { ok: true, blockId: "blk-new-1" });
  // The user dropped their own block into the overflow window.
  fake.windows.find((w) => w.blocks.includes("blk-new-1"))!.blocks.push("blk-user-2");

  const second = await launchAutoRexMirror(input("t-2"), sessionOptions);
  assert.deepEqual(second, { ok: true, blockId: "blk-new-2" });
  const placed = placements(fake.calls);
  assert.equal(placed[1]!.args[0], "run");

  // Ownership is by block id: an unrelated one-block window is not adopted.
  const third = createFakeRex([
    { windowId: "win-parent", blocks: ["blk-parent", "blk-user"] },
    { windowId: "win-other", blocks: ["blk-lonely"] },
  ]);
  await launchAutoRexMirror(input("t-3"), options(third.runner, "sess-adopt"));
  assert.equal(placements(third.calls)[0]!.args[0], "run");
  assert.deepEqual(third.windows[1]!.blocks, ["blk-lonely"]);
});

test("rex layout: an overflow window that was closed is dropped and a new one is created", async () => {
  const fake = createFakeRex([{ windowId: "win-parent", blocks: ["blk-parent", "blk-user"] }]);
  const sessionOptions = options(fake.runner, "sess-closed");
  await launchAutoRexMirror(input("t-1"), sessionOptions);
  fake.windows.splice(1, 1);
  const second = await launchAutoRexMirror(input("t-2"), sessionOptions);
  assert.deepEqual(second, { ok: true, blockId: "blk-new-2" });
  assert.equal(placements(fake.calls)[1]!.args[0], "run");
});

test("rex layout: placements never steal focus, close, or rearrange", async () => {
  const fake = createFakeRex([{ windowId: "win-parent", blocks: ["blk-parent"] }]);
  await Promise.all(
    ["t-1", "t-2", "t-3", "t-4"].map((taskId) =>
      launchAutoRexMirror(input(taskId), options(fake.runner, "sess-focus")),
    ),
  );
  for (const call of fake.calls) {
    assert.equal(call.command, "rex");
    // Stale Rex env must not start a server, and each call is time-bounded.
    assert.ok(call.args.includes("--autostart=false"), `${call.args[0]} never autostarts`);
    assert.equal(flag(call.args, "--timeout"), "10s");
    const subcommand = call.args.slice(0, 2).join(" ");
    if (call.args[0] === "session") {
      assert.equal(subcommand, "session inspect");
      continue;
    }
    assert.ok(call.args[0] === "split" || call.args[0] === "run", subcommand);
    assert.ok(call.args.includes("--focus=false"), `${call.args[0]} keeps focus`);
    assert.ok(!call.args.includes("--focus") && !call.args.includes("--focus=true"));
    assert.ok(call.args.includes("--json"));
    assert.equal(flag(call.args, "-s"), "sess-focus");
  }
});

test("rex layout: new-window launch passes cwd, label and viewer argv after --", async () => {
  const fake = createFakeRex([{ windowId: "win-parent", blocks: ["blk-parent", "blk-user"] }]);
  await launchAutoRexMirror(input("t-9"), options(fake.runner, "sess-argv"));
  const run = placements(fake.calls)[0]!;
  assert.deepEqual(run.args, [
    "run",
    "-s",
    "sess-argv",
    "--focus=false",
    "-c",
    "/repo",
    "--label",
    "scout (t-9): look around",
    "--autostart=false",
    "--timeout",
    "10s",
    "--json",
    "--",
    "/usr/local/bin/node",
    "/pkg/rex-view.js",
    "/tmp/t-9/live-transcript.json",
  ]);
});

test("rex layout: unrecognized inspect data fails without placing anything", async () => {
  const shapes = [
    "{not-json",
    JSON.stringify({ windows: "nope" }),
    JSON.stringify({}),
    JSON.stringify({ windows: [{ window_id: "w", layers: [{ blocks: [{ label: "no id" }] }] }] }),
    JSON.stringify({ windows: [{ layers: [{ blocks: [{ block_id: "blk-parent" }] }] }] }),
    JSON.stringify({ windows: [{ window_id: "w", layers: [{ blocks: "x" }] }] }),
    JSON.stringify({ windows: [{ window_id: "w", blocks: [{ block_id: "blk-parent" }] }] }),
    JSON.stringify({ windows: [{ window_id: "w", layers: [null] }] }),
    "null",
  ];
  for (const [index, stdout] of shapes.entries()) {
    const fake = createFakeRex([], () => stdout);
    const result = await launchAutoRexMirror(input("t-1"), options(fake.runner, `sess-bad-${index}`));
    assert.equal(result.ok, false, `shape ${index}`);
    if (!result.ok) assert.match(result.error, /rex session inspect/i);
    assert.equal(placements(fake.calls).length, 0, `shape ${index} placed`);
  }
});

test("rex layout: a missing parent block fails without placing anything", async () => {
  const fake = createFakeRex([{ windowId: "win-other", blocks: ["blk-elsewhere"] }]);
  const result = await launchAutoRexMirror(input("t-1"), options(fake.runner, "sess-noparent"));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /blk-parent/);
  assert.equal(placements(fake.calls).length, 0);
});

test("rex layout: CLI errors from inspect and placement are reported", async () => {
  const inspectFail = await launchAutoRexMirror(input("t-1"), {
    ...options({ run: async () => ({ stdout: "", stderr: "" }) }, "sess-cli-1"),
    runner: {
      async run() {
        throw new Error("rex exited unsuccessfully: session not found");
      },
    },
  });
  assert.equal(inspectFail.ok, false);
  if (!inspectFail.ok) assert.match(inspectFail.error, /session not found/);

  const fake = createFakeRex([{ windowId: "win-parent", blocks: ["blk-parent", "blk-user"] }]);
  const placementFail = await launchAutoRexMirror(input("t-2"), {
    ...options(fake.runner, "sess-cli-2"),
    runner: {
      async run(command, args) {
        if (args[0] === "session") return fake.runner.run(command, args);
        throw new Error("rex exited unsuccessfully: boom");
      },
    },
  });
  assert.equal(placementFail.ok, false);
  if (!placementFail.ok) assert.match(placementFail.error, /boom/);

  const badCreate = await launchAutoRexMirror(input("t-3"), {
    ...options(fake.runner, "sess-cli-3"),
    runner: {
      async run(command, args) {
        if (args[0] === "session") return fake.runner.run(command, args);
        return { stdout: JSON.stringify({ block_ids: [] }), stderr: "" };
      },
    },
  });
  assert.equal(badCreate.ok, false);
  if (!badCreate.ok) assert.match(badCreate.error, /rex (run|split)/i);
});

test("rex layout: a failure does not wedge later launches", async () => {
  const fake = createFakeRex([{ windowId: "win-parent", blocks: ["blk-parent"] }]);
  let fail = true;
  const flaky = {
    async run(command: string, args: readonly string[]) {
      if (fail && args[0] === "session") {
        fail = false;
        throw new Error("rex exited unsuccessfully: flaky");
      }
      return fake.runner.run(command, args);
    },
  };
  const [first, second] = await Promise.all([
    launchAutoRexMirror(input("t-1"), options(flaky, "sess-flaky")),
    launchAutoRexMirror(input("t-2"), options(flaky, "sess-flaky")),
  ]);
  assert.equal(first.ok, false);
  assert.equal(second.ok, true);
});

test("rex layout: reports missing Rex environment and an unstartable rex binary", async () => {
  const fake = createFakeRex([]);
  const outside = await launchAutoRexMirror(input("t-1"), { env: {}, runner: fake.runner });
  assert.equal(outside.ok, false);
  if (!outside.ok) assert.match(outside.error, /Rex/);
  assert.equal(fake.calls.length, 0);

  const missingBinary = await launchAutoRexMirror(input("t-2"), {
    ...options(fake.runner, "sess-nobin"),
    runner: {
      async run() {
        throw new Error("rex exited unsuccessfully");
      },
    },
  });
  assert.equal(missingBinary.ok, false);
  if (!missingBinary.ok) assert.match(missingBinary.error, /PATH/);
});

for (const windowIdInResponse of [true, false]) {
  const source = windowIdInResponse ? "create response" : "fresh inspection";
  test(`rex layout: overflow window stays reusable after its run-created block closes (window id from ${source})`, async () => {
    const fake = createFakeRex(
      [{ windowId: "win-parent", blocks: ["blk-parent", "blk-user"] }],
      undefined,
      windowIdInResponse,
    );
    const sessionOptions = options(fake.runner, `sess-survivor-${windowIdInResponse}`);
    const b = await launchAutoRexMirror(input("t-1"), sessionOptions);
    const c = await launchAutoRexMirror(input("t-2"), sessionOptions);
    assert.deepEqual(b, { ok: true, blockId: "blk-new-1" });
    assert.deepEqual(c, { ok: true, blockId: "blk-new-2" });
    assert.equal(fake.windows.length, 2);

    // B closes; C is alone in the overflow window.
    const overflow = fake.windows[1]!;
    overflow.blocks = overflow.blocks.filter((blockId) => blockId !== "blk-new-1");
    assert.deepEqual(overflow.blocks, ["blk-new-2"]);

    const d = await launchAutoRexMirror(input("t-3"), sessionOptions);
    assert.deepEqual(d, { ok: true, blockId: "blk-new-3" });
    const placed = placements(fake.calls);
    assert.equal(placed[2]!.args[0], "split");
    assert.equal(flag(placed[2]!.args, "-b"), "blk-new-2");
    assert.deepEqual(overflow.blocks, ["blk-new-2", "blk-new-3"]);
    assert.equal(fake.windows.length, 2);
  });
}

test("rex layout: an owned block moved into an unrelated window does not make that window adoptable", async () => {
  const fake = createFakeRex([{ windowId: "win-parent", blocks: ["blk-parent", "blk-user"] }]);
  const sessionOptions = options(fake.runner, "sess-moved");
  const first = await launchAutoRexMirror(input("t-1"), sessionOptions);
  assert.deepEqual(first, { ok: true, blockId: "blk-new-1" });

  // The overflow window is gone; its mirror now sits alone in a user window.
  fake.windows.splice(1, 1, { windowId: "win-user", blocks: ["blk-new-1"] });

  const second = await launchAutoRexMirror(input("t-2"), sessionOptions);
  assert.deepEqual(second, { ok: true, blockId: "blk-new-2" });
  assert.equal(placements(fake.calls)[1]!.args[0], "run");
  assert.deepEqual(fake.windows.find((w) => w.windowId === "win-user")!.blocks, ["blk-new-1"]);
});

test("rex layout: no ownership is recorded when the new window cannot be verified, and the launch still succeeds once", async () => {
  const fake = createFakeRex(
    [{ windowId: "win-parent", blocks: ["blk-parent", "blk-user"] }],
    undefined,
    false,
  );
  let inspections = 0;
  const lookupFails = {
    async run(command: string, args: readonly string[]) {
      if (args[0] === "session" && ++inspections > 1) {
        throw new Error("rex exited unsuccessfully: lookup unavailable");
      }
      return fake.runner.run(command, args);
    },
  };
  const first = await launchAutoRexMirror(input("t-1"), options(lookupFails, "sess-unverified"));
  assert.deepEqual(first, { ok: true, blockId: "blk-new-1" });
  assert.equal(placements(fake.calls).length, 1);

  // Nothing was verified, so the next launch opens a new window, not a split.
  const second = await launchAutoRexMirror(input("t-2"), options(fake.runner, "sess-unverified"));
  assert.deepEqual(second, { ok: true, blockId: "blk-new-2" });
  assert.equal(placements(fake.calls)[1]!.args[0], "run");
});
