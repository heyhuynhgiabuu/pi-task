import { strict as assert } from "node:assert";
import test from "node:test";

import {
  completionDeliveryId,
  findLostCompletionNotices,
  LOST_NOTICE_MAX_AGE_MS,
  lostCompletionNotice,
} from "../src/lifecycle/completion.js";
import type { TaskSessionHistoryEntry } from "../src/types.js";

const NOW = 1_800_000_000_000;
const DEAD_PID = 4_000_000;

function entry(overrides: Partial<TaskSessionHistoryEntry> = {}): TaskSessionHistoryEntry {
  return {
    id: "t-1",
    agentType: "scout",
    description: "research",
    sessionName: "task-t-1",
    startedAt: NOW - 60_000,
    piDir: "/pi",
    dir: "/pi/artifacts",
    status: "done",
    background: true,
    ownerSessionId: "sess-1",
    ownerPid: DEAD_PID,
    completedAt: NOW - 30_000,
    ...overrides,
  } as TaskSessionHistoryEntry;
}

function find(history: TaskSessionHistoryEntry[], saved: string[] = []) {
  return findLostCompletionNotices({
    history,
    sessionId: "sess-1",
    persisted: (ids) => new Set([...ids].filter((id) => saved.includes(id))),
    now: NOW,
    isProcessAlive: (pid) => pid !== DEAD_PID,
  });
}

test("a terminal background task whose notice was never saved is replayed", () => {
  for (const status of ["done", "failed", "cancelled", "timeout"] as const) {
    assert.deepEqual(find([entry({ status })]).map((e) => e.id), ["t-1"], status);
  }
});

test("a notice that reached the session file is not repeated", () => {
  const saved = [completionDeliveryId("t-1", NOW - 60_000)];
  assert.deepEqual(find([entry()], saved), []);
});

test("only this session's finished, background, non-comparison tasks are candidates", () => {
  assert.deepEqual(find([entry({ ownerSessionId: "other" })]), []);
  assert.deepEqual(find([entry({ ownerSessionId: undefined })]), []);
  assert.deepEqual(find([entry({ status: "running", completedAt: undefined })]), []);
  assert.deepEqual(find([entry({ status: "aborted" })]), []);
  assert.deepEqual(find([entry({ background: false })]), []);
  assert.deepEqual(find([entry({ comparisonGroupId: "g1" })]), []);
  assert.deepEqual(find([entry({ completedAt: undefined })]), []);
});

test("a task whose owner process is alive is left to that process", () => {
  assert.deepEqual(find([entry({ ownerPid: process.pid })]), []);
  assert.deepEqual(find([entry({ ownerPid: 1234 })]), [], "another live process");
  assert.deepEqual(find([entry({ ownerPid: undefined })]).map((e) => e.id), ["t-1"]);
});

test("a notice older than the age cap is not replayed", () => {
  assert.deepEqual(find([entry({ completedAt: NOW - LOST_NOTICE_MAX_AGE_MS - 1 })]), []);
  assert.equal(find([entry({ completedAt: NOW - LOST_NOTICE_MAX_AGE_MS })]).length, 1);
});

test("each task is checked by its own delivery id, so a reused task id is not mistaken", () => {
  const first = entry({ startedAt: NOW - 120_000 });
  const second = entry({ id: "t-1", startedAt: NOW - 60_000 });
  const saved = [completionDeliveryId("t-1", NOW - 120_000)];
  assert.deepEqual(find([first, second], saved).map((e) => e.startedAt), [NOW - 60_000]);
});

test("the replayed notice names the task, its outcome, and where to read it", () => {
  const notice = lostCompletionNotice(entry({ status: "timeout", backend: "durable" }));
  assert.equal(notice.customType, "task-complete");
  assert.match(notice.content, /t-1 \(scout\) timeout/);
  assert.match(notice.content, /\/task status t-1/);
  assert.equal(notice.details.completion_delivery_id, completionDeliveryId("t-1", NOW - 60_000));
  assert.equal(notice.details.phase, "timeout");
  assert.equal(notice.details.replayed, true);
});
