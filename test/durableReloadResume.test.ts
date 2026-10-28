/**
 * A task is handed through more than one reload: started by copy A, resumed by copy B
 * (after a Pi restart, or an earlier reload), and cut short again when B is replaced by
 * copy C. Each retirement leaves the run unfinished, never failed, so the next copy
 * claims it and delivers it once.
 *
 * Driven through `executeDurableTask` and `resumeDurableAfterRestart` rather than
 * `runDurableTask` alone: history and delivery are decided there, and the order in which
 * a copy marks itself retired and closes its harness only shows in what they record.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readTaskSessionHistory } from "../src/conversation.js";
import { DeliveryGuard } from "../src/panel/delivery.js";
import {
  evaluateExtensionCopy,
  gatedModels,
  instantModels,
  type ExtensionCopy,
} from "./durable-reload-helpers.js";

const agent = {
  name: "general",
  description: "General task",
  body: "",
  source: "project",
  path: "test-agent.md",
} as const;

type Delivery = { content?: string; details?: { phase?: string } };

/** A `pi` whose `sendMessage` records what was announced to the parent. */
function recordingPi() {
  const sent: Delivery[] = [];
  const pi = {
    sendMessage: (message: Delivery) => {
      sent.push(message);
    },
  };

  return { pi, sent };
}

async function until(label: string, condition: () => boolean, limitMs = 10_000) {
  for (let waited = 0; !condition(); waited += 10) {
    if (waited > limitMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function resume(
  copy: ExtensionCopy,
  piDir: string,
  databasePath: string,
  pi: unknown,
  models: ReturnType<typeof gatedModels>["models"],
  settled: string[],
) {
  return copy.execution.resumeDurableAfterRestart({
    pi: pi as never,
    piDir,
    sessionId: "sess-1",
    databasePath,
    models: () => models,
    onTaskSettled: (taskId) => {
      settled.push(taskId);
    },
  });
}

test("a task handed through two reloads is never written failed, and the last copy delivers it once", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-reload-chain-"));
  const piDir = join(root, ".pi");
  mkdirSync(piDir, { recursive: true });
  const id = "t-chain";
  const status = () => readTaskSessionHistory(piDir).find((entry) => entry.id === id)?.status;
  const originalError = console.error;
  console.error = () => undefined;
  const gateA = gatedModels("answer from A");
  const gateB = gatedModels("answer from B");
  let releasedA = false;
  let releasedB = false;
  try {
    const copyA = await evaluateExtensionCopy(root, "copy-a");
    const copyB = await evaluateExtensionCopy(root, "copy-b");
    const copyC = await evaluateExtensionCopy(root, "copy-c");
    const databasePath = copyA.durable.durableDatabasePath(piDir);

    // Copy A starts the task and is retired while its model turn is in flight.
    const a = recordingPi();
    const backgroundTasks = new Map<string, import("../src/types.js").BackgroundTask>();
    await copyA.execution.executeDurableTask({
      id,
      agent,
      description: "long task",
      sessionName: `task-${id}`,
      prompt: "Do the long thing.",
      cwd: root,
      toolCallId: "call-chain",
      ctx: { modelRegistry: {} } as never,
      pi: a.pi as never,
      piDir,
      artifactsDir: join(piDir, "artifacts"),
      isBackground: true,
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
      runTask: (input) => copyA.durable.runDurableTask({ ...input, models: () => gateA.models }),
    });
    await gateA.reached;
    const retiredA = copyA.durable.retireDurableHarnesses();
    gateA.release();
    releasedA = true;
    await retiredA;
    await until("copy A's run to settle", () => !backgroundTasks.has(id));

    assert.equal(status(), "running", "copy A leaves its cut-short run running");
    assert.deepEqual(a.sent, [], "copy A announces nothing for work the next copy resumes");

    // Copy B resumes it, and is itself retired while the resumed turn is in flight.
    const b = recordingPi();
    const settledB: string[] = [];
    const resumedByB = await resume(copyB, piDir, databasePath, b.pi, gateB.models, settledB);
    assert.deepEqual([...resumedByB], [id], "copy B claims the run");
    await gateB.reached;
    const retiredB = copyB.durable.retireDurableHarnesses();
    gateB.release();
    releasedB = true;
    await retiredB;
    await until("copy B's resumed run to settle", () => settledB.includes(id));

    assert.equal(status(), "running", "copy B leaves the resumed run running too");
    assert.deepEqual(b.sent, [], "copy B announces no failure for a run copy C resumes");

    // Copy C claims it again and delivers it exactly once.
    const c = recordingPi();
    const settledC: string[] = [];
    const next = instantModels("Status: success\nDone by C.");
    const resumedByC = await resume(copyC, piDir, databasePath, c.pi, next.models, settledC);
    assert.deepEqual([...resumedByC], [id], "copy C claims the run");
    await until("copy C's delivery", () => c.sent.length > 0);
    await until("copy C's run to settle", () => settledC.includes(id));

    assert.equal(c.sent.length, 1, "delivered once");
    assert.notEqual(c.sent[0]?.details?.phase, "failed");
    assert.equal(status(), "done");
    await copyC.durable.retireDurableHarnesses();
  } finally {
    console.error = originalError;
    if (!releasedA) gateA.release();
    if (!releasedB) gateB.release();
    rmSync(root, { recursive: true, force: true });
  }
});
