import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ensureTaskSessionRef,
  findJsonlSessionByName,
  readTaskSessionHistory,
  upsertTaskSessionHistory,
} from "../src/conversation.js";

function writeSession(taskDir: string, sessionName: string): string {
  mkdirSync(taskDir, { recursive: true });
  const sessionRef = join(taskDir, "session.jsonl");
  writeFileSync(
    sessionRef,
    `${JSON.stringify({ type: "session_info", name: sessionName })}\n`,
    "utf-8",
  );
  return sessionRef;
}

test("finds sessions in the current task artifact root", () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-conversation-"));
  const artifactsDir = join(piDir, "artifacts", "tasks");
  const taskId = "task-123";
  const sessionName = `task-${taskId}`;
  const sessionRef = writeSession(join(artifactsDir, "sessions", taskId), sessionName);

  upsertTaskSessionHistory(piDir, {
    id: taskId,
    agentType: "general",
    description: "resume session",
    sessionName,
    startedAt: Date.now(),
    piDir,
    dir: artifactsDir,
    status: "done",
    background: true,
  });

  assert.equal(findJsonlSessionByName(piDir, taskId, "general")?.sessionRef, sessionRef);
  assert.equal(findJsonlSessionByName(piDir, sessionName, "other"), null);
});

test("skips unavailable candidate directories while finding a session", () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-conversation-unavailable-"));
  const artifactsDir = join(piDir, "artifacts", "tasks");
  const taskId = "task-unavailable";
  const sessionName = `task-${taskId}`;
  mkdirSync(join(artifactsDir, "sessions"), { recursive: true });
  writeFileSync(
    join(artifactsDir, "sessions", taskId),
    "not-a-directory",
    "utf-8",
  );
  const sessionRef = writeSession(
    join(piDir, "artifacts", "sessions", taskId),
    sessionName,
  );

  upsertTaskSessionHistory(piDir, {
    id: taskId,
    agentType: "general",
    description: "skip unavailable root",
    sessionName,
    startedAt: Date.now(),
    piDir,
    dir: artifactsDir,
    status: "done",
    background: true,
  });

  assert.equal(findJsonlSessionByName(piDir, taskId, "general")?.sessionRef, sessionRef);
});

test("repairs a stale sessionRef without overwriting newer history metadata", () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-conversation-repair-"));
  const artifactsDir = join(piDir, "artifacts", "tasks");
  const taskId = "task-repair";
  const sessionName = `task-${taskId}`;
  const sessionRef = writeSession(join(artifactsDir, "sessions", taskId), sessionName);
  const entry = {
    id: taskId,
    agentType: "general",
    description: "repair session",
    sessionName,
    sessionRef: join(piDir, "missing.jsonl"),
    startedAt: Date.now(),
    piDir,
    dir: artifactsDir,
    status: "done" as const,
    background: true,
  };
  upsertTaskSessionHistory(piDir, entry);
  upsertTaskSessionHistory(piDir, {
    ...entry,
    status: "running",
    background: false,
    cleanupPending: true,
    comparisonGroupId: "comparison-1",
    comparisonDescription: "newer comparison metadata",
    comparisonDelivered: true,
  });

  const repaired = ensureTaskSessionRef(piDir, entry);
  assert.equal(repaired.sessionRef, sessionRef);
  assert.equal(repaired.status, "running");
  assert.equal(repaired.background, false);
  assert.equal(repaired.cleanupPending, true);
  assert.equal(repaired.comparisonGroupId, "comparison-1");
  assert.equal(repaired.comparisonDescription, "newer comparison metadata");
  assert.equal(repaired.comparisonDelivered, true);
  assert.deepEqual(readTaskSessionHistory(piDir)[0], repaired);
});
