import assert from "node:assert/strict";
import test from "node:test";
import { serializeTaskAdmission } from "../src/task-admission.js";

test("serializes concurrent launches for one durable task identity", async () => {
  const events: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = serializeTaskAdmission("/repo\u0000conversation:research", async () => {
    events.push("first-start");
    await firstGate;
    events.push("first-end");
  });
  const second = serializeTaskAdmission("/repo\u0000conversation:research", async () => {
    events.push("second-start");
    events.push("second-end");
  });

  await Promise.resolve();
  assert.deepEqual(events, ["first-start"]);
  releaseFirst?.();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first-start", "first-end", "second-start", "second-end"]);
});

test("does not serialize unrelated task identities", async () => {
  const events: string[] = [];
  await Promise.all([
    serializeTaskAdmission("/repo\u0000conversation:one", async () => {
      events.push("one");
    }),
    serializeTaskAdmission("/repo\u0000conversation:two", async () => {
      events.push("two");
    }),
  ]);
  assert.deepEqual(events.sort(), ["one", "two"]);
});
