import { strict as assert } from "node:assert";
import test from "node:test";

import {
  completionDeliveryId,
  createCompletionDeliveryQueue,
  findLostCompletionNotices,
  LOST_NOTICE_MAX_AGE_MS,
  lostCompletionNotice,
  replayLostCompletionNotices,
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

function find(
  history: TaskSessionHistoryEntry[],
  saved: string[] = [],
  isProcessAlive: (pid: number) => boolean = (pid) => pid !== DEAD_PID,
) {
  return findLostCompletionNotices({
    history,
    sessionId: "sess-1",
    persisted: (ids) => new Set([...ids].filter((id) => saved.includes(id))),
    now: NOW,
    isProcessAlive,
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
  assert.deepEqual(find([entry({ ownerPid: process.pid })], [], () => false), [], "this process, even if probed as dead");
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
  assert.equal(notice.details.summary !== undefined, true, "the TUI renders the summary");
  assert.equal(notice.details.completion_delivery_id, completionDeliveryId("t-1", NOW - 60_000));
  assert.equal(notice.details.phase, "timeout");
  assert.equal(notice.details.replayed, true);
});

function replay(allows: (taskId: string) => boolean, history = [entry()]) {
  const sent: unknown[] = [];
  const queue = createCompletionDeliveryQueue(0);
  replayLostCompletionNotices({
    history,
    sessionId: "sess-1",
    persisted: () => new Set(),
    now: NOW,
    isProcessAlive: () => false,
    pi: { sendMessage: (message: unknown) => { sent.push(message); } } as never,
    queue,
    allows,
  });
  return { sent, queue };
}

async function settle(queue: { hasPending(): boolean }) {
  for (let waited = 0; waited < 1_000 && queue.hasPending(); waited += 10) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("the replay queues one replacement notice for a lost task and delivers it", async () => {
  const { sent, queue } = replay(() => true);
  try {
    assert.deepEqual(queue.pendingDeliveryIds(), [completionDeliveryId("t-1", NOW - 60_000)]);
    for (let waited = 0; waited < 1_000 && sent.length === 0; waited += 10) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(sent.length, 1);
  } finally {
    queue.dispose();
  }
});

test("the replay never delivers into a conversation the delivery guard withholds", async () => {
  const { sent, queue } = replay(() => false);
  try {
    await settle(queue);
    assert.equal(sent.length, 0, "a notice withheld on purpose is not replayed");
    assert.equal(queue.hasPending(), false, "and it does not stay queued");
  } finally {
    queue.dispose();
  }
});
