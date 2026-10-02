/**
 * The durable execution backend (PI_TASK_BACKEND=durable): selection is
 * explicit-only and requires the optional pi-durable packages, and the
 * controller reuses the replay-safety pattern proven in the spike
 * (spikes/pi-durable/m1-subagent-replay.ts) with a faux model — no network,
 * no API keys.
 */

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";

import {
  abortDurableTask,
  runDurableTask,
  steerDurableTask,
} from "../src/subagent/durable.js";
import { resumeDurableAfterRestart } from "../src/lifecycle/durable-execution.js";
import { resolveTaskBackend } from "../src/subagent/selectBackend.js";
import { selectTerminalBackend } from "../src/subagent/terminalBackend.js";
import { decideCancellation } from "../src/task-control.js";

function withEnv(values: Record<string, string | undefined>, run: () => Promise<void>) {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return run().finally(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

const makeModels = (steps: string[]) => () => {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  faux.setResponses(steps.map((text) => fauxAssistantMessage(text)));
  return models;
};

test("PI_TASK_BACKEND=durable selects the durable backend when the packages exist", () => {
  return withEnv({ PI_TASK_BACKEND: "durable", PI_ACP: undefined }, async () => {
    const resolution = await resolveTaskBackend();
    assert.equal(resolution.ok, true, JSON.stringify(resolution));
    if (!resolution.ok) return;
    assert.equal(resolution.selectedBackend, "durable");
  });
});

test("auto never selects durable, and an unknown value is rejected", () => {
  return withEnv({ PI_TASK_BACKEND: "auto" }, async () => {
    const resolution = await resolveTaskBackend();
    assert.equal(resolution.ok, true);
    if (resolution.ok) assert.notEqual(resolution.selectedBackend, "durable");
  }).then(() =>
    withEnv({ PI_TASK_BACKEND: "wat" }, async () => {
      const resolution = await resolveTaskBackend();
      assert.equal(resolution.ok, false);
      if (!resolution.ok) assert.match(resolution.error, /Expected auto, sdk, durable/);
    }),
  );
});

test("selectTerminalBackend maps durable directly", () => {
  assert.equal(
    selectTerminalBackend({ requested: "durable", hasHerdr: false, hasTmux: false }),
    "durable",
  );
});

test("a running durable task is cancellable by decision", () => {
  const decision = decideCancellation({
    id: "t1",
    agentType: "general",
    description: "run",
    sessionName: "task-t1",
    backend: "durable",
    startedAt: 1,
    status: "running",
    source: "history",
  } as never);
  assert.equal(decision.kind, "allowed");
  assert.equal((decision as { backend?: string }).backend, "durable");
});

test("runDurableTask answers, reuses the child on rerun, steers, and aborts", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-task-durable-"));
  try {
    const db = join(dir, "tasks.sqlite");
    const root = mkdtempSync(join(tmpdir(), "pi-task-durable-pi-"));
    const piDir = join(root, ".pi");
    const databasePath = join(piDir, "durable", "tasks.sqlite");

    return (async () => {
      // One factory queues both answers: the harness is cached per database,
      // so the second task consumes the second queued response.
      const first = await runDurableTask({
        piDir,
        taskId: "t1",
        task: "Say the magic words.",
        databasePath,
        models: makeModels(["Magic words.", "Second answer."]),
      });
      assert.equal(first.answer, "Magic words.");
      // The spend ledger is surfaced even when a faux model reports nothing.
      assert.ok(first.usage, "usage ledger present");
      assert.equal(typeof first.usage.totals.totalTokens, "number");

      // Replay safety: the same task id resolves to the same child and the
      // same settled submission — the queued response is never consumed.
      const rerun = await runDurableTask({
        piDir,
        taskId: "t1",
        task: "Say the magic words.",
        databasePath,
        models: makeModels(["SHOULD NOT BE USED"]),
      });
      assert.equal(rerun.conversationId, first.conversationId);
      assert.equal(rerun.answer, "Magic words.");

      // A second task id gets its own child conversation.
      const second = await runDurableTask({
        piDir,
        taskId: "t2",
        task: "Different task.",
        databasePath,
      });
      assert.notEqual(second.conversationId, first.conversationId);
      assert.equal(second.answer, "Second answer.");

      // Steering queues a follow-up on the child without error.
      assert.equal(
        await steerDurableTask(piDir, "t2", "Check the logs first.", { databasePath }),
        null,
      );

      // Aborting stops the child conversation cleanly.
      assert.equal(
        await abortDurableTask(piDir, "t2", { databasePath }),
        null,
      );
    })().finally(() => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    });
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
});

// ── Crash matrix through the integrated delivery path ──────────────────────

test("SIGKILL mid-tool: the next process resumes and delivers exactly once", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-crash-"));
  const piDir = join(root, ".pi");
  const databasePath = join(piDir, "durable", "tasks.sqlite");
  const scriptPath = fileURLToPath(import.meta.url);
  const childScript = join(dirname(scriptPath), "durable-crash-child.ts");

  return (async () => {
    // 1. The child starts a durable task and gets stuck inside `bash sleep 30`.
    const child = spawn(
      process.execPath,
      ["--import", "tsx", childScript, databasePath, piDir, "t-crash"],
      { env: process.env, stdio: ["ignore", "pipe", "inherit"] },
    );
    await new Promise<void>((resolve, reject) => {
      let out = "";
      child.stdout!.on("data", (chunk: Buffer) => {
        out += chunk.toString();
        if (out.includes("M2 child: submitted")) resolve();
      });
      child.on("exit", (code) => reject(new Error(`child exited early: ${code}`)));
      setTimeout(() => reject(new Error("child never submitted")), 20_000).unref();
    });
    await new Promise((resolve) => setTimeout(resolve, 1_500)); // land mid-tool
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));

    // 2. The next process resumes and delivers exactly one task-complete.
    const sent: { content?: string; details?: Record<string, unknown> }[] = [];
    const pi = { sendMessage: (message: { content?: string; details?: Record<string, unknown> }) => { sent.push(message); } };
    const recovered = makeModels(["Recovered after crash."]);
    // Delivery is asynchronous: the resumed generation settles on the event
    // loop after the pass registers its hooks, so poll for it.
    const waitForDelivery = async (): Promise<void> => {
      for (let waited = 0; waited < 10_000 && sent.length === 0; waited += 50) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    resumeDurableAfterRestart({
      pi: pi as never,
      piDir,
      sessionId: "sess-1",
      databasePath,
      models: recovered,
    }).catch(() => {});
    await waitForDelivery();
    assert.equal(sent.length, 1, `exactly one delivery, got ${sent.length}`);
    assert.match(sent[0]!.content ?? "", /resumed after restart and finished/);
    assert.equal(sent[0]!.details?.task_id, "t-crash");
    assert.equal(sent[0]!.details?.backend, "durable");
    assert.equal(sent[0]!.details?.resumed, true);
    assert.ok(sent[0]!.details?.usage, "resumed receipt carries the usage ledger");

    // 3. Running the resume pass again delivers nothing: the submission is
    // settled, so chaos retries cannot duplicate the delivery.
    await resumeDurableAfterRestart({
      pi: pi as never,
      piDir,
      sessionId: "sess-1",
      databasePath,
      models: recovered,
    });
    assert.equal(sent.length, 1, "no duplicate delivery on the second pass");
  })().finally(() => {
    rmSync(root, { recursive: true, force: true });
  });
});
