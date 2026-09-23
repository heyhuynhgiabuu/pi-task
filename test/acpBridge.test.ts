import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sendAcpTaskSessionLink,
  watchChildSessionReady,
} from "../src/subagent/acpBridge.js";

function fakeSession() {
  const handlers: Array<(event: Record<string, unknown>) => void> = [];
  return {
    subscribe(cb: (event: Record<string, unknown>) => void) {
      handlers.push(cb);
      return () => {
        const index = handlers.indexOf(cb);
        if (index >= 0) handlers.splice(index, 1);
      };
    },
    emit(event: Record<string, unknown>) {
      for (const handler of [...handlers]) handler(event);
    },
    get subscribers() {
      return handlers.length;
    },
  };
}

function fakePi() {
  const sent: Array<{ customType: string; data: any }> = [];
  const messages: any[] = [];
  let throwOnAppend = false;
  return {
    sent,
    messages,
    failNextAppend() {
      throwOnAppend = true;
    },
    appendEntry(customType: string, data: any) {
      if (throwOnAppend) {
        throwOnAppend = false;
        throw new Error("stale ctx");
      }
      sent.push({ customType, data });
    },
    sendMessage(message: any) {
      messages.push(message);
    },
  };
}

function tempTranscript() {
  const dir = mkdtempSync(join(tmpdir(), "pi-task-bridge-"));
  return join(dir, "child.jsonl");
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

{
  const pi = fakePi();
  sendAcpTaskSessionLink(pi as any, {
    taskId: "task-1",
    sessionId: "child-1",
    piToolCallId: "call-9",
  });

  assert.deepEqual(pi.sent, [
    {
      customType: "task-session",
      data: { task_id: "task-1", session_id: "child-1", pi_tool_call_id: "call-9" },
    },
  ]);
  assert.equal(
    pi.messages.length,
    0,
    "the link is persisted only as a session entry; an empty custom message can project as an empty user turn",
  );
}

{
  const pi = fakePi();
  pi.failNextAppend();
  assert.doesNotThrow(() => {
    sendAcpTaskSessionLink(pi as any, { taskId: "task-1", sessionId: "child-1" });
  }, "a failed link must not break the task");
  assert.equal(pi.sent.length, 0, "a failed append persists nothing");
  assert.equal(pi.messages.length, 0, "the link is never sent as a custom message");

  sendAcpTaskSessionLink(pi as any, { taskId: "task-1", sessionId: "child-1" });
  assert.deepEqual(
    pi.sent,
    [{ customType: "task-session", data: { task_id: "task-1", session_id: "child-1" } }],
    "linking keeps working after a failed attempt and omits an absent tool-call id",
  );
}

{
  const session = fakeSession();
  let ready = 0;
  const stop = watchChildSessionReady(session as any, tempTranscript(), () => ready++);

  session.emit({ type: "entry_appended" });
  await tick();
  assert.equal(ready, 0, "a missing transcript is not ready");

  stop();
  assert.equal(session.subscribers, 0);
}

{
  const session = fakeSession();
  const path = tempTranscript();
  writeFileSync(path, "");
  let ready = 0;
  watchChildSessionReady(session as any, path, () => ready++);

  session.emit({ type: "tool_execution_start" });
  await tick();
  assert.equal(ready, 0, "unrelated events do not trigger the link");

  session.emit({ type: "message_end" });
  await tick();
  assert.equal(ready, 1, "the first transcript-backed event links the child");
  assert.equal(session.subscribers, 0, "the watcher unsubscribes after firing");

  session.emit({ type: "entry_appended" });
  await tick();
  assert.equal(ready, 1, "the link fires exactly once");
}

{
  const session = fakeSession();
  const path = tempTranscript();
  writeFileSync(path, "");
  let ready = 0;
  const stop = watchChildSessionReady(session as any, path, () => ready++);

  stop();
  session.emit({ type: "entry_appended" });
  await tick();
  assert.equal(ready, 0, "stopping the watcher prevents the link");
}

{
  const session = fakeSession();
  const path = tempTranscript();
  let ready = 0;
  const stop = watchChildSessionReady(session as any, path, () => ready++);

  // The transcript is missing, so the event queues a microtask that will re-check it.
  session.emit({ type: "entry_appended" });
  stop();
  // The transcript appears before the queued microtask runs.
  writeFileSync(path, "");
  await tick();

  assert.equal(ready, 0, "a queued microtask cannot link the child after the watcher stops");
  assert.equal(session.subscribers, 0, "stopping the watcher still unsubscribes");
}

console.log("ALL ACP BRIDGE TESTS PASSED");
