import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { upsertTaskSessionHistory } from "../src/conversation.js";

const script = join(dirname(fileURLToPath(import.meta.url)), "lost-notice-session-start-child.ts");
const DEAD_PID = 4_000_000;

async function startSession(mode: "replay" | "branch" | "nofile") {
  const root = mkdtempSync(join(tmpdir(), "pi-task-lost-notice-start-"));
  const piDir = join(root, ".pi");
  try {
    upsertTaskSessionHistory(piDir, {
      id: "t-lost",
      status: "done",
      background: true,
      agentType: "scout",
      description: "Lost notice",
      sessionName: "task-t-lost",
      startedAt: Date.now() - 60_000,
      completedAt: Date.now() - 30_000,
      piDir,
      dir: join(piDir, "artifacts"),
      cwd: root,
      backend: "sdk",
      ownerSessionId: "sess-lost",
      // A leaf outside the current branch makes the delivery guard withhold it.
      ownerLeafId: mode === "branch" ? "leaf-elsewhere" : null,
      ownerPid: DEAD_PID,
    });
    const child = spawn(process.execPath, ["--import", "tsx", script, piDir, root, mode], {
      env: { ...process.env, PI_TASK_BACKEND: "auto" },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    assert.equal(code, 0, `child exited ${code}: ${output}`);
    const match = output.match(/LOST_NOTICE_START (\{[^\n]+\})/);
    assert.ok(match, `no report: ${output}`);
    return JSON.parse(match[1]!) as { sent: number; replayed: number; first?: string };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("session start replaces a notice that never reached the session file", async () => {
  const state = await startSession("replay");
  assert.equal(state.replayed, 1);
  assert.match(state.first ?? "", /^<task id="t-lost" state="done"\/>\n/);
});

test("session start does not replay a notice the delivery guard withholds", async () => {
  assert.equal((await startSession("branch")).replayed, 0);
});

test("session start does not replay when there is no session file to check", async () => {
  assert.equal((await startSession("nofile")).replayed, 0);
});
