import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createTaskWidgetController } from "../src/lifecycle/widget.js";
import {
  LiveSnapshotWriter,
  buildLiveSnapshot,
  liveSnapshotPath,
  type LiveTranscriptSnapshot,
} from "../src/panel/rex-snapshot.js";
import {
  createMirrorRenderState,
  renderMirrorDelta,
  sanitizeMirrorText,
  startViewer,
} from "../src/rex-view.js";
import {
  ARROW_SCROLL,
  PAGE_SCROLL,
  isProcessAlive,
  mapViewerKey,
  routeViewerMouse,
  viewerFooter,
} from "../src/rex-view-tui.js";
import type { TaskTranscriptPane } from "../src/panel/task-pane.js";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import {
  launchRexMirror,
  resolveRexViewerPath,
  rexViewerCandidates,
  type RexMirrorLaunchInput,
  type RexMirrorLaunchResult,
} from "../src/subagent/rex-mirror.js";
import type { TranscriptItem } from "../src/panel/transcript.js";
import type { BackgroundTask } from "../src/types.js";

function makeDurableTask(dir: string, over: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    dir,
    cwd: dir,
    agentType: "scout",
    sessionName: "task-1",
    backend: "durable",
    originalPane: null,
    description: "explore codebase",
    startedAt: 1_000,
    toolUses: 0,
    turns: 0,
    recentCalls: [],
    status: "running",
    ...over,
  };
}

function userItem(text: string): TranscriptItem {
  return { type: "user", text, timestamp: "2026-11-25T00:00:00Z" };
}

function assistantItem(text: string, streaming = false): TranscriptItem {
  return {
    type: "assistant",
    text,
    ...(streaming ? { streaming: true } : {}),
    timestamp: "2026-11-25T00:00:01Z",
  };
}

/** A controller whose mirror launcher never touches Rex; every request succeeds. */
function createMirrorController(background: Map<string, BackgroundTask>) {
  const launched: RexMirrorLaunchInput[] = [];
  const controller = createTaskWidgetController(new Map(), background, {
    steerTask: () => null,
    stopTask: () => null,
    launchRexMirror: async (input) => {
      launched.push(input);
      return { ok: true, blockId: "blk-test" };
    },
  });
  return { controller, launched };
}

/** Presses `o` on the first task row of `/task list`, the only way a mirror is requested. */
function requestMirror(controller: ReturnType<typeof createTaskWidgetController>): void {
  const { ctx, customCalls } = createMockOverlayUi();
  void controller.openOverlay(ctx);
  const call = customCalls[0]!;
  const overlay = call.factory(
    { terminal: { rows: 40 }, requestRender: () => {} },
    null,
    {},
    () => call.resolve(undefined),
  );
  overlay.handleInput("o");
}

