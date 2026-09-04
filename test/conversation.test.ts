import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  findJsonlSessionByName,
  readTaskSessionHistory,
  repairTaskSessionRef,
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

function seedHistory(
  piDir: string,
  entry: { id: string; dir: string; sessionName?: string; agentType?: string },
): string {
  const sessionName = entry.sessionName ?? `task-${entry.id}`;
  upsertTaskSessionHistory(piDir, {
    id: entry.id,
    agentType: entry.agentType ?? "general",
    description: "session lookup",
    sessionName,
    startedAt: Date.now(),
    piDir,
    dir: entry.dir,
    status: "done",
    background: true,
  });
  return sessionName;
}

test("finds a session via the artifact root recorded in history", () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-lookup-dir-"));
  const taskRoot = join(piDir, "elsewhere", "tasks");
  const id = "task-dir";
  const sessionName = seedHistory(piDir, { id, dir: taskRoot });
  const sessionRef = writeSession(join(taskRoot, "sessions", id), sessionName);

  assert.equal(findJsonlSessionByName(piDir, id, "general")?.sessionRef, sessionRef);
  assert.equal(findJsonlSessionByName(piDir, sessionName, "general")?.sessionRef, sessionRef);
});

test("falls back to the tasks artifact root when history dir is stale", () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-lookup-tasks-"));
  const id = "task-fallback";
  const sessionName = seedHistory(piDir, { id, dir: join(piDir, "gone") });
  const sessionRef = writeSession(
    join(piDir, "artifacts", "tasks", "sessions", id),
    sessionName,
  );

  assert.equal(findJsonlSessionByName(piDir, id, "general")?.sessionRef, sessionRef);
});

test("still finds sessions under the legacy artifacts root", () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-lookup-legacy-"));
  const id = "task-legacy";
  const sessionName = seedHistory(piDir, { id, dir: join(piDir, "artifacts") });
  const sessionRef = writeSession(join(piDir, "artifacts", "sessions", id), sessionName);

  assert.equal(findJsonlSessionByName(piDir, id, "general")?.sessionRef, sessionRef);
});

test("returns null on agent mismatch or unknown id", () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-lookup-miss-"));
  const taskRoot = join(piDir, "artifacts", "tasks");
  const id = "task-miss";
  const sessionName = seedHistory(piDir, { id, dir: taskRoot });
  writeSession(join(taskRoot, "sessions", id), sessionName);

  assert.equal(findJsonlSessionByName(piDir, id, "reviewer"), null);
  assert.equal(findJsonlSessionByName(piDir, "no-such-task", "general"), null);
  assert.equal(readTaskSessionHistory(piDir).length, 1);
});

test("skips probe roots that are files, not directories", () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-lookup-file-root-"));
  const taskRoot = join(piDir, "elsewhere");
  const id = "task-file-root";
  const sessionName = seedHistory(piDir, { id, dir: taskRoot });
  // The recorded root's sessions/<id> slot is occupied by a regular file.
  mkdirSync(join(taskRoot, "sessions"), { recursive: true });
  writeFileSync(join(taskRoot, "sessions", id), "not-a-directory", "utf-8");
  const sessionRef = writeSession(
    join(piDir, "artifacts", "tasks", "sessions", id),
    sessionName,
  );

  assert.equal(findJsonlSessionByName(piDir, id, "general")?.sessionRef, sessionRef);
});

test("repair re-discovers the transcript path without rewriting metadata", () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-repair-"));
  const taskRoot = join(piDir, "artifacts", "tasks");
  const id = "task-repair";
  const sessionName = `task-${id}`;
  upsertTaskSessionHistory(piDir, {
    id,
    agentType: "general",
    description: "needs repair",
    sessionName,
    startedAt: Date.now(),
    piDir,
    dir: taskRoot,
    status: "failed",
    background: true,
  });
  const sessionRef = writeSession(join(taskRoot, "sessions", id), sessionName);

  const repaired = repairTaskSessionRef(piDir, { id, sessionName, agentType: "general" });
  assert.equal(repaired.sessionRef, sessionRef);

  const [record] = readTaskSessionHistory(piDir);
  assert.equal(record.sessionRef, sessionRef);
  assert.equal(record.status, "failed");
  assert.equal(record.background, true);
});

test("repair re-discovery keeps newer on-disk metadata over a stale copy", () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-repair-newer-"));
  const taskRoot = join(piDir, "artifacts", "tasks");
  const id = "task-repair-newer";
  const sessionName = `task-${id}`;
  const stale = {
    id,
    agentType: "general",
    description: "stale caller copy",
    sessionRef: join(piDir, "missing.jsonl"),
    sessionName,
    startedAt: Date.now(),
    piDir,
    dir: taskRoot,
    status: "done" as const,
    background: true,
  };
  upsertTaskSessionHistory(piDir, stale);
  upsertTaskSessionHistory(piDir, {
    ...stale,
    status: "running",
    background: false,
    cleanupPending: true,
    comparisonGroupId: "comparison-1",
    comparisonDelivered: true,
  });
  const sessionRef = writeSession(join(taskRoot, "sessions", id), sessionName);

  const repaired = repairTaskSessionRef(piDir, stale);
  assert.equal(repaired.sessionRef, sessionRef);
  const [record] = readTaskSessionHistory(piDir);
  assert.equal(record.status, "running");
  assert.equal(record.background, false);
  assert.equal(record.cleanupPending, true);
  assert.equal(record.comparisonDelivered, true);
  assert.equal(record.sessionRef, sessionRef);
});

