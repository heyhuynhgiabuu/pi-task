import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BackgroundTask } from "../src/types.js";
import {
  acknowledgePersistedCompletionDeliveries,
  createCompletionDeliveryQueue,
} from "../src/lifecycle/completion.js";
import { registerTaskSessionReplacementGuard } from "../src/lifecycle/session-switch-guard.js";
import { test } from "node:test";

test("live tasks and queued completion cancel Pi session replacement before shutdown", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-session-switch-guard-"));
  const completionQueue = createCompletionDeliveryQueue(0);
  try {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const notices: string[] = [];
    const pi = {
      on(event: string, handler: (...args: any[]) => unknown) {
        handlers.set(event, handler);
        return () => handlers.delete(event);
      },
    } as unknown as ExtensionAPI;
    const foregroundTasks = new Map<string, BackgroundTask>();
    const backgroundTasks = new Map<string, BackgroundTask>([["live", {} as BackgroundTask]]);
    registerTaskSessionReplacementGuard(
      pi,
      foregroundTasks,
      backgroundTasks,
      () => completionQueue.hasPending(),
    );

    let aborted = 0;
    let disposed = 0;
    let replacementCreated = 0;
    const runner = {
      hasHandlers(event: string) {
        return event === "session_before_switch" || event === "session_before_fork";
      },
      async emit(event: { type: string; [key: string]: unknown }) {
        if (event.type !== "session_before_switch" && event.type !== "session_before_fork") {
          return undefined;
        }
        return handlers.get(event.type)?.(event, {
          ui: { notify: (message: string) => notices.push(message) },
        });
      },
    };
    const session = {
      extensionRunner: runner,
      sessionFile: join(root, "current.jsonl"),
      async abort() {
        aborted++;
      },
      dispose() {
        disposed++;
      },
    } as unknown as AgentSession;
    const runtime = new AgentSessionRuntime(
      session,
      { cwd: root, agentDir: root } as never,
      async () => {
        replacementCreated++;
        throw new Error("a blocked replacement must not create a new runtime");
      },
    );

    const result = await runtime.switchSession(join(root, "target.jsonl"));

    assert.deepEqual(result, { cancelled: true });
    assert.equal(aborted, 0, "the source agent session stays alive");
    assert.equal(disposed, 0, "session_shutdown is not reached");
    assert.equal(replacementCreated, 0, "the replacement runtime is not created");
    assert.ok(notices.some((message) => message.includes("pi-task agents")));
    assert.equal(backgroundTasks.has("live"), true, "the task handle remains tracked");
    assert.deepEqual(await runtime.fork("entry"), { cancelled: true });
    assert.equal(aborted, 0, "forking also leaves the source task runtime intact");

    backgroundTasks.clear();
    let delivered = 0;
    completionQueue.enqueue("completion-1", () => { delivered += 1; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(delivered, 1, "the debounce queue dispatched the completion notice");
    assert.equal(completionQueue.hasPending(), true, "native persistence is still outstanding");
    const pendingDeliveryResult = await runtime.switchSession(join(root, "target.jsonl"));
    assert.deepEqual(pendingDeliveryResult, { cancelled: true });
    assert.equal(aborted, 0, "pending completion delivery also blocks teardown");
    assert.equal(replacementCreated, 0, "pending completion delivery remains guarded");

    acknowledgePersistedCompletionDeliveries(completionQueue, [{
      type: "custom_message",
      customType: "task-complete",
      details: { completion_delivery_id: "completion-1" },
    }]);
    const allowed = await handlers.get("session_before_switch")?.(
      { type: "session_before_switch" },
      { ui: { notify: (message: string) => notices.push(message) } },
    );
    assert.equal(allowed, undefined, "the persisted completion message releases the guard");
  } finally {
    completionQueue.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
