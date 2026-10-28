/**
 * What a durable run does when its harness is closed under it. A harness closed by a
 * reload rejects the run's waits with a plain `Error("Harness is closed")`, which is
 * neither a `SessionFailed` storage failure nor a task failure. Written as `failed`
 * it would never be resumed: the new copy reclaims only history rows still `running`,
 * so the task would be rerun by the new harness with no owner and no delivery.
 *
 * `retireDurableHarnesses` flips module state for the whole process, so this file keeps
 * the control first and everything after it runs as a retired copy.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readTaskSessionHistory } from "../src/conversation.js";
import { executeDurableTask } from "../src/lifecycle/durable-execution.js";
import { DeliveryGuard } from "../src/panel/delivery.js";
import { retireDurableHarnesses } from "../src/subagent/durable.js";

const agent = {
  name: "general",
  description: "General task",
  body: "",
  source: "project",
  path: "test-agent.md",
} as const;

function harnessClosed(): Error {
  return new Error("Harness is closed");
}

async function runTaskOnce(id: string, error: Error, isBackground: boolean) {
  const root = mkdtempSync(join(tmpdir(), "pi-task-reload-runner-"));
  const piDir = join(root, ".pi");
  mkdirSync(piDir, { recursive: true });
  const backgroundTasks = new Map<string, import("../src/types.js").BackgroundTask>();
  const delivered: unknown[] = [];
  const pi = new Proxy(
    {},
    { get: () => (...args: unknown[]) => delivered.push(args) },
  );
  try {
    const result = await executeDurableTask({
      id,
      agent,
      description: "long task",
      sessionName: `task-${id}`,
      prompt: "Do the long thing.",
      cwd: root,
      toolCallId: `call-${id}`,
      ctx: { modelRegistry: {} } as never,
      pi: pi as never,
      piDir,
      artifactsDir: join(piDir, "artifacts"),
      isBackground,
      backgroundTasks,
      foregroundTasks: new Map(),
      deliveryGuard: new DeliveryGuard(),
      taskWidget: {
        openTaskView() {},
        closeTaskView() {},
        noteTaskFinished() {},
        setLiveTranscript() {},
      } as never,
      clearTaskWidgetIfIdle: () => {},
      ensureTaskWidget: () => {},
      enqueueDelivery: (delivery) => delivery(),
      runTask: async (input) => {
        input.onSubmitted?.("child-conversation");
        throw error;
      },
    });
    for (let waited = 0; isBackground && backgroundTasks.has(id); waited += 10) {
      if (waited > 5_000) throw new Error("the background run never settled");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return {
      status: readTaskSessionHistory(piDir).find((entry) => entry.id === id)?.status,
      delivered,
      result,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const runBackground = (id: string, error: Error) => runTaskOnce(id, error, true);
const runForeground = (id: string, error: Error) => runTaskOnce(id, error, false);

test("control: before any retirement a closed-harness error is a failure, recorded and delivered", async () => {
  const outcome = await runBackground("t-control", harnessClosed());

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.delivered.length > 0, true, "the failure is reported to the parent");
});

test("after a retirement a closed-harness error leaves the run `running` and delivers nothing", async () => {
  await retireDurableHarnesses();

  const outcome = await runBackground("t-retired", harnessClosed());

  assert.equal(outcome.status, "running", "the new copy reclaims and resumes a running row");
  assert.deepEqual(outcome.delivered, [], "no failure is announced for work that will be resumed");
});

test("after a retirement a foreground closed-harness error is not written as failed either", async () => {
  await retireDurableHarnesses();

  const outcome = await runForeground("t-retired-foreground", harnessClosed());

  assert.equal(outcome.status, "running");
  // The new copy delivers the real result, so the parent must not be told it failed.
  const result = outcome.result as { isError?: boolean; content: { text: string }[]; details: { phase: string } };
  assert.notEqual(result.isError, true);
  assert.equal(result.details.phase, "running");
  assert.match(result.content[0]!.text, /interrupted by a reload/);
  assert.doesNotMatch(result.content[0]!.text, /Harness is closed|failed/i);
});

test("after a retirement a hard timeout is still recorded as a timeout", async () => {
  const { DurableTaskTimeoutError } = await import("../src/subagent/durable.js");

  const outcome = await runBackground("t-timeout", new DurableTaskTimeoutError());

  assert.equal(outcome.status, "timeout");
});

test("after a retirement a user cancel is still recorded as cancelled", async () => {
  const { DurableTaskCancelledError } = await import("../src/subagent/durable.js");

  const outcome = await runBackground("t-cancelled", new DurableTaskCancelledError());

  assert.equal(outcome.status, "cancelled");
});
