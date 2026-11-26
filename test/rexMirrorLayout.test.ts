import { strict as assert } from "node:assert";
import test from "node:test";

import {
  launchAutoRexMirror,
  launchRexMirror,
  type RexMirrorLaunchInput,
  type RexMirrorLaunchOptions,
} from "../src/subagent/rex-mirror.js";
import type { CommandRunner } from "../src/subagent/terminalBackend.js";

interface RecordedCall {
  cmd: string;
  args: string[];
}

function input(taskId: string): RexMirrorLaunchInput {
  return {
    taskId,
    agentType: "explore",
    description: `task ${taskId}`,
    cwd: "/repo",
    snapshotPath: `/tmp/${taskId}.json`,
  };
}

function createFakeRex(options: { whoamiSession?: string } = {}): {
  calls: RecordedCall[];
  runner: CommandRunner;
} {
  const calls: RecordedCall[] = [];
  let nextBlock = 1;
  const runner: CommandRunner = {
    async run(cmd, args) {
      calls.push({ cmd, args: [...args] });
      if (cmd !== "rex") throw new Error(`unexpected command: ${cmd}`);
      if (args[0] === "whoami") {
        const sessionId = options.whoamiSession ?? "session:resolved-1";
        return { stdout: JSON.stringify({ session_id: sessionId, block_id: "block:pi" }), stderr: "" };
      }
      if (args[0] === "run" || args[0] === "split") {
        return { stdout: JSON.stringify({ block_ids: [`b-mirror-${nextBlock++}`] }), stderr: "" };
      }
      throw new Error(`unexpected rex subcommand: ${args.join(" ")}`);
    },
  };
  return { calls, runner };
}

function launchOpts(runner: CommandRunner, env: NodeJS.ProcessEnv): RexMirrorLaunchOptions {
  return {
    runner,
    env,
    execPath: "/bin/node",
    viewerPath: "/ext/rex-view.js",
  };
}

test("rex auto mirror: always opens a new Rex window via rex run and never splits", async () => {
  const fake = createFakeRex();
  const results = await Promise.all(
    ["t-1", "t-2", "t-3"].map((taskId) =>
      launchAutoRexMirror(input(taskId), launchOpts(fake.runner, { REX_SESSION: "sess-1", REX_BLOCK: "b-pi" })),
    ),
  );

  for (const result of results) {
    assert.equal(result.ok, true);
  }
  assert.equal(fake.calls.length, 3);
  for (const call of fake.calls) {
    assert.equal(call.args[0], "run");
    assert.ok(call.args.includes("--focus=false"), "never steals focus");
    assert.ok(call.args.includes("--autostart=false"), "bounded auto call");
    assert.ok(!call.args.includes("--split=right"), "never splits");
  }
});

test("rex auto mirror: passes session, cwd, label, bounds, and viewer argv after --", async () => {
  const fake = createFakeRex();
  const res = await launchAutoRexMirror(
    input("t-9"),
    launchOpts(fake.runner, { REX_SESSION: "sess-argv", REX_BLOCK: "b-pi" }),
  );
  assert.deepEqual(res, { ok: true, blockId: "b-mirror-1" });
  assert.deepEqual(fake.calls[0]?.args, [
    "run",
    "-s",
    "sess-argv",
    "--focus=false",
    "-c",
    "/repo",
    "--label",
    "explore (t-9): task t-9",
    "--autostart=false",
    "--timeout",
    "10s",
    "--json",
    "--",
    "/bin/node",
    "/ext/rex-view.js",
    "/tmp/t-9.json",
  ]);
});

test("rex mirror: resolves session_id via rex whoami --json when only REX_BLOCK is set", async () => {
  const fake = createFakeRex({ whoamiSession: "session:from-whoami" });
  const autoRes = await launchAutoRexMirror(
    input("t-1"),
    launchOpts(fake.runner, { REX_BLOCK: "block:pi-1" }),
  );
  assert.deepEqual(autoRes, { ok: true, blockId: "b-mirror-1" });
  assert.deepEqual(fake.calls[0]?.args, ["whoami", "--json", "--autostart=false", "--timeout", "10s"]);
  assert.equal(fake.calls[1]?.args[0], "run");
  assert.equal(fake.calls[1]?.args[1], "-s");
  assert.equal(fake.calls[1]?.args[2], "session:from-whoami");

  const manualRes = await launchRexMirror(
    input("t-2"),
    launchOpts(fake.runner, { REX_SESSION: "   ", REX_BLOCK: "block:pi-1" }),
  );
  assert.deepEqual(manualRes, { ok: true, blockId: "b-mirror-2" });
  assert.deepEqual(fake.calls[2]?.args, ["whoami", "--json"]);
  assert.equal(fake.calls[3]?.args[0], "split");
  assert.equal(fake.calls[3]?.args[2], "session:from-whoami");
  assert.equal(fake.calls[3]?.args[4], "block:pi-1");
});

test("rex auto mirror: reports missing REX_BLOCK, whoami errors, CLI failures, and bad JSON", async () => {
  const fake = createFakeRex();
  const outside = await launchAutoRexMirror(input("t-1"), launchOpts(fake.runner, {}));
  assert.equal(outside.ok, false);
  if (!outside.ok) assert.match(outside.error, /REX_BLOCK/);
  assert.equal(fake.calls.length, 0);

  const badWhoami = await launchAutoRexMirror(
    input("t-2"),
    launchOpts(
      {
        async run() {
          return { stdout: "not json", stderr: "" };
        },
      },
      { REX_BLOCK: "b-pi" },
    ),
  );
  assert.equal(badWhoami.ok, false);
  if (!badWhoami.ok) assert.match(badWhoami.error, /whoami.*invalid JSON/i);

  const missingSessionId = await launchAutoRexMirror(
    input("t-2b"),
    launchOpts(
      {
        async run() {
          return { stdout: "{}", stderr: "" };
        },
      },
      { REX_BLOCK: "b-pi" },
    ),
  );
  assert.equal(missingSessionId.ok, false);
  if (!missingSessionId.ok) assert.match(missingSessionId.error, /session_id/);

  const whoamiFail = await launchAutoRexMirror(
    input("t-2c"),
    launchOpts(
      {
        async run() {
          throw new Error("rex exited unsuccessfully: server not running");
        },
      },
      { REX_BLOCK: "b-pi" },
    ),
  );
  assert.equal(whoamiFail.ok, false);
  if (!whoamiFail.ok) assert.match(whoamiFail.error, /server not running/);

  const runFail = await launchAutoRexMirror(
    input("t-3"),
    launchOpts(
      {
        async run() {
          throw new Error("rex exited unsuccessfully");
        },
      },
      { REX_SESSION: "s", REX_BLOCK: "b-pi" },
    ),
  );
  assert.equal(runFail.ok, false);
  if (!runFail.ok) assert.match(runFail.error, /PATH/);

  const badRunJson = await launchAutoRexMirror(
    input("t-4"),
    launchOpts(
      {
        async run() {
          return { stdout: "{}", stderr: "" };
        },
      },
      { REX_SESSION: "s", REX_BLOCK: "b-pi" },
    ),
  );
  assert.equal(badRunJson.ok, false);
  if (!badRunJson.ok) assert.match(badRunJson.error, /block_ids\[0\]/);
});
