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
