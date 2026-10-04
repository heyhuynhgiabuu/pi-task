import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatSdkBackgroundReceipt,
  reconcileStaleSdkBackgroundTasks,
  startSdkBackgroundTask,
} from "../src/subagent/sdkBackground.js";

{
  const t = "SDK background receipt promises automatic delivery without polling";
  const receipt = formatSdkBackgroundReceipt("sdk-receipt");
  assert.match(receipt, /host process/i, t + ": identifies the host process");
  assert.match(receipt, /result is delivered automatically when ready/i, t + ": promises automatic delivery");
  assert.match(receipt, /do not poll/i, t + ": forbids polling");
  assert.doesNotMatch(receipt, /OpenPi/, t + ": avoids the stale product name");
}

async function eventually(assertion: () => void): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 500) {
    try {
      assertion();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assertion();
}

{
  const t = "reconcile stale SDK history after host restart";
  const root = mkdtempSync(join(tmpdir(), "pi-task-sdk-reconcile-"));
  try {
    const piDir = join(root, ".pi");
    mkdirSync(piDir, { recursive: true });
    const historyPath = join(piDir, "task-session-history.json");
    const startedAt = Date.now() - 10_000;
    const history = [{
      id: "sdk-stale",
      backend: "sdk",
      agentType: "general",
      description: "stale SDK task",
      sessionName: "task-sdk-stale",
      startedAt,
      piDir,
      dir: join(piDir, "artifacts"),
      status: "running",
      background: true,
    }, {
      id: "durable-running",
      agentType: "general",
      description: "durable task",
      sessionName: "task-durable-running",
      startedAt,
      piDir,
      dir: join(piDir, "artifacts"),
      status: "running",
      backend: "durable",
      background: true,
    }];
    mkdirSync(join(piDir, "artifacts"), { recursive: true });
    writeFileSync(historyPath, JSON.stringify(history));

    assert.deepEqual(reconcileStaleSdkBackgroundTasks(piDir), ["sdk-stale"], t);
    const updated = JSON.parse(readFileSync(historyPath, "utf8")) as Array<Record<string, unknown>>;
    assert.equal(updated[0]?.status, "failed", t + ": SDK status");
    assert.equal(updated[0]?.rawStatus, "host-restarted", t + ": SDK reason");
    assert.equal(updated[1]?.status, "running", t + ": durable status is preserved");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const t = "stale reconciliation preserves ambiguous legacy history after any recovery outcome";
  const root = mkdtempSync(join(tmpdir(), "pi-task-sdk-reconcile-classification-"));
  try {
    const piDir = join(root, ".pi");
    mkdirSync(piDir, { recursive: true });
    const historyPath = join(piDir, "task-session-history.json");
    const startedAt = Date.now() - 10_000;
    const entries = [
      { id: "legacy-ambiguous", backend: undefined, comparisonGroupId: undefined },
      { id: "sdk-classified", backend: "sdk", comparisonGroupId: undefined },
      { id: "comparison-classified", backend: undefined, comparisonGroupId: "compare-1" },
    ].map(({ id, backend, comparisonGroupId }) => ({
      id,
      ...(backend !== undefined ? { backend } : {}),
      ...(comparisonGroupId !== undefined ? { comparisonGroupId } : {}),
      agentType: "general",
      description: "Interrupted task",
      sessionName: `task-${id}`,
      startedAt,
      piDir,
      dir: join(piDir, "artifacts"),
      status: "running",
      background: true,
    }));
    writeFileSync(historyPath, JSON.stringify(entries));

    assert.deepEqual(
      reconcileStaleSdkBackgroundTasks(piDir),
      ["sdk-classified", "comparison-classified"],
      t,
    );
    const updated = JSON.parse(readFileSync(historyPath, "utf8")) as Array<{
      id: string;
      status: string;
    }>;
    assert.equal(updated.find((entry) => entry.id === "legacy-ambiguous")?.status, "running", t);
    assert.equal(updated.find((entry) => entry.id === "sdk-classified")?.status, "failed", t);
    assert.equal(updated.find((entry) => entry.id === "comparison-classified")?.status, "failed", t);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = mkdtempSync(join(tmpdir(), "pi-task-sdk-bg-"));
  try {
    const piDir = join(root, ".pi");
    const artifactsDir = join(piDir, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    const sessionPath = join(root, "sub-session.jsonl");
    const cwd = join(root, "isolated-worktree");
    mkdirSync(cwd);
    let settled = false;
    let completedOutput = "";

    startSdkBackgroundTask({
      id: "m123abc-def0",
      agentType: "general",
      description: "Do work",
      sessionName: "task-m123abc-def0-general",
      startedAt: 100,
      piDir,
      artifactsDir,
      cwd,
      conversationId: "research",
      backend: "durable",
      ownerSessionId: "sess-a",
      ownerLeafId: "leaf-a",
      now: () => 200,
      run: async () => ({
        output: "<status>failure</status>\n<summary>Tests failed</summary>",
        sessionPath,
      }),
      onComplete: (result) => {
        completedOutput = result.output;
      },
      onSettled: () => {
        settled = true;
      },
    });

    await eventually(() => {
      const history = JSON.parse(
        readFileSync(join(piDir, "task-session-history.json"), "utf8"),
      );
      assert.equal(history[0].status, "done");
      assert.equal(history[0].reportedStatus, "failure");
      assert.equal(history[0].resultValid, true);
      assert.equal(history[0].background, true);
      assert.equal(history[0].cwd, cwd);
      assert.equal(history[0].ownerSessionId, "sess-a");
      assert.equal(history[0].backend, "durable");
      assert.equal(history[0].ownerLeafId, "leaf-a");
      assert.equal(history[0].sessionRef, sessionPath);
      assert.equal(history[0].completedAt, 200);
      assert.equal(completedOutput, "<status>failure</status>\n<summary>Tests failed</summary>");
      assert.equal(settled, true);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = mkdtempSync(join(tmpdir(), "pi-task-sdk-bg-cancelled-"));
  try {
    const piDir = join(root, ".pi");
    const artifactsDir = join(piDir, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    let failedCallback = false;

    startSdkBackgroundTask({
      id: "durable-cancelled",
      agentType: "general",
      description: "Cancel durable work",
      sessionName: "task-durable-cancelled",
      startedAt: 100,
      piDir,
      artifactsDir,
      backend: "durable",
      run: async () => {
        throw Object.assign(new Error("Durable subagent was cancelled."), { kind: "cancelled" });
      },
      onFailed: () => { failedCallback = true; },
    });

    await eventually(() => {
      const history = JSON.parse(
        readFileSync(join(piDir, "task-session-history.json"), "utf8"),
      );
      assert.equal(history[0].status, "cancelled");
      assert.equal(history[0].backend, "durable");
      assert.equal(failedCallback, true);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = mkdtempSync(join(tmpdir(), "pi-task-sdk-bg-failure-"));
  try {
    const piDir = join(root, ".pi");
    const artifactsDir = join(piDir, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    let failure = "";

    startSdkBackgroundTask({
      id: "m123abc-def1",
      agentType: "general",
      description: "Do work",
      sessionName: "task-m123abc-def1-general",
      startedAt: 100,
      piDir,
      artifactsDir,
      now: () => 200,
      run: async () => {
        throw new Error("network unavailable");
      },
      onFailed: (error) => {
        failure = error instanceof Error ? error.message : String(error);
      },
    });

    await eventually(() => {
      const history = JSON.parse(
        readFileSync(join(piDir, "task-session-history.json"), "utf8"),
      );
      assert.equal(history[0].status, "failed");
      assert.equal(failure, "network unavailable");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const t = "SDK timeout is persisted as timeout";
  const root = mkdtempSync(join(tmpdir(), "pi-task-sdk-bg-timeout-"));
  try {
    const piDir = join(root, ".pi");
    mkdirSync(piDir, { recursive: true });
    startSdkBackgroundTask({
      id: "m123abc-timeout",
      agentType: "general",
      description: "timed out",
      sessionName: "task-m123abc-timeout",
      startedAt: 100,
      piDir,
      artifactsDir: piDir,
      now: () => 200,
      run: async () => {
        const error = new Error("SDK subagent timed out") as Error & { kind: string };
        error.kind = "timeout";
        throw error;
      },
    });
    await eventually(() => {
      const history = JSON.parse(
        readFileSync(join(piDir, "task-session-history.json"), "utf8"),
      ) as Array<{ status: string; backend?: string; ownerPid?: number }>;
      assert.equal(history[0]?.status, "timeout", t);
      assert.equal(history[0]?.backend, "sdk", t + ": SDK backend is explicit by default");
      assert.equal(history[0]?.ownerPid, process.pid, t + ": process ownership is durable");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const t = "sync throw from run() routes through onFailed without escaping";
  const root = mkdtempSync(join(tmpdir(), "pi-task-sdk-bg-sync-throw-"));
  try {
    const piDir = join(root, ".pi");
    mkdirSync(piDir, { recursive: true });
    let failed = false;
    let settled = false;
    startSdkBackgroundTask({
      id: "m123abc-sync0",
      agentType: "general",
      description: "Do work",
      sessionName: "task-m123abc-sync0",
      startedAt: 100,
      piDir,
      artifactsDir: piDir,
      now: () => 200,
      run: (() => {
        throw new Error("sync boom");
      }) as unknown as () => Promise<{ output: string }>,
      onFailed: () => {
        failed = true;
      },
      onSettled: () => {
        settled = true;
      },
    });
    await eventually(() => {
      assert.equal(failed, true, t + ": onFailed called for sync throw");
      assert.equal(settled, true, t + ": onSettled called for sync throw");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const t = "throwing onSettled and history writes never become unhandled rejections";
  const root = mkdtempSync(join(tmpdir(), "pi-task-sdk-bg-settled-throw-"));
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const piDir = join(root, ".pi");
    // Make durable history writes fail: history path is occupied by a directory.
    mkdirSync(join(piDir, "task-session-history.json"), { recursive: true });
    let settled = false;
    startSdkBackgroundTask({
      id: "m123abc-thr0",
      agentType: "general",
      description: "Do work",
      sessionName: "task-m123abc-thr0",
      startedAt: 100,
      piDir,
      artifactsDir: piDir,
      now: () => 200,
      run: async () => ({ output: "<status>success</status><summary>ok</summary>" }),
      onSettled: () => {
        settled = true;
        throw new Error("settled boom");
      },
    });
    await eventually(() => assert.equal(settled, true, t + ": onSettled ran"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(unhandled.length, 0, `${t}: no unhandled rejections (${unhandled.map(String).join("; ")})`);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const t = "a throwing onComplete must not flip a completed task to failed";
  const root = mkdtempSync(join(tmpdir(), "pi-task-sdk-bg-oncomplete-"));
  try {
    const piDir = join(root, ".pi");
    const artifactsDir = join(piDir, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    let settled = false;
    let failedCalled = false;
    startSdkBackgroundTask({
      id: "m123abc-def9",
      agentType: "general",
      description: "onComplete throws",
      sessionName: "task-m123abc-def9-general",
      startedAt: 100,
      piDir,
      artifactsDir,
      now: () => 200,
      run: async () => ({
        output: "<status>success</status>\n<summary>fine</summary>",
        sessionPath: null,
      }),
      onComplete: () => {
        throw new Error("panel boom");
      },
      onFailed: () => {
        failedCalled = true;
      },
      onSettled: () => {
        settled = true;
      },
    });
    await eventually(() => {
      assert.equal(settled, true, t + ": lifecycle settled");
      const history = JSON.parse(
        readFileSync(join(piDir, "task-session-history.json"), "utf-8"),
      ) as Array<{ id: string; status: string }>;
      const entry = history.find((e) => e.id === "m123abc-def9");
      assert.equal(entry?.status, "done", t + ": task stays done");
      assert.equal(failedCalled, false, t + ": onFailed never runs");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const t = "a throwing delivery dispatcher does not rewrite completed task state";
  const root = mkdtempSync(join(tmpdir(), "pi-task-sdk-bg-dispatch-throw-"));
  try {
    const piDir = join(root, ".pi");
    mkdirSync(join(piDir, "artifacts"), { recursive: true });
    let failedCalled = false;
    let settled = false;
    startSdkBackgroundTask({
      id: "m123abc-dispatch",
      agentType: "general",
      description: "dispatcher throws",
      sessionName: "task-m123abc-dispatch",
      startedAt: 100,
      piDir,
      artifactsDir: join(piDir, "artifacts"),
      run: async () => ({ output: "<status>success</status><summary>ok</summary>" }),
      deliver: () => { throw new Error("queue enqueue failed"); },
      onFailed: () => { failedCalled = true; },
      onSettled: () => { settled = true; },
    });
    await eventually(() => {
      assert.equal(settled, true, t + ": lifecycle settled");
      const history = JSON.parse(
        readFileSync(join(piDir, "task-session-history.json"), "utf-8"),
      ) as Array<{ id: string; status: string }>;
      assert.equal(history.find((entry) => entry.id === "m123abc-dispatch")?.status, "done");
      assert.equal(failedCalled, false);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const t = "stale SDK reconciliation preserves a task with a live foreign owner";
  const root = mkdtempSync(join(tmpdir(), "pi-task-sdk-live-owner-"));
  try {
    const piDir = join(root, ".pi");
    mkdirSync(piDir, { recursive: true });
    const historyPath = join(piDir, "task-session-history.json");
    const startedAt = Date.now() - 10_000;
    const entries = [
      { id: "sdk-live-owner", ownerPid: 4242, ownerSessionId: "sess-foreign" },
      { id: "sdk-dead-owner", ownerPid: 4343, ownerSessionId: "sess-current" },
      { id: "sdk-current-owner", ownerPid: process.pid, ownerSessionId: "sess-current" },
      { id: "sdk-unknown-foreign-owner", ownerSessionId: "sess-foreign" },
    ].map(({ id, ownerPid, ownerSessionId }) => ({
      id,
      ...(ownerPid !== undefined ? { ownerPid } : {}),
      ownerSessionId,
      backend: "sdk",
      agentType: "general",
      description: "SDK task with process ownership",
      sessionName: `task-${id}`,
      startedAt,
      piDir,
      dir: join(piDir, "artifacts"),
      status: "running",
      background: true,
    }));
    writeFileSync(historyPath, JSON.stringify(entries));

    assert.deepEqual(
      reconcileStaleSdkBackgroundTasks(piDir, new Set(), {
        sessionId: "sess-current",
        isProcessAlive: (pid: number) => pid === 4242 || pid === process.pid,
      }),
      ["sdk-dead-owner"],
      t,
    );
    const updated = JSON.parse(readFileSync(historyPath, "utf8")) as Array<{
      id: string;
      status: string;
    }>;
    assert.equal(updated.find((entry) => entry.id === "sdk-live-owner")?.status, "running", t);
    assert.equal(updated.find((entry) => entry.id === "sdk-dead-owner")?.status, "failed", t);
    assert.equal(updated.find((entry) => entry.id === "sdk-current-owner")?.status, "running", t);
    assert.equal(updated.find((entry) => entry.id === "sdk-unknown-foreign-owner")?.status, "running", t);
    writeFileSync(
      historyPath,
      JSON.stringify(updated.filter((entry) =>
        entry.id === "sdk-current-owner" || entry.id === "sdk-unknown-foreign-owner",
      )),
    );
    assert.deepEqual(
      reconcileStaleSdkBackgroundTasks(piDir, new Set(), { sessionId: "sess-current" }),
      [],
      "the default PID probe recognizes the current process as live",
    );
    writeFileSync(
      historyPath,
      JSON.stringify(updated.filter((entry) => entry.id === "sdk-unknown-foreign-owner")),
    );
    assert.deepEqual(
      reconcileStaleSdkBackgroundTasks(piDir),
      [],
      "without a current session id, persisted session ownership remains ambiguous",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