test("snapshot writer: nothing is written until a mirror is requested, then the transcript lands atomically", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-rex-snap-"));
  try {
    const task = makeDurableTask(root);
    const background = new Map([["t1", task]]);
    const { controller, launched } = createMirrorController(background);

    controller.setLiveTranscript("t1", [userItem("hello")], 0, { model: "openai/gpt-5" });

    const snapFile = liveSnapshotPath(root, "t1");
    assert.equal(existsSync(snapFile), false, "no snapshot without a mirror request");

    requestMirror(controller);

    assert.equal(launched.length, 1);
    assert.equal(existsSync(snapFile), true, "the request wrote the snapshot before launching");
    const dirEntries = readdirSync(join(root, "sessions", "t1"));
    assert.deepEqual(dirEntries, ["live-transcript.json"], "no leftover temp files");

    const parsed = JSON.parse(readFileSync(snapFile, "utf8")) as LiveTranscriptSnapshot;
    assert.equal(parsed.taskId, "t1");
    assert.equal(parsed.agentType, "scout");
    assert.equal(parsed.description, "explore codebase");
    assert.equal(parsed.status, "running");
    assert.equal(parsed.model, "openai/gpt-5");
    assert.equal(parsed.items.length, 1);
    assert.deepEqual(parsed.items[0], userItem("hello"));
    controller.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("snapshot writer: throttles rapid updates to 200ms and flushes a trailing write", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-rex-throttle-"));
  try {
    const task = makeDurableTask(root);
    const background = new Map([["t1", task]]);
    const { controller } = createMirrorController(background);

    controller.setLiveTranscript("t1", [userItem("one")]);
    requestMirror(controller);
    controller.setLiveTranscript("t1", [userItem("one"), assistantItem("two", true)]);
    controller.setLiveTranscript("t1", [userItem("one"), assistantItem("three")]);

    const snapFile = liveSnapshotPath(root, "t1");
    const immediate = JSON.parse(readFileSync(snapFile, "utf8")) as LiveTranscriptSnapshot;
    assert.equal(immediate.items.length, 1, "updates right after the request wait for the throttle");

    await new Promise((r) => setTimeout(r, 260));
    const trailing = JSON.parse(readFileSync(snapFile, "utf8")) as LiveTranscriptSnapshot;
    assert.equal(trailing.items.length, 2, "trailing write flushed latest update");
    assert.equal(
      (trailing.items[1] as Extract<TranscriptItem, { type: "assistant" }>).text,
      "three",
    );
    controller.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("snapshot writer: noteTaskFinished cancels pending trailing write and writes terminal status immediately", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-rex-finish-"));
  try {
    const task = makeDurableTask(root);
    const background = new Map([["t1", task]]);
    const { controller } = createMirrorController(background);

    controller.setLiveTranscript("t1", [userItem("one")]);
    requestMirror(controller);
    // Queues a trailing write with status "running"
    controller.setLiveTranscript("t1", [userItem("one"), assistantItem("final answer")]);

    task.status = "done";
    task.completedAt = 2_000;
    background.delete("t1");
    controller.noteTaskFinished("t1", task, 2_000);

    const snapFile = liveSnapshotPath(root, "t1");
    const finished = JSON.parse(readFileSync(snapFile, "utf8")) as LiveTranscriptSnapshot;
    assert.equal(finished.status, "done");
    assert.equal(finished.items.length, 2);

    // Wait past the throttle window to confirm the cancelled trailing timer cannot overwrite status
    await new Promise((r) => setTimeout(r, 260));
    const afterDelay = JSON.parse(readFileSync(snapFile, "utf8")) as LiveTranscriptSnapshot;
    assert.equal(afterDelay.status, "done");
    controller.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("snapshot writer: an outcome that was never recorded is written as finished, not done", () => {
  // Delivery that the guard suppresses returns before the executor records a status.
  const root = mkdtempSync(join(tmpdir(), "pi-task-rex-finished-"));
  try {
    const task = makeDurableTask(root);
    const background = new Map([["t1", task]]);
    const { controller } = createMirrorController(background);

    controller.setLiveTranscript("t1", [userItem("one")]);
    requestMirror(controller);
    background.delete("t1");
    controller.noteTaskFinished("t1", task, 2_000);

    const finished = JSON.parse(readFileSync(liveSnapshotPath(root, "t1"), "utf8")) as LiveTranscriptSnapshot;
    assert.equal(finished.status, "finished");
    controller.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("snapshot writer: long string arguments are capped and forget cancels a pending trailing write", async () => {
  const snap = buildLiveSnapshot(
    "t",
    { agentType: "general", description: "d", status: "running" },
    [
      {
        type: "tool",
        name: "write",
        toolCallId: "c",
        args: { path: "/x", content: "y".repeat(10_000) },
        inProgress: true,
        timestamp: "",
      },
    ],
    1,
  );
  const args = (snap.items[0] as Extract<TranscriptItem, { type: "tool" }>).args;
  assert.equal(args.path, "/x");
  const content = String(args.content);
  assert.ok(content.length < 4_100, `content capped, got ${content.length}`);
  assert.match(content, /\+\d+ chars/);

  let attempts = 0;
  const writer = new LiveSnapshotWriter({
    throttleMs: 100,
    writeAtomic: () => {
      attempts += 1;
    },
  });
  writer.schedule("/x/y.json", snap);
  writer.schedule("/x/y.json", { ...snap, revision: 2 });
  writer.forget("/x/y.json");
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(attempts, 1, "the pending trailing write was cancelled");
  writer.dispose();
});

test("snapshot writer: write failure never throws into setLiveTranscript or noteTaskFinished", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-rex-err-"));
  try {
    // Place a regular file at `task.dir` so mkdirSync(join(task.dir, "sessions", ...)) fails.
    const blockingFile = join(root, "not-a-dir");
    writeFileSync(blockingFile, "block");
    const task = makeDurableTask(blockingFile);
    const background = new Map([["t1", task]]);
    const { controller } = createMirrorController(background);

    assert.doesNotThrow(() => {
      controller.setLiveTranscript("t1", [userItem("hello")]);
      requestMirror(controller);
      task.status = "failed";
      controller.noteTaskFinished("t1", task, 2_000);
    });

    const writer = new LiveSnapshotWriter({ throttleMs: 200 });
    assert.doesNotThrow(() => {
      writer.schedule(liveSnapshotPath(blockingFile, "t2"), {
        version: 1,
        taskId: "t2",
        agentType: "scout",
        description: "desc",
        status: "running",
        revision: 1,
        updatedAt: 1000,
        items: [],
      });
      writer.flush(liveSnapshotPath(blockingFile, "t2"), {
        version: 1,
        taskId: "t2",
        agentType: "scout",
        description: "desc",
        status: "done",
        revision: 2,
        updatedAt: 2000,
        items: [],
      });
    });
    writer.dispose();
    controller.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("snapshot writer: an injected writer that throws never propagates from schedule or flush", async () => {
  let attempts = 0;
  const writer = new LiveSnapshotWriter({
    throttleMs: 20,
    writeAtomic: () => {
      attempts += 1;
      throw new Error("disk full");
    },
  });
  const snap: LiveTranscriptSnapshot = {
    version: 1,
    taskId: "t",
    agentType: "scout",
    description: "d",
    status: "running",
    revision: 1,
    updatedAt: 1,
    items: [],
  };
  assert.doesNotThrow(() => writer.schedule("/x/y.json", snap));
  assert.doesNotThrow(() => writer.schedule("/x/y.json", snap));
  await new Promise((r) => setTimeout(r, 60));
  assert.doesNotThrow(() => writer.flush("/x/y.json", { ...snap, status: "done" }));
  assert.equal(attempts, 3, "first write, trailing write, and final flush were all attempted");
  writer.dispose();
});

function makeSnap(
  items: TranscriptItem[],
  over: Partial<LiveTranscriptSnapshot> = {},
): LiveTranscriptSnapshot {
  return {
    version: 1,
    taskId: "task-42",
    agentType: "scout",
    description: "inspect mirror",
    status: "running",
    revision: 1,
    updatedAt: 1_000,
    items,
    ...over,
  };
}

test("rex-view delta: prints header and new items once, and emits OSC working", () => {
  const state = createMirrorRenderState();
  const first = renderMirrorDelta(
    state,
    makeSnap([userItem("find bugs"), assistantItem("looking...")], { model: "openai/gpt-5" }),
  );
  assert.equal(first.done, false);
  assert.equal(first.osc, "\x1b]7501;state=working:app=pi-task\x1b\\");
  assert.ok(first.text.includes("scout"));
  assert.ok(first.text.includes("task-42"));
  assert.ok(first.text.includes("inspect mirror"));
  assert.ok(first.text.includes("find bugs"));
  assert.ok(first.text.includes("looking..."));

  const second = renderMirrorDelta(
    state,
    makeSnap([
      userItem("find bugs"),
      assistantItem("looking..."),
      { type: "system", text: "note", timestamp: "2026-11-25T00:00:02Z" },
    ]),
  );
  assert.equal(second.done, false);
  assert.equal(second.osc, "", "working OSC not repeated");
  assert.ok(!second.text.includes("find bugs"), "prior items not reprinted");
  assert.ok(!second.text.includes("inspect mirror"), "header not reprinted");
  assert.ok(second.text.includes("note"));
});

test("rex-view delta: streams growing assistant text as incremental suffix", () => {
  const state = createMirrorRenderState();
  const a = renderMirrorDelta(state, makeSnap([assistantItem("hel", true)]));
  assert.ok(a.text.endsWith("hel"));

  const b = renderMirrorDelta(state, makeSnap([assistantItem("hello world", true)]));
  assert.equal(b.text, "lo world");

  const c = renderMirrorDelta(state, makeSnap([assistantItem("hello world!", false)]));
  assert.equal(c.text, "!\n");
});

test("rex-view delta: tool item prints call first then result when finished, marking errors", () => {
  const state = createMirrorRenderState();
  const runningTool: TranscriptItem = {
    type: "tool",
    name: "bash",
    toolCallId: "call-1",
    args: { command: "ls -la" },
    inProgress: true,
    timestamp: "2026-11-25T00:00:02Z",
  };
  const step1 = renderMirrorDelta(state, makeSnap([runningTool]));
  assert.ok(step1.text.includes("bash") || step1.text.includes("$ ls -la"));
  assert.ok(!step1.text.includes("file.txt"));

  const finishedTool: TranscriptItem = {
    ...runningTool,
    inProgress: false,
    result: "file.txt",
    durationMs: 12,
  };
  const step2 = renderMirrorDelta(state, makeSnap([finishedTool]));
  assert.ok(!step2.text.includes("ls -la"), "tool call line is not repeated");
  assert.ok(step2.text.includes("file.txt"));

  const errTool: TranscriptItem = {
    type: "tool",
    name: "read",
    toolCallId: "call-2",
    args: { path: "missing.ts" },
    inProgress: false,
    isError: true,
    result: "ENOENT",
    timestamp: "2026-11-25T00:00:03Z",
  };
  const step3 = renderMirrorDelta(state, makeSnap([finishedTool, errTool]));
  assert.ok(step3.text.includes("missing.ts"));
  assert.ok(step3.text.includes("ENOENT"));
  assert.ok(/✗|error/i.test(step3.text), "error tool result is marked");
});

test("rex-view delta: a tool result stamped with the result entry's time does not reprint the transcript", () => {
  // DurableTranscript stamps a settled tool with the toolResult entry's time, which
  // differs from the call's assistant message time (seen in a live durable run).
  const state = createMirrorRenderState();
  const call: TranscriptItem = {
    type: "tool",
    name: "bash",
    toolCallId: "call-9",
    args: { command: "echo tick" },
    inProgress: true,
    timestamp: "2026-11-25T08:05:20.022Z",
  };
  const first = renderMirrorDelta(
    state,
    makeSnap([userItem("go"), assistantItem("running"), call]),
  );
  assert.ok(first.text.includes("$ echo tick"));

  const settled: TranscriptItem = {
    ...call,
    inProgress: false,
    result: "tick",
    durationMs: 3011,
    timestamp: "2026-11-25T08:05:34.906Z",
  };
  const second = renderMirrorDelta(
    state,
    makeSnap([userItem("go"), assistantItem("running"), settled]),
  );
  assert.equal(second.text, "  ✓ tick (3011ms)\n");
});

test("rex-view delta: a tool-only turn whose empty assistant item is spliced out does not reprint", () => {
  // While streaming, DurableTranscript keeps an empty assistant item ahead of the
  // tool call, then removes it once the turn settles without text.
  const state = createMirrorRenderState();
  const call: TranscriptItem = {
    type: "tool",
    name: "bash",
    toolCallId: "call-3",
    args: { command: "ls" },
    inProgress: true,
    timestamp: "2026-11-25T00:00:02Z",
  };
  const streaming = renderMirrorDelta(
    state,
    makeSnap([userItem("go"), assistantItem("", true), call]),
  );
  assert.ok(streaming.text.includes("$ ls"));

  const spliced = renderMirrorDelta(state, makeSnap([userItem("go"), call]));
  assert.equal(spliced.text, "", "nothing reprinted when the empty assistant left");

  const settled: TranscriptItem = { ...call, inProgress: false, result: "ok", timestamp: "2026-11-25T00:00:09Z" };
  const done = renderMirrorDelta(state, makeSnap([userItem("go"), settled]));
  assert.equal(done.text, "  ✓ ok\n");
});

test("rex-view delta: several items trimmed between two reads keep the retained ones", () => {
  const state = createMirrorRenderState();
  renderMirrorDelta(
    state,
    makeSnap([userItem("u1"), assistantItem("a1"), userItem("u2"), assistantItem("a2")]),
  );
  const trimmed = renderMirrorDelta(state, makeSnap([assistantItem("a2"), userItem("u3")]));
  assert.ok(!trimmed.text.includes("a2"), "retained a2 not reprinted");
  assert.ok(trimmed.text.includes("u3"), "new item u3 printed");
});

test("rex-view delta: a tool call line waits for its arguments", () => {
  // A live tool slot arrives before its arguments, which the settled entry supplies later.
  const state = createMirrorRenderState();
  const running: TranscriptItem = {
    type: "tool",
    name: "read",
    toolCallId: "call-4",
    args: {},
    inProgress: true,
    timestamp: "",
  };
  const beforeArgs = renderMirrorDelta(state, makeSnap([running]));
  assert.ok(!beforeArgs.text.includes("▸"), "no bare call line");

  const withArgs = renderMirrorDelta(
    state,
    makeSnap([{ ...running, args: { path: "/repo/x.ts" } }]),
  );
  assert.equal(withArgs.text, "▸ read /repo/x.ts\n");

  const settled = renderMirrorDelta(
    state,
    makeSnap([{ ...running, args: { path: "/repo/x.ts" }, inProgress: false, result: "body" }]),
  );
  assert.equal(settled.text, "  ✓ body\n");
});

test("rex-view delta: an unknown outcome renders as finished and reports idle", () => {
  const state = createMirrorRenderState();
  renderMirrorDelta(state, makeSnap([userItem("hi")], { status: "running" }));
  const delta = renderMirrorDelta(state, makeSnap([userItem("hi")], { status: "finished" }));
  assert.equal(delta.done, true);
  assert.equal(delta.osc, "\x1b]7501;state=idle:app=pi-task\x1b\\");
  assert.ok(delta.text.includes("[finished]"));
});

test("rex-view text: control characters never reach the pane", () => {
  const cleaned = sanitizeMirrorText("a\x1b]7501;state=done\x1b\\b\rc\x07\n\td\u009b");
  assert.equal(cleaned, "a]7501;state=done\\bc\n\td");
  assert.ok(!/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(cleaned), "no control character survives");
});

test("rex-view delta: head trimming does not reprint retained items", () => {
  const state = createMirrorRenderState();
  const i1 = userItem("u1");
  const i2 = assistantItem("a1");
  const i3 = userItem("u2");
  const i4 = assistantItem("a2");
  const i5 = userItem("u3");

  renderMirrorDelta(state, makeSnap([i1, i2, i3, i4]));
  const trimmed = renderMirrorDelta(state, makeSnap([i3, i4, i5]));
  assert.ok(!trimmed.text.includes("u2"), "retained u2 not reprinted");
  assert.ok(!trimmed.text.includes("a2"), "retained a2 not reprinted");
  assert.ok(trimmed.text.includes("u3"), "new item u3 printed");
});

test("rex-view delta: terminal status emits done or error OSC and signals exit", () => {
  const okState = createMirrorRenderState();
  const doneDelta = renderMirrorDelta(
    okState,
    makeSnap([userItem("hi"), assistantItem("bye")], { status: "done" }),
  );
  assert.equal(doneDelta.done, true);
  assert.equal(doneDelta.osc, "\x1b]7501;state=done:app=pi-task\x1b\\");
  assert.ok(doneDelta.text.includes("[done]"));

  const failState = createMirrorRenderState();
  renderMirrorDelta(failState, makeSnap([userItem("hi")], { status: "running" }));
  const failDelta = renderMirrorDelta(
    failState,
    makeSnap([userItem("hi")], { status: "failed" }),
  );
  assert.equal(failDelta.done, true);
  assert.equal(failDelta.osc, "\x1b]7501;state=error:app=pi-task\x1b\\");
  assert.ok(failDelta.text.includes("[failed]"));
});

test("rex-mirror launcher: runs rex split with exact argv and returns block_ids[0]", async () => {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const longDesc = "x".repeat(200);
  const res = await launchRexMirror(
    {
      taskId: "t-1",
      agentType: "scout",
      description: longDesc,
      cwd: "/repo/work",
      snapshotPath: "/tmp/sessions/t-1/live-transcript.json",
    },
    {
      env: { REX_SESSION: "sess-1", REX_BLOCK: "blk-parent" },
      execPath: "/usr/local/bin/node",
      viewerPath: "/pkg/dist/rex-view.js",
      runner: {
        async run(command, args) {
          calls.push({ command, args });
          return {
            stdout: JSON.stringify({
              anchor_id: "blk-parent",
              block_ids: ["blk-child-9"],
              split_ids: ["split-1"],
              revision: 3,
            }),
            stderr: "",
          };
        },
      },
    },
  );

  assert.deepEqual(res, { ok: true, blockId: "blk-child-9" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.command, "rex");
  const args = calls[0]!.args;
  const labelIdx = args.indexOf("--label");
  assert.ok(labelIdx > -1);
  const label = args[labelIdx + 1]!;
  assert.ok(label.length <= 128, `label length ${label.length} <= 128`);
  assert.deepEqual(args, [
    "split",
    "-s",
    "sess-1",
    "-b",
    "blk-parent",
    "--split=right",
    "--ratio",
    "40",
    "--focus=false",
    "-c",
    "/repo/work",
    "--label",
    label,
    "--json",
    "--",
    "/usr/local/bin/node",
    "/pkg/dist/rex-view.js",
    "/tmp/sessions/t-1/live-transcript.json",
  ]);
  assert.ok(!args.includes("--keep-open"));
});

test("rex-mirror launcher: returns readable errors when outside Rex, on CLI failure, or on bad JSON", async () => {
  const missingEnv = await launchRexMirror(
    {
      taskId: "t-1",
      agentType: "scout",
      description: "inspect",
      cwd: "/repo",
      snapshotPath: "/tmp/snap.json",
    },
    {
      env: {},
      runner: {
        async run() {
          throw new Error("should not run");
        },
      },
    },
  );
  assert.equal(missingEnv.ok, false);
  if (!missingEnv.ok) assert.match(missingEnv.error, /Rex/i);

  const cliFail = await launchRexMirror(
    {
      taskId: "t-1",
      agentType: "scout",
      description: "inspect",
      cwd: "/repo",
      snapshotPath: "/tmp/snap.json",
    },
    {
      env: { REX_SESSION: "s", REX_BLOCK: "b" },
      runner: {
        async run() {
          throw new Error("rex exited unsuccessfully: block not found");
        },
      },
    },
  );
  assert.equal(cliFail.ok, false);
  if (!cliFail.ok) assert.match(cliFail.error, /block not found/);

  const badJson = await launchRexMirror(
    {
      taskId: "t-1",
      agentType: "scout",
      description: "inspect",
      cwd: "/repo",
      snapshotPath: "/tmp/snap.json",
    },
    {
      env: { REX_SESSION: "s", REX_BLOCK: "b" },
      runner: {
        async run() {
          return { stdout: "{not-json", stderr: "" };
        },
      },
    },
  );
  assert.equal(badJson.ok, false);
  if (!badJson.ok) assert.match(badJson.error, /rex split/i);

  // The default runner reports a missing binary without its ENOENT code or output.
  const missingBinary = await launchRexMirror(
    {
      taskId: "t-1",
      agentType: "scout",
      description: "inspect",
      cwd: "/repo",
      snapshotPath: "/tmp/snap.json",
    },
    {
      env: { REX_SESSION: "s", REX_BLOCK: "b" },
      runner: {
        async run() {
          throw new Error("rex exited unsuccessfully");
        },
      },
    },
  );
  assert.equal(missingBinary.ok, false);
  if (!missingBinary.ok) assert.match(missingBinary.error, /PATH/);
});

test("rex-mirror launcher: the viewer path prefers the TypeScript sibling when loaded from TypeScript", () => {
  assert.deepEqual(
    rexViewerCandidates("file:///pkg/src/subagent/rex-mirror.ts"),
    ["file:///pkg/src/rex-view.ts", "file:///pkg/dist/rex-view.js"],
  );
  assert.deepEqual(
    rexViewerCandidates("file:///pkg/dist/subagent/rex-mirror.js"),
    ["file:///pkg/dist/rex-view.js"],
  );
  // A candidate that does not exist still resolves to its path, so the error names it.
  assert.equal(resolveRexViewerPath("file:///pkg/src/subagent/rex-mirror.ts"), "/pkg/src/rex-view.ts");
  assert.equal(
    resolveRexViewerPath(new URL("../src/subagent/rex-mirror.ts", import.meta.url).href),
    fileURLToPath(new URL("../src/rex-view.ts", import.meta.url)),
  );
});

function createMockOverlayUi() {
  const notifications: Array<{ message: string; level: string }> = [];
  const customCalls: Array<{
    factory: (
      tui: unknown,
      theme: unknown,
      keybindings: unknown,
      done: (result?: unknown) => void,
    ) => { handleInput(data: string): void; render(width: number): string[] };
    resolve: (v?: unknown) => void;
  }> = [];
  const ctx: any = {
    mode: "tui",
    hasUI: true,
    cwd: "/repo",
    ui: {
      setWidget() {},
      getEditorComponent: () => undefined,
      setEditorComponent() {},
      notify(message: string, level = "info") {
        notifications.push({ message, level });
      },
      custom(factory: (typeof customCalls)[number]["factory"]) {
        return new Promise((resolve) => {
          customCalls.push({ factory, resolve });
        });
      },
    },
  };
  return { ctx, notifications, customCalls };
}

test("widget overlay o key: opens mirror once, notifies on repeat, and rejects ineligible tasks", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-rex-overlay-"));
  try {
    const durableTask = makeDurableTask(root, { description: "live durable" });
    const sdkTask: BackgroundTask = {
      ...makeDurableTask(root, { description: "sdk child" }),
      backend: "sdk",
    };
    const noTranscriptDurable = makeDurableTask(root, { description: "no transcript yet" });

    const background = new Map<string, BackgroundTask>([
      ["t-live", durableTask],
      ["t-sdk", sdkTask],
      ["t-empty", noTranscriptDurable],
    ]);

    const launched: RexMirrorLaunchInput[] = [];
    let nextResult: RexMirrorLaunchResult = { ok: true, blockId: "blk-77" };
    const controller = createTaskWidgetController(new Map(), background, {
      steerTask: () => null,
      stopTask: () => null,
      launchRexMirror: async (input) => {
        launched.push(input);
        return nextResult;
      },
    });
    controller.setLiveTranscript("t-live", [userItem("hello")]);

    const { ctx, notifications, customCalls } = createMockOverlayUi();
    const pending = controller.openOverlay(ctx);
    const call = customCalls[0]!;
    const overlay = call.factory({ terminal: { rows: 40 }, requestRender: () => {} }, null, {}, () =>
      call.resolve(undefined),
    );

    // Row 1 is t-live: pressing o launches the mirror
    overlay.handleInput("o");
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(launched.length, 1);
    assert.equal(launched[0]!.taskId, "t-live");
    assert.equal(launched[0]!.snapshotPath, liveSnapshotPath(root, "t-live"));
    assert.ok(notifications.some((n) => n.message.includes("blk-77")));

    // Pressing o again on t-live notifies with existing block id and does not relaunch
    overlay.handleInput("o");
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(launched.length, 1);
    assert.ok(notifications.at(-1)?.message.includes("blk-77"));

    // Row 2 is t-sdk: notifies reason, does not launch
    overlay.handleInput("\x1b[B");
    overlay.handleInput("o");
    assert.equal(launched.length, 1);
    assert.match(notifications.at(-1)?.message ?? "", /durable/i);

    // Row 3 is t-empty (no live transcript yet): notifies reason, does not launch
    overlay.handleInput("\x1b[B");
    overlay.handleInput("o");
    assert.equal(launched.length, 1);
    assert.match(notifications.at(-1)?.message ?? "", /live/i);

    // Finishing t-live prevents opening a mirror after completion
    durableTask.status = "done";
    durableTask.completedAt = 2_000;
    background.delete("t-live");
    controller.noteTaskFinished("t-live", durableTask, Date.now());
    // Navigate to finished t-live (rows are now t-sdk, t-empty, t-live)
    overlay.handleInput("\x1b[B");
    overlay.handleInput("o");
    assert.equal(launched.length, 1);
    assert.match(notifications.at(-1)?.message ?? "", /not running/i);

    // Error from launcher surfaces via notify
    controller.setLiveTranscript("t-empty", [userItem("now live")]);
    nextResult = { ok: false, error: "not running inside Rex" };
    overlay.handleInput("\x1b[A"); // back to t-empty
    overlay.handleInput("o");
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(launched.length, 2);
    assert.match(notifications.at(-1)?.message ?? "", /not running inside Rex/);

    call.resolve(undefined);
    await pending;
    controller.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("snapshot writer: the parent's pid is written as ownerPid so the viewer can tell when Pi exited", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-rex-owner-"));
  try {
    const task = makeDurableTask(root);
    const background = new Map([["t1", task]]);
    const { controller } = createMirrorController(background);

    controller.setLiveTranscript("t1", [userItem("hello")]);
    requestMirror(controller);
    const opened = JSON.parse(readFileSync(liveSnapshotPath(root, "t1"), "utf8")) as LiveTranscriptSnapshot;
    assert.equal(opened.ownerPid, process.pid);

    task.status = "done";
    background.delete("t1");
    controller.noteTaskFinished("t1", task, 2_000);
    const finished = JSON.parse(readFileSync(liveSnapshotPath(root, "t1"), "utf8")) as LiveTranscriptSnapshot;
    assert.equal(finished.ownerPid, process.pid);
    controller.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const built = buildLiveSnapshot("t", { agentType: "general", description: "d" }, [], 1, undefined, undefined, 5, 4242);
  assert.equal(built.ownerPid, 4242);
  const without = buildLiveSnapshot("t", { agentType: "general", description: "d" }, [], 1);
  assert.equal("ownerPid" in without, false, "an unknown owner is omitted, not written as undefined");
});

test("rex-view-tui keys: arrows and pages scroll, t toggles tools, q/Escape/Ctrl+C close, the rest is unhandled", () => {
  // Pane semantics: a positive delta scrolls back toward older lines.
  assert.deepEqual(mapViewerKey("\x1b[A"), { type: "scroll", delta: ARROW_SCROLL });
  assert.deepEqual(mapViewerKey("\x1b[B"), { type: "scroll", delta: -ARROW_SCROLL });
  assert.deepEqual(mapViewerKey("\x1b[5~"), { type: "scroll", delta: PAGE_SCROLL });
  assert.deepEqual(mapViewerKey("\x1b[6~"), { type: "scroll", delta: -PAGE_SCROLL });
  assert.ok(ARROW_SCROLL > 0 && PAGE_SCROLL > ARROW_SCROLL);
  assert.deepEqual(mapViewerKey("t"), { type: "toggleTools" });
  assert.deepEqual(mapViewerKey("q"), { type: "close" });
  assert.deepEqual(mapViewerKey("\x1b"), { type: "close" });
  assert.deepEqual(mapViewerKey("\x03"), { type: "close" });
  for (const other of ["x", "T", "o", "\r", "\x1b[C", "\x1b[D", " "]) {
    assert.equal(mapViewerKey(other), undefined, `${JSON.stringify(other)} is not a viewer key`);
  }
});

test("rex-view-tui footer: the state line and OSC 7501 state follow the task outcome and the parent's liveness", () => {
  assert.deepEqual(viewerFooter("running", true), { text: "running", tone: "dim", osc: "working" });

  const orphaned = viewerFooter("running", false);
  assert.match(orphaned.text, /parent Pi exited/);
  assert.equal(orphaned.tone, "warning");
  assert.equal(orphaned.osc, "idle", "a stalled mirror is not reported as working");

  assert.deepEqual(viewerFooter("done", true), { text: "done", tone: "success", osc: "done" });
  assert.deepEqual(viewerFooter("done", false), viewerFooter("done", true), "a settled outcome outlives the parent");

  for (const status of ["failed", "timeout", "cancelled", "aborted"]) {
    assert.deepEqual(viewerFooter(status, true), { text: status, tone: "error", osc: "error" });
  }

  const finished = viewerFooter("finished", true);
  assert.match(finished.text, /^finished/);
  assert.equal(finished.osc, "idle");
  assert.notEqual(finished.tone, "success", "an unrecorded outcome must not read as success");
});

test("rex-view-tui owner liveness: signal 0 decides, EPERM still means alive", () => {
  const killWith = (code?: string) => (_pid: number, signal?: string | number) => {
    assert.equal(signal, 0);
    if (code) throw Object.assign(new Error(code), { code });
    return true;
  };
  assert.equal(isProcessAlive(10, killWith()), true);
  assert.equal(isProcessAlive(10, killWith("ESRCH")), false);
  assert.equal(isProcessAlive(10, killWith("EPERM")), true);
  assert.equal(isProcessAlive(undefined, killWith("ESRCH")), true, "no recorded owner is never reported dead");
});

function mouseEvent(over: Partial<TuiMouseEvent>): TuiMouseEvent {
  return {
    type: "click",
    button: "left",
    x: 4,
    y: 9,
    screenX: 4,
    screenY: 9,
    width: 80,
    height: 30,
    shift: false,
    alt: false,
    ctrl: false,
    ...over,
  };
}

function fakePane(hit?: ReturnType<NonNullable<TaskTranscriptPane["hitTest"]>>) {
  const calls = { scroll: [] as number[], hitRows: [] as number[] };
  const pane = {
    scrollBy: (delta: number) => calls.scroll.push(delta),
    render: () => [],
    invalidate() {},
    dispose() {},
    hitTest: (row: number) => {
      calls.hitRows.push(row);
      return hit;
    },
  } as TaskTranscriptPane;
  return { pane, calls };
}

test("rex-view-tui mouse: the wheel scrolls the pane and a click reaches the tool row under it with native coordinates", () => {
  const wheel = fakePane();
  // pi-tui sends negative deltas for wheel-up; pane positive means older.
  assert.deepEqual(routeViewerMouse(wheel.pane, mouseEvent({ type: "wheel", button: "none", wheelDelta: -3 }), 2), { handled: true });
  assert.deepEqual(wheel.calls.scroll, [3]);

  const seen: TuiMouseEvent[] = [];
  const dispatched = fakePane({
    component: {},
    y: 1,
    height: 5,
    dispatchMouse: (event) => {
      seen.push(event);
      return { handled: true };
    },
  });
  const result = routeViewerMouse(dispatched.pane, mouseEvent({ x: 4, y: 9, width: 80 }), 2);
  assert.deepEqual(result, { handled: true });
  assert.deepEqual(dispatched.calls.hitRows, [7], "the pane row is the screen row minus the header");
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.y, 1);
  assert.equal(seen[0]!.height, 5);
  assert.equal(seen[0]!.x, 4);
  assert.equal(seen[0]!.width, 80);

  // Without dispatchMouse the native component handles the event itself.
  const nativeSeen: TuiMouseEvent[] = [];
  const native = fakePane({
    component: { handleMouse: (event) => (nativeSeen.push(event), { handled: true }) },
    y: 0,
    height: 2,
  });
  assert.deepEqual(routeViewerMouse(native.pane, mouseEvent({}), 2), { handled: true });
  assert.equal(nativeSeen.length, 1);
});

test("rex-view-tui mouse: other buttons, header rows, misses, and unhandled clicks stay with the host", () => {
  const miss = fakePane();
  assert.equal(routeViewerMouse(miss.pane, mouseEvent({ button: "right" }), 2), undefined);
  assert.equal(routeViewerMouse(miss.pane, mouseEvent({ type: "press" }), 2), undefined);
  assert.equal(routeViewerMouse(miss.pane, mouseEvent({ y: 1 }), 2), undefined);
  assert.deepEqual(miss.calls.hitRows, [], "none of those reached the pane");
  assert.equal(routeViewerMouse(miss.pane, mouseEvent({ y: 9 }), 2), undefined, "no tool row under the click");
  assert.deepEqual(miss.calls.hitRows, [7]);

  const declined = fakePane({ component: {}, y: 0, height: 1, dispatchMouse: () => ({ handled: false }) });
  assert.equal(routeViewerMouse(declined.pane, mouseEvent({}), 2), undefined);
  assert.equal(routeViewerMouse(miss.pane, mouseEvent({ type: "wheel", wheelDelta: 0 }), 2), undefined);
});

test("rex-view startup: a TUI module that fails to load falls back to the text log and says why", async () => {
  const logged: string[] = [];
  const notes: string[] = [];
  const mode = await startViewer("/snap.json", {
    hasTty: () => true,
    loadTui: async () => {
      throw new Error("Cannot find package '@earendil-works/pi-coding-agent'");
    },
    runLog: (path) => logged.push(path),
    note: (message) => notes.push(message),
  });
  assert.equal(mode, "log");
  assert.deepEqual(logged, ["/snap.json"]);
  assert.equal(notes.length, 1, "the fallback is explained once");
  assert.match(notes[0]!, /Cannot find package/);
});

test("rex-view startup: a TUI that throws while starting falls back to the text log", async () => {
  const logged: string[] = [];
  const mode = await startViewer("/snap.json", {
    hasTty: () => true,
    loadTui: async () => ({
      runTuiViewer: async () => {
        throw new Error("theme failed");
      },
    }),
    runLog: (path) => logged.push(path),
  });
  assert.equal(mode, "log");
  assert.deepEqual(logged, ["/snap.json"]);
});

test("rex-view startup: without a TTY the Pi packages are never loaded and the text log runs", async () => {
  const logged: string[] = [];
  let loads = 0;
  const mode = await startViewer("/snap.json", {
    hasTty: () => false,
    loadTui: async () => {
      loads += 1;
      return { runTuiViewer: async () => {} };
    },
    runLog: (path) => logged.push(path),
  });
  assert.equal(mode, "log");
  assert.equal(loads, 0);
  assert.deepEqual(logged, ["/snap.json"]);
});

test("rex-view startup: with a TTY and a loadable module the TUI runs and the log does not", async () => {
  const started: string[] = [];
  const logged: string[] = [];
  const mode = await startViewer("/snap.json", {
    hasTty: () => true,
    loadTui: async () => ({ runTuiViewer: async (path) => void started.push(path) }),
    runLog: (path) => logged.push(path),
  });
  assert.equal(mode, "tui");
  assert.deepEqual(started, ["/snap.json"]);
  assert.deepEqual(logged, []);
});

// ---------------------------------------------------------------------------
// Automatic mirrors for fresh durable runs
// ---------------------------------------------------------------------------

interface MountedOverlay {
  closed: boolean;
  component: { handleInput(data: string): void; render(width: number): string[] } | undefined;
}

/**
 * A TUI widget whose `custom` overlays mount immediately, so a view opened or
 * closed is observable, with separate seams for the automatic and the manual
 * launcher. `insideRex` is the deterministic stand-in for Pi running in Rex.
 */
function createAutoMirrorHarness(
  foreground: Map<string, BackgroundTask>,
  background: Map<string, BackgroundTask>,
  autoLaunch: (input: RexMirrorLaunchInput) => Promise<RexMirrorLaunchResult>,
  options: { insideRex?: boolean; register?: boolean } = {},
) {
  const autoLaunched: RexMirrorLaunchInput[] = [];
  const manualLaunched: RexMirrorLaunchInput[] = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const overlays: MountedOverlay[] = [];
  const ctx: any = {
    mode: "tui",
    hasUI: true,
    cwd: "/repo",
    sessionManager: {
      getSessionId: () => "s-parent",
      getLeafId: () => null,
      getBranch: () => [],
      getHeader: () => ({ id: "s-parent" }),
    },
    ui: {
      setWidget() {},
      getEditorComponent: () => undefined,
      setEditorComponent() {},
      notify(message: string, level = "info") {
        notifications.push({ message, level });
      },
      custom(
        factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (v?: unknown) => void) => unknown,
      ) {
        return new Promise((resolve) => {
          const entry: MountedOverlay = { closed: false, component: undefined };
          overlays.push(entry);
          entry.component = factory(
            { terminal: { rows: 40 }, requestRender() {} },
            { fg: (_token: string, text: string) => text, bg: (_token: string, text: string) => text },
            { matches: () => false },
            () => {
              entry.closed = true;
              resolve(undefined);
            },
          ) as MountedOverlay["component"];
        });
      },
    },
  };
  const controller = createTaskWidgetController(foreground, background, {
    steerTask: () => null,
    stopTask: () => null,
    isInteractiveRex: () => options.insideRex ?? true,
    launchAutoRexMirror: async (input) => {
      autoLaunched.push(input);
      return autoLaunch(input);
    },
    launchRexMirror: async (input) => {
      manualLaunched.push(input);
      return { ok: true, blockId: "blk-manual" };
    },
  });
  if (options.register !== false) controller.ensureTaskWidget(ctx);
  return { controller, ctx, autoLaunched, manualLaunched, notifications, overlays };
}

function ownedTask(root: string, id: string, over: Partial<BackgroundTask> = {}): BackgroundTask {
  return makeDurableTask(root, { sessionName: `task-${id}`, ownerSessionId: "s-parent", ...over });
}

const settleMirror = () => new Promise((resolve) => setTimeout(resolve, 10));

function deferredMirror() {
  let release!: (result: RexMirrorLaunchResult) => void;
  const promise = new Promise<RexMirrorLaunchResult>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** A pending automatic launch per task, so results can be released in any order. */
function pendingLaunchs() {
  const gates = new Map<string, ReturnType<typeof deferredMirror>>();
  const launched: RexMirrorLaunchInput[] = [];
  return {
    launched,
    launch: (input: RexMirrorLaunchInput) => {
      const gate = deferredMirror();
      gates.set(input.taskId, gate);
      launched.push(input);
      return gate.promise;
    },
    succeed: (taskId: string) => gates.get(taskId)!.release({ ok: true, blockId: "blk-auto" }),
    fail: (taskId: string) => gates.get(taskId)!.release({ ok: false, error: "rex split timed out" }),
  };
}

test("auto mirror: inside Rex a foreground run shows nothing until its pane opens, and then no popup at all", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-rex-auto-first-"));
  try {
    const task = ownedTask(root, "t1");
    const { controller, autoLaunched, manualLaunched, notifications, overlays } = createAutoMirrorHarness(
      new Map([["t1", task]]),
      new Map(),
      async () => ({ ok: true, blockId: "blk-auto" }),
    );
    assert.equal(controller.registerAutoMirror("t1", "foreground"), true, "the run holds its Pi view for the mirror");
    assert.equal(overlays.length, 0, "no transient Pi view before the first transcript");
    assert.equal(autoLaunched.length, 0, "nothing launches before the first transcript");

    controller.setLiveTranscript("t1", [userItem("hello")]);
    await settleMirror();
    assert.equal(autoLaunched.length, 1);
    assert.equal(autoLaunched[0]!.taskId, "t1");
    assert.equal(autoLaunched[0]!.snapshotPath, liveSnapshotPath(root, "t1"));
    assert.equal(manualLaunched.length, 0, "the automatic launch does not go through the manual seam");
    assert.equal(overlays.length, 0, "no popup on success: the Rex pane is the display");
    assert.equal(notifications.length, 0, "an automatic mirror is silent");

    controller.setLiveTranscript("t1", [userItem("hello"), assistantItem("more")]);
    await settleMirror();
    assert.equal(autoLaunched.length, 1, "later updates never launch a second pane");
    assert.equal(controller.registerAutoMirror("t1", "foreground"), true, "re-registration keeps the held display");
    controller.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auto mirror: inside Rex a failed pane opens the Pi view once, as the fallback, with no other popup", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-rex-auto-fallback-"));
  const failing = (input: RexMirrorLaunchInput): Promise<RexMirrorLaunchResult> => {
    if (input.taskId === "t-error") return Promise.reject(new Error("rex split crashed"));
    return Promise.resolve({ ok: false, error: "not running inside Rex" });
  };
  try {
    // Unavailable and error alike: one fallback view, no transient popup, no toast.
    for (const id of ["t-missing", "t-error"]) {
      const { controller, autoLaunched, manualLaunched, notifications, overlays } = createAutoMirrorHarness(
        new Map([[id, ownedTask(root, id)]]),
        new Map(),
        failing,
      );
      assert.equal(controller.registerAutoMirror(id, "foreground"), true);
      assert.equal(overlays.length, 0, `${id}: held until the mirror is ruled out`);
      controller.setLiveTranscript(id, [userItem("a")]);
      await settleMirror();
      assert.deepEqual(autoLaunched.map((input) => input.taskId), [id]);
      assert.equal(overlays.length, 1, `${id}: exactly one fallback view, no transient popup`);
      assert.equal(overlays[0]!.closed, false, `${id}: the fallback view stays open`);
      assert.equal(notifications.length, 0, `${id}: the fallback is silent`);
      assert.equal(manualLaunched.length, 0);
      controller.dispose();
    }

    // Two concurrent runs whose mirrors both fail: the first fallback view is a
    // display opened since the other registered, so it is never replaced.
    const both = createAutoMirrorHarness(
      new Map([
        ["t-missing", ownedTask(root, "t-missing")],
        ["t-error", ownedTask(root, "t-error")],
      ]),
      new Map(),
      failing,
    );
    for (const id of ["t-missing", "t-error"]) both.controller.registerAutoMirror(id, "foreground");
    both.controller.setLiveTranscript("t-missing", [userItem("a")]);
    both.controller.setLiveTranscript("t-error", [userItem("b")]);
    await settleMirror();
    assert.equal(both.autoLaunched.length, 2);
    assert.equal(both.overlays.length, 1, "a later fallback never replaces a view opened since registration");
    assert.equal(both.overlays[0]!.closed, false);
    assert.equal(both.notifications.length, 0);
    both.controller.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auto mirror: a run that settles before its first transcript needs no mirror, and nothing opens afterwards", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-rex-auto-quiet-"));
  try {
    const task = ownedTask(root, "t1");
    const gate = deferredMirror();
    const { controller, autoLaunched, overlays, notifications } = createAutoMirrorHarness(
      new Map([["t1", task]]),
      new Map(),
      () => gate.promise,
    );
    // No transcript before settlement: no launch, no view, no pane.
    assert.equal(controller.registerAutoMirror("t1", "foreground"), true);
    controller.noteTaskFinished("t1", { ...task, status: "done" });
    controller.setLiveTranscript("t1", [userItem("late")]);
    await settleMirror();
    assert.equal(autoLaunched.length, 0);
    assert.equal(overlays.length, 0);
    assert.equal(notifications.length, 0);

    // Fast finish while the pane is still starting: the pane reads the final
    // transcript, and neither a late success nor a late failure opens a view.
    const fast = ownedTask(root, "t2");
    const pending = pendingLaunchs();
    const live = createAutoMirrorHarness(new Map([["t2", fast]]), new Map(), pending.launch);
    assert.equal(live.controller.registerAutoMirror("t2", "foreground"), true);
    live.controller.setLiveTranscript("t2", [userItem("question"), assistantItem("answer")]);
    assert.equal(pending.launched.length, 1, "the launch is in flight while the run settles");
    live.controller.noteTaskFinished("t2", { ...fast, status: "done" as const, completedAt: 2_000 });
    pending.succeed("t2");
    await settleMirror();
    // The single attempt is spent; a second result cannot arrive.
    assert.equal(live.overlays.length, 0, "no fallback after settlement");
    assert.equal(live.notifications.length, 0);
    const parsed = JSON.parse(readFileSync(liveSnapshotPath(root, "t2"), "utf8")) as LiveTranscriptSnapshot;
    assert.equal(parsed.status, "done", "the pane that opened late still sees the final outcome");
    assert.equal(parsed.items.length, 2, "and the whole final transcript");
    live.controller.dispose();
    controller.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auto mirror: a background run never opens or touches a view, whatever Rex does", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-rex-auto-bg-"));
  try {
    const background = new Map<string, BackgroundTask>([
      ["b-ok", ownedTask(root, "b-ok")],
      ["b-fail", ownedTask(root, "b-fail")],
    ]);
    const { controller, autoLaunched, manualLaunched, notifications, overlays } = createAutoMirrorHarness(
      new Map(),
      background,
      async (input) => (input.taskId === "b-ok" ? { ok: true, blockId: "blk-auto" } : { ok: false, error: "outside Rex" }),
    );
    for (const id of background.keys()) {
      assert.equal(controller.registerAutoMirror(id, "background"), false, "a background run never holds a view");
    }
    controller.setLiveTranscript("b-ok", [userItem("a")]);
    controller.setLiveTranscript("b-fail", [userItem("b")]);
    controller.setLiveTranscript("b-fail", [userItem("b"), assistantItem("c")]);
    await settleMirror();
    assert.deepEqual(autoLaunched.map((input) => input.taskId).sort(), ["b-fail", "b-ok"]);
    assert.equal(overlays.length, 0, "no popup, no /agents picker, no transcript view");
    assert.equal(notifications.length, 0, "no toast either");
    assert.equal(manualLaunched.length, 0);
    controller.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auto mirror: duplicate updates and a manual o share one pane and one snapshot", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-rex-auto-dedup-"));
  try {
    const task = ownedTask(root, "b1");
    const background = new Map([["b1", task]]);
    const gate = deferredMirror();
    const { controller, ctx, autoLaunched, manualLaunched, notifications, overlays } = createAutoMirrorHarness(
      new Map(),
      background,
      () => gate.promise,
    );
    controller.registerAutoMirror("b1", "background");
    controller.setLiveTranscript("b1", [userItem("hello")]);
    assert.equal(autoLaunched.length, 1);

    // `o` while the automatic launch is still in flight: nothing else starts, nothing is said.
    void controller.openOverlay(ctx);
    overlays.at(-1)!.component!.handleInput("o");
    assert.equal(manualLaunched.length, 0, "the in-flight launch is reused, not duplicated");
    assert.equal(notifications.length, 0);

    gate.release({ ok: true, blockId: "blk-auto" });
    await settleMirror();
    assert.equal(existsSync(liveSnapshotPath(root, "b1")), true, "the pane reads the shared snapshot");

    // `o` once the pane exists reports that pane instead of creating another.
    overlays.at(-1)!.component!.handleInput("o");
    await settleMirror();
    assert.equal(manualLaunched.length, 0);
    assert.equal(autoLaunched.length, 1);
    assert.match(notifications.at(-1)?.message ?? "", /already open \(block blk-auto\)/);

    controller.setLiveTranscript("b1", [userItem("hello"), assistantItem("next")]);
    controller.registerAutoMirror("b1", "background");
    controller.setLiveTranscript("b1", [userItem("hello"), assistantItem("next"), userItem("more")]);
    await settleMirror();
    assert.equal(autoLaunched.length, 1, "updates and re-registration never create another pane");
    controller.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auto mirror: a late fallback never interrupts a newer view or a picker opened since, nor a settled run", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-rex-auto-late-"));
  const harnessFor = (foreground: Map<string, BackgroundTask>, pending: ReturnType<typeof pendingLaunchs>) =>
    createAutoMirrorHarness(foreground, new Map(), pending.launch);
  try {
    // Another run's view opened after registration stays as it is.
    const newerRun = pendingLaunchs();
    const newer = harnessFor(
      new Map([
        ["t1", ownedTask(root, "t1")],
        ["t2", ownedTask(root, "t2")],
      ]),
      newerRun,
    );
    newer.controller.registerAutoMirror("t1", "foreground");
    newer.controller.setLiveTranscript("t1", [userItem("a")]);
    newer.controller.openTaskView("t2");
    const newerView = newer.overlays.at(-1)!;
    newerRun.fail("t1");
    await settleMirror();
    assert.equal(newerView.closed, false, "the newer view is not replaced");
    assert.equal(newer.overlays.length, 1, "no fallback view on top of it");
    assert.equal(newer.notifications.length, 0);

    // The /task picker opened after registration is not interrupted either.
    const pickerRun = pendingLaunchs();
    const picker = harnessFor(new Map([["t1", ownedTask(root, "t1")]]), pickerRun);
    picker.controller.registerAutoMirror("t1", "foreground");
    picker.controller.setLiveTranscript("t1", [userItem("a")]);
    void picker.controller.openOverlay(picker.ctx);
    const pickerOverlay = picker.overlays.at(-1)!;
    pickerRun.fail("t1");
    await settleMirror();
    assert.equal(pickerOverlay.closed, false, "the picker stays open");
    assert.equal(picker.overlays.length, 1, "no fallback view under or over the picker");

    // Closed and reopened before Rex answered: null → view → null is navigation too.
    const reopenedRun = pendingLaunchs();
    const reopened = harnessFor(
      new Map([
        ["t1", ownedTask(root, "t1")],
        ["t3", ownedTask(root, "t3")],
      ]),
      reopenedRun,
    );
    // A view of another task was already open at registration; the user closes and reopens it.
    reopened.controller.openTaskView("t3");
    reopened.controller.registerAutoMirror("t1", "foreground");
    reopened.controller.setLiveTranscript("t1", [userItem("a")]);
    reopened.controller.closeTaskView("t3");
    reopened.controller.openTaskView("t3");
    const reopenedView = reopened.overlays.at(-1)!;
    reopenedRun.fail("t1");
    await settleMirror();
    assert.equal(reopenedView.closed, false, "a closed-and-reopened view counts as navigation");
    assert.equal(reopened.overlays.length, 2, "no fallback view on top of it");

    // The run settled before Rex answered: nothing opens afterwards.
    const settledRun = pendingLaunchs();
    const settled = harnessFor(new Map([["t4", ownedTask(root, "t4")]]), settledRun);
    settled.controller.registerAutoMirror("t4", "foreground");
    settled.controller.setLiveTranscript("t4", [userItem("c")]);
    settled.controller.noteTaskFinished("t4", { ...ownedTask(root, "t4"), status: "done" });
    settledRun.fail("t4");
    await settleMirror();
    assert.equal(settled.overlays.length, 0, "no popup after the run settled");

    // Left untouched since registration, the fallback does open: exactly one view.
    const plainRun = pendingLaunchs();
    const plain = harnessFor(new Map([["t5", ownedTask(root, "t5")]]), plainRun);
    plain.controller.registerAutoMirror("t5", "foreground");
    plain.controller.setLiveTranscript("t5", [userItem("d")]);
    plainRun.fail("t5");
    await settleMirror();
    assert.equal(plain.overlays.length, 1, "the fallback view");
    assert.equal(plain.overlays[0]!.closed, false);

    // And success never opens one, however the user navigated.
    const okRun = pendingLaunchs();
    const ok = harnessFor(new Map([["t6", ownedTask(root, "t6")]]), okRun);
    ok.controller.registerAutoMirror("t6", "foreground");
    ok.controller.setLiveTranscript("t6", [userItem("e")]);
    okRun.succeed("t6");
    await settleMirror();
    assert.equal(ok.overlays.length, 0, "no popup on success");

    for (const h of [newer, picker, reopened, settled, plain, ok]) h.controller.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auto mirror: outside Rex, headless, or from a stale session nothing is held or launched", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-rex-auto-guards-"));
  try {
    // Outside interactive Rex the foreground Pi view opens at once, as before.
    const outside = createAutoMirrorHarness(
      new Map([["t1", ownedTask(root, "t1")]]),
      new Map(),
      async () => ({ ok: false, error: "outside Rex" }),
      { insideRex: false },
    );
    assert.equal(outside.controller.registerAutoMirror("t1", "foreground"), false, "the caller shows the Pi view");
    outside.controller.openTaskView("t1");
    const view = outside.overlays.at(-1)!;
    outside.controller.setLiveTranscript("t1", [userItem("a")]);
    await settleMirror();
    assert.equal(outside.autoLaunched.length, 1, "an automatic attempt is still made");
    assert.equal(view.closed, false, "the immediate view stays as the display");
    assert.equal(outside.overlays.length, 1, "no fallback popup on top of it");
    assert.equal(outside.notifications.length, 0);

    // Headless: no TUI context, nothing is held or launched.
    const headless: RexMirrorLaunchInput[] = [];
    const silent = createTaskWidgetController(new Map(), new Map([["t2", ownedTask(root, "t2")]]), {
      isInteractiveRex: () => true,
      launchAutoRexMirror: async (input) => {
        headless.push(input);
        return { ok: true, blockId: "blk-auto" };
      },
    });
    assert.equal(silent.registerAutoMirror("t2", "foreground"), false);
    silent.setLiveTranscript("t2", [userItem("a")]);
    silent.dispose();
    await settleMirror();
    assert.equal(headless.length, 0, "headless runs never launch a mirror");

    // Stale: the widget shows another session than the one that started the run.
    const foreign = ownedTask(root, "t3", { ownerSessionId: "s-other" });
    const { controller, autoLaunched, overlays } = createAutoMirrorHarness(
      new Map([["t3", foreign]]),
      new Map(),
      async () => ({ ok: true, blockId: "blk-auto" }),
    );
    assert.equal(controller.registerAutoMirror("t3", "foreground"), false);
    controller.setLiveTranscript("t3", [userItem("b")]);
    await settleMirror();
    assert.equal(autoLaunched.length, 0, "a task of another session never launches a mirror");
    assert.equal(overlays.length, 0);
    controller.dispose();
    outside.controller.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