test("repair clears a dead ref when nothing is discoverable", () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-repair-dead-"));
  const id = "task-repair-dead";

  const repaired = repairTaskSessionRef(piDir, {
    id,
    sessionName: `task-${id}`,
    agentType: "general",
    sessionRef: join(piDir, "gone.jsonl"),
  });
  assert.equal(
    repaired.sessionRef,
    undefined,
    "a stale ref must not survive an undiscoverable repair (guards key on it)",
  );
  assert.equal(readTaskSessionHistory(piDir).length, 0);
});

test("repair keeps a usable ref and leaves history alone", () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-repair-ok-"));
  const id = "task-repair-ok";
  const sessionName = `task-${id}`;
  const sessionRef = writeSession(join(piDir, "root", "sessions", id), sessionName);

  const repaired = repairTaskSessionRef(piDir, {
    id,
    sessionName,
    agentType: "general",
    sessionRef,
  });
  assert.equal(repaired.sessionRef, sessionRef);
  assert.equal(readTaskSessionHistory(piDir).length, 0);
});

test("repair leaves everything untouched when nothing is discoverable", () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-repair-miss-"));
  const id = "task-repair-miss";

  const repaired = repairTaskSessionRef(piDir, {
    id,
    sessionName: `task-${id}`,
    agentType: "general",
  });
  assert.equal(repaired.sessionRef, undefined);
  assert.equal(readTaskSessionHistory(piDir).length, 0);
});

test("tolerates malformed history records when locating a session", () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-lookup-malformed-"));
  const id = "task-malformed";
  // A record written before `dir` existed (or hand-corrupted): the lookup
  // must skip the broken probe root, not throw on join(undefined, ...).
  upsertTaskSessionHistory(piDir, {
    id,
    agentType: "general",
    description: "malformed",
    sessionName: `task-${id}`,
    startedAt: Date.now(),
    piDir,
    dir: "",
    status: "done",
    background: true,
  });
  const raw = JSON.parse(readFileSync(join(piDir, "task-session-history.json"), "utf-8"));
  delete raw[0].dir;
  delete raw[0].id;
  raw.unshift(null);
  writeFileSync(join(piDir, "task-session-history.json"), JSON.stringify(raw, null, 2));

  const goodId = "task-well-formed";
  const sessionName = `task-${goodId}`;
  upsertTaskSessionHistory(piDir, {
    id: goodId,
    agentType: "general",
    description: "well formed",
    sessionName,
    startedAt: Date.now(),
    piDir,
    dir: join(piDir, "artifacts", "tasks"),
    status: "done",
    background: true,
  });
  const sessionRef = writeSession(
    join(piDir, "artifacts", "tasks", "sessions", goodId),
    sessionName,
  );

  // Neither call may throw: the malformed record fails the id-type guard
  // in the filter, and the well-formed record is still found.
  assert.equal(findJsonlSessionByName(piDir, `task-${id}`), null);
  assert.equal(findJsonlSessionByName(piDir, goodId, "general")?.sessionRef, sessionRef);
});

test("finds a session for a valid record whose dir field is missing", () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-lookup-nodir-"));
  const id = "task-nodir";
  const sessionName = `task-${id}`;
  upsertTaskSessionHistory(piDir, {
    id,
    agentType: "general",
    description: "no dir field",
    sessionName,
    startedAt: Date.now(),
    piDir,
    dir: join(piDir, "artifacts", "tasks"),
    status: "done",
    background: true,
  });
  const raw = JSON.parse(readFileSync(join(piDir, "task-session-history.json"), "utf-8"));
  delete raw[0].dir;
  writeFileSync(join(piDir, "task-session-history.json"), JSON.stringify(raw, null, 2));
  const sessionRef = writeSession(
    join(piDir, "artifacts", "tasks", "sessions", id),
    sessionName,
  );

  assert.equal(findJsonlSessionByName(piDir, id, "general")?.sessionRef, sessionRef);
});

test("repair never adopts another task's transcript on session-name collision", () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-repair-collision-"));
  const taskRoot = join(piDir, "artifacts", "tasks");
  // Two settled tasks share a session name (e.g. one conversation re-spawned
  // under a new task id). The old task's artifact dirs are gone.
  const shared = "conv-shared";
  const oldId = "task-old";
  const newId = "task-new";
  for (const id of [oldId, newId]) {
    upsertTaskSessionHistory(piDir, {
      id,
      agentType: "general",
      description: "collision",
      sessionName: shared,
      startedAt: Date.now(),
      piDir,
      dir: join(taskRoot, id === oldId ? "stale-root" : ""),
      status: "done",
      background: true,
    });
  }
  const foreignRef = writeSession(join(taskRoot, "sessions", newId), shared);

  const repaired = repairTaskSessionRef(piDir, {
    id: oldId,
    sessionName: shared,
    agentType: "general",
  });
  assert.equal(repaired.sessionRef, undefined);
  const record = readTaskSessionHistory(piDir).find((e) => e.id === oldId);
  assert.equal(record?.sessionRef, undefined);
  assert.notEqual(
    record?.sessionRef,
    foreignRef,
    "must not persist the other task's transcript path",
  );
});
