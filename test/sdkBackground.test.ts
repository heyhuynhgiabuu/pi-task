import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSdkBackgroundTask } from "../src/subagent/sdkBackground.js";

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
