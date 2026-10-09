/**
 * The durable execution backend (PI_TASK_BACKEND=durable): selection is
 * explicit-only and requires the optional pi-durable packages, and the
 * controller reuses the replay-safety pattern proven in the spike
 * (spikes/pi-durable/m1-subagent-replay.ts) with a faux model — no network,
 * no API keys.
 */

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

import {
  abortDurableTask,
  durableRequestId,
  DurableTaskCancelledError,
  durableRetryFromSettings,
  executeDurableChildBuiltinCommand,
  openDurableHarness,
  resumeDurableTasks,
  runDurableTask,
  setDurableRetrySettingsSource,
  steerDurableTask,
  createPiRuntimeModels,
  parseDurableThinkingLevel,
  type DurableRuntimeModelRegistry,
} from "../src/subagent/durable.js";
import {
  executeDurableTask,
  reconcileUnadmittedDurableTasks,
  resumeDurableAfterRestart,
} from "../src/lifecycle/durable-execution.js";
import {
  acknowledgePersistedCompletionDeliveries,
  createCompletionDeliveryQueue,
} from "../src/lifecycle/completion.js";
import { DeliveryGuard } from "../src/panel/delivery.js";
import { DurableTranscript } from "../src/panel/durable-transcript.js";
import { createTaskWidgetController } from "../src/lifecycle/widget.js";
import { readTaskSessionHistory, upsertTaskSessionHistory } from "../src/conversation.js";
import { reconcileStaleSdkBackgroundTasks } from "../src/subagent/sdkBackground.js";
import { resolveTaskBackend } from "../src/subagent/selectBackend.js";
import { selectTerminalBackend } from "../src/subagent/terminalBackend.js";
import { decideCancellation } from "../src/task-control.js";
import { handleTaskControl } from "../src/task-control-api.js";
import { resolveTaskResume } from "../src/lifecycle/task-resume.js";

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

function makeGatedModels(
  steps: (string | import("@earendil-works/pi-ai").AssistantMessage)[],
) {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  faux.setResponses(steps.map((step) =>
    typeof step === "string" ? fauxAssistantMessage(step) : step
  ));
  const gates = steps.map(() => {
    let resolveReached!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => { resolveReached = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    return {
      reached,
      release: () => release(),
      resolveReached: () => resolveReached(),
      wait,
    };
  });
  const originalStreamSimple = models.streamSimple.bind(models);
  let streamIndex = 0;
  models.streamSimple = (model, context, options) => {
    const index = streamIndex++;
    const stream = originalStreamSimple(model, context, options);
    const gate = gates[index];
    if (gate) {
      const result = stream.result.bind(stream);
      stream.result = async () => {
        gate.resolveReached();
        await gate.wait;
        return result();
      };
    }
    return stream;
  };
  const resultReached = (index: number) => gates[index]?.reached ?? Promise.resolve();
  const releaseResult = (index: number) => gates[index]?.release();
  return {
    models,
    firstResultReached: resultReached(0),
    releaseFirstResult: () => releaseResult(0),
    resultReached,
    releaseResult,
  };
}

async function waitForChildIdle(
  handle: Awaited<ReturnType<typeof openDurableHarness>>,
  conversationId: string | undefined,
): Promise<void> {
  if (!conversationId) return;
  const conversation = await handle.harness.conversation(
    conversationId as never,
    handle.context,
  );
  await conversation?.waitForIdle(handle.context);
}

async function waitForAbortRequested(
  handle: Awaited<ReturnType<typeof openDurableHarness>>,
  conversationId: string,
): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const inspection = await handle.harness.inspect(handle.context);
    if (inspection.tasks.some(({ record }) =>
      String(record.conversationId) === conversationId && record.abortRequested
    )) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("conversation abort was not durably admitted");
}

const makeRuntimeModelRegistry = (
  steps: string[],
  modelIds: string | string[] = "faux-1",
): DurableRuntimeModelRegistry => {
  const models = createModels();
  const faux = fauxProvider({
    models: (Array.isArray(modelIds) ? modelIds : [modelIds]).map((id) => ({ id })),
  });
  models.setProvider(faux.provider);
  faux.setResponses(steps.map((text) => fauxAssistantMessage(text)));
  return {
    getAll: () => models.getAllModels() as never,
    find: (provider, modelId) => models.getModel(provider, modelId),
    streamSimple: (model, context, options) => models.streamSimple(model, context, options),
  };
};

/**
 * A faux Pi model registry with a `primary`/`fallback` pair that records the
 * model id of every provider call, so failover order is observable.
 */
const makeFailoverRegistry = (
  steps: (string | import("@earendil-works/pi-ai").AssistantMessage)[],
) => {
  const models = createModels();
  const faux = fauxProvider({ models: [{ id: "primary" }, { id: "fallback" }] });
  models.setProvider(faux.provider);
  faux.setResponses(steps.map((step) =>
    typeof step === "string" ? fauxAssistantMessage(step) : step
  ));
  const calls: string[] = [];
  const registry: DurableRuntimeModelRegistry = {
    getAll: () => models.getAllModels() as never,
    find: (provider, modelId) => models.getModel(provider, modelId),
    streamSimple: (model, context, options) => {
      calls.push(model.id);
      return models.streamSimple(model, context, options);
    },
  };
  return { models, faux, calls, registry };
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

test("durable generation and compaction use the live Pi model registry", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-pi-models-"));
  const piDir = join(root, ".pi");
  const databasePath = join(root, "durable.sqlite");
  const modelRegistry = makeRuntimeModelRegistry(
    [
      "Compaction summary from Pi runtime.",
      "Generated by Pi's runtime registry.",
    ],
    ["vendor/default", "vendor/high"],
  );
  const availableModels = modelRegistry.getAll();
  const sessionModel = availableModels[0]!;
  const selected = availableModels[1]!;
  let handle: Awaited<ReturnType<typeof openDurableHarness>> | undefined;
  try {
    handle = await openDurableHarness(piDir, {
      databasePath,
      modelRegistry,
    });
    const summary = await handle.models.completeSimple(selected, {
      messages: [{ role: "user", content: "Summarize this conversation." }],
    });
    assert.match(JSON.stringify(summary.content), /Compaction summary from Pi runtime/);

    const result = await runDurableTask({
      piDir,
      databasePath,
      taskId: "t-pi-runtime-model",
      task: "Say hello.",
      model: `${selected.provider}/${selected.id}`,
      sessionModel: { provider: sessionModel.provider, modelId: sessionModel.id },
      modelRegistry,
    });
    assert.equal(result.answer, "Generated by Pi's runtime registry.");
    assert.ok(result.usage.models[`${selected.provider}/${selected.id}`]);
    assert.equal(result.usage.models[`${sessionModel.provider}/${sessionModel.id}`], undefined);
  } finally {
    if (handle) await handle.harness.close(handle.context);
    rmSync(root, { recursive: true, force: true });
  }
});

test("durable session-model fallback preserves slash-containing model IDs", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-session-model-"));
  const piDir = join(root, ".pi");
  const databasePath = join(root, "durable.sqlite");
  const modelRegistry = makeRuntimeModelRegistry(
    ["Generated with the slash-containing session model."],
    ["vendor/default", "vendor/model"],
  );
  let handle: Awaited<ReturnType<typeof openDurableHarness>> | undefined;
  try {
    handle = await openDurableHarness(piDir, { databasePath, modelRegistry });
    const selected = modelRegistry.getAll()[1]!;
    const result = await runDurableTask({
      piDir,
      databasePath,
      taskId: "t-session-slash-model",
      task: "Say hello.",
      sessionModel: { provider: selected.provider, modelId: selected.id },
      modelRegistry,
    });
    assert.equal(result.answer, "Generated with the slash-containing session model.");
    assert.ok(result.usage.models[`${selected.provider}/${selected.id}`]);
    assert.equal(
      result.usage.models[`${modelRegistry.getAll()[0]!.provider}/${modelRegistry.getAll()[0]!.id}`],
      undefined,
    );
  } finally {
    if (handle) await handle.harness.close(handle.context);
    rmSync(root, { recursive: true, force: true });
  }
});

test("durable explicit bare model IDs take precedence over session fallback", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-bare-model-"));
  const piDir = join(root, ".pi");
  const databasePath = join(root, "durable.sqlite");
  const modelRegistry = makeRuntimeModelRegistry(
    ["Generated by the explicit bare model."],
    ["session-default", "bare-model"],
  );
  const [sessionModel, configuredModel] = modelRegistry.getAll();
  let handle: Awaited<ReturnType<typeof openDurableHarness>> | undefined;
  try {
    handle = await openDurableHarness(piDir, { databasePath, modelRegistry });
    const result = await runDurableTask({
      piDir,
      databasePath,
      taskId: "t-bare-model-precedence",
      task: "Say hello.",
      model: configuredModel!.id,
      sessionModel: { provider: sessionModel!.provider, modelId: sessionModel!.id },
      modelRegistry,
    });
    assert.equal(result.answer, "Generated by the explicit bare model.");
    assert.ok(result.usage.models[`${configuredModel!.provider}/${configuredModel!.id}`]);
    assert.equal(
      result.usage.models[`${sessionModel!.provider}/${sessionModel!.id}`],
      undefined,
    );
  } finally {
    if (handle) await handle.harness.close(handle.context);
    rmSync(root, { recursive: true, force: true });
  }
});

test("durable rejects invalid explicit models instead of using session fallback", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-invalid-model-"));
  const piDir = join(root, ".pi");
  const databasePath = join(root, "durable.sqlite");
  const modelRegistry = makeRuntimeModelRegistry(
    ["This fallback must not run."],
    "session-default",
  );
  const sessionModel = modelRegistry.getAll()[0]!;
  let handle: Awaited<ReturnType<typeof openDurableHarness>> | undefined;
  try {
    handle = await openDurableHarness(piDir, { databasePath, modelRegistry });
    for (const [index, model] of ["missing-model", "faux/"].entries()) {
      await assert.rejects(
        runDurableTask({
          piDir,
          databasePath,
          taskId: `t-invalid-model-${index}`,
          task: "Say hello.",
          model,
          sessionModel: { provider: sessionModel.provider, modelId: sessionModel.id },
          modelRegistry,
        }),
        /is not available in the model registry/,
      );
    }
  } finally {
    if (handle) await handle.harness.close(handle.context);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a cached registry-less harness adopts Pi's runtime registry before durable execution", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-late-registry-"));
  const piDir = join(root, ".pi");
  const databasePath = join(root, "durable.sqlite");
  const modelRegistry = makeRuntimeModelRegistry(
    [
      "Generated after the Pi registry was supplied.",
      "Compacted after the Pi registry was supplied.",
    ],
    "runtime-model",
  );
  const selected = modelRegistry.getAll()[0]!;
  let handle: Awaited<ReturnType<typeof openDurableHarness>> | undefined;
  try {
    assert.match(
      (await steerDurableTask(piDir, "not-started", "No child yet.", { databasePath })) ?? "",
      /No durable child conversation/,
    );
    handle = await openDurableHarness(piDir, { databasePath });
    const result = await runDurableTask({
      piDir,
      databasePath,
      taskId: "t-late-runtime-registry",
      task: "Say hello.",
      sessionModel: { provider: selected.provider, modelId: selected.id },
      modelRegistry,
    });
    assert.equal(result.answer, "Generated after the Pi registry was supplied.");
    assert.ok(result.usage.models[`${selected.provider}/${selected.id}`]);
    const summary = await handle.models.completeSimple(selected, {
      messages: [{ role: "user", content: "Summarize this conversation." }],
    });
    assert.match(
      JSON.stringify(summary.content),
      /Compacted after the Pi registry was supplied/,
    );
  } finally {
    if (handle) await handle.harness.close(handle.context);
    rmSync(root, { recursive: true, force: true });
  }
});

test("runDurableTask aborts its child conversation when its foreground signal is cancelled", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-abort-signal-"));
  const piDir = join(root, ".pi");
  const databasePath = join(root, "durable.sqlite");
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 2" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("The tool was not cancelled."),
  ]);
  let handle: Awaited<ReturnType<typeof openDurableHarness>> | undefined;
  const controller = new AbortController();
  try {
    handle = await openDurableHarness(piDir, { databasePath, models: () => models });
    const startedAt = Date.now();
    await assert.rejects(
      runDurableTask({
        piDir,
        databasePath,
        taskId: "t-abort-signal",
        task: "Run a cancellable tool.",
        models: () => models,
        signal: controller.signal,
        onSubmitted: () => {
          setTimeout(() => controller.abort(), 100);
        },
      }),
      DurableTaskCancelledError,
    );
    assert.ok(Date.now() - startedAt < 1_500, "signal aborts the in-flight tool instead of waiting for it");
  } finally {
    if (handle) await handle.harness.close(handle.context);
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancellation while reserving a durable run withdraws it before prompt admission", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-cancel-reservation-"));
  const piDir = join(root, ".pi");
  const databasePath = join(root, "durable.sqlite");
  const taskId = "t-cancel-reservation";
  const cancelledRequestId = durableRequestId(taskId, "call-cancelled");
  const nextRequestId = durableRequestId(taskId, "call-next");
  const controller = new AbortController();
  const gated = makeGatedModels(["New request answer.", "New request answer."]);
  let handle: Awaited<ReturnType<typeof openDurableHarness>> | undefined;
  let conversationId: string | undefined;
  let cancelledPromise: ReturnType<typeof runDurableTask> | undefined;
  let nextPromise: ReturnType<typeof runDurableTask> | undefined;
  let releaseReservation!: () => void;
  let reservationReached!: () => void;
  const reservationGate = new Promise<void>((resolve) => { releaseReservation = resolve; });
  const reservationStarted = new Promise<void>((resolve) => { reservationReached = resolve; });
  try {
    handle = await openDurableHarness(piDir, { databasePath, models: () => gated.models });
    const originalConversation = handle.harness.conversation.bind(handle.harness);
    handle.harness.conversation = async (id, context) => {
      const conversation = await originalConversation(id, context);
      if (!conversation) return conversation;
      const originalCommit = conversation.commit.bind(conversation);
      let pauseAdmission = true;
      conversation.commit = async (change, commitContext) =>
        originalCommit(async (tx) => {
          const result = await change(tx);
          if (
            pauseAdmission &&
            typeof result === "object" &&
            result !== null &&
            "status" in result &&
            result.status === "admitting"
          ) {
            pauseAdmission = false;
            reservationReached();
            await reservationGate;
          }
          return result;
        }, commitContext);
      return conversation;
    };

    cancelledPromise = runDurableTask({
      piDir,
      databasePath,
      taskId,
      task: "CANCELLED_INSTRUCTION",
      requestId: cancelledRequestId,
      models: () => gated.models,
      signal: controller.signal,
      onSubmitted: (id) => { conversationId = id; },
    });
    await reservationStarted;
    controller.abort();
    releaseReservation();
    await assert.rejects(cancelledPromise, DurableTaskCancelledError);

    const children = await handle.harness.snapshot(handle.children, handle.context);
    conversationId = String(children?.byOwner[`pi-task:${taskId}`]?.conversationId);
    assert.ok(conversationId && conversationId !== "undefined");
    const childId = Number(conversationId) as never;
    assert.equal(
      await handle.hasSubmission(childId, cancelledRequestId),
      false,
      "the cancelled prompt must not be admitted while its reservation was pending",
    );

    nextPromise = runDurableTask({
      piDir,
      databasePath,
      taskId,
      task: "NEW_INSTRUCTION",
      requestId: nextRequestId,
    });
    gated.releaseResult(0);
    gated.releaseResult(1);
    const nextResult = await nextPromise;
    assert.equal(nextResult.answer, "New request answer.");
    const conversation = await handle.harness.conversation(childId, handle.context);
    assert.ok(conversation);
    const modelContext = JSON.stringify((await conversation.context(handle.context)).messages);
    assert.doesNotMatch(modelContext, /CANCELLED_INSTRUCTION/);
    assert.match(modelContext, /NEW_INSTRUCTION/);
  } finally {
    releaseReservation();
    gated.releaseResult(0);
    gated.releaseResult(1);
    if (cancelledPromise) await cancelledPromise.catch(() => undefined);
    if (nextPromise) await nextPromise.catch(() => undefined);
    if (handle) {
      await waitForChildIdle(handle, conversationId);
      await handle.harness.close(handle.context);
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("runDurableTask streams the child conversation snapshot and committed messages", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-events-"));
  const piDir = join(root, ".pi");
  const databasePath = join(root, "durable.sqlite");
  let snapshot: unknown;
  let transcript: DurableTranscript | undefined;
  let clock = 0;
  const events: { type: string }[] = [];
  let handle: Awaited<ReturnType<typeof openDurableHarness>> | undefined;
  try {
    handle = await openDurableHarness(piDir, {
      databasePath,
      models: makeModels(["Visible child answer."]),
    });
    const result = await runDurableTask({
      piDir,
      databasePath,
      taskId: "t-visible-events",
      task: "Say hello.",
      onSnapshot: (value) => {
        snapshot = value;
        transcript = new DurableTranscript(value, () => (clock += 1_000));
      },
      onEvents: (batch) => { events.push(...batch); transcript?.apply(batch); },
    });

    assert.equal(result.answer, "Visible child answer.");
    assert.ok(snapshot, "watch attaches with an initial conversation snapshot");
    assert.ok(events.some((event) => event.type === "message_end"), "committed child messages reach the view");
    assert.ok(events.some((event) => event.type === "run_start"));
    assert.ok(events.some((event) => event.type === "run_end"), "run ends reach the view before watch cleanup");
    const output = Object.values(result.usage.models).reduce((sum, usage) => sum + usage.outputTokens, 0);
    assert.ok(output > 0);
    assert.equal(transcript?.usageMetadata().latestTokensPerSecond, output, "one-second injected run clock yields actual child output TPS");
  } finally {
    if (handle) await handle.harness.close(handle.context);
    rmSync(root, { recursive: true, force: true });
  }
});

/** A provider whose first attempt fails with a transient WebSocket close, then answers. */
function makeTransientFailureModels() {
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "WebSocket closed 1000" }),
    fauxAssistantMessage("Recovered answer."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models };
}

test("durable children follow the parent's retry setting for transient provider errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-retry-setting-"));
  const piDir = join(root, ".pi");
  const databasePath = join(root, "durable.sqlite");
  const { faux, models } = makeTransientFailureModels();
  setDurableRetrySettingsSource(() => ({ enabled: false }));
  try {
    await assert.rejects(
      runDurableTask({ piDir, databasePath, models: () => models, taskId: "t-retry-disabled", task: "Say hello." }),
      /WebSocket closed 1000/,
    );
    assert.equal(faux.state.callCount, 1, "a disabled retry setting must not call the provider again");
  } finally {
    setDurableRetrySettingsSource(() => ({}));
    rmSync(root, { recursive: true, force: true });
  }
});

test("durable children retry transient provider errors by default", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-retry-default-"));
  const piDir = join(root, ".pi");
  const databasePath = join(root, "durable.sqlite");
  const { faux, models } = makeTransientFailureModels();
  try {
    const result = await runDurableTask({ piDir, databasePath, models: () => models, taskId: "t-retry-default", task: "Say hello." });
    assert.equal(result.answer, "Recovered answer.");
    assert.equal(faux.state.callCount, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("durableRetryFromSettings takes only well-typed retry keys from Pi settings", () => {
  assert.deepEqual(durableRetryFromSettings({}), {}, "no retry block leaves pi-durable defaults in place");
  assert.deepEqual(
    durableRetryFromSettings({ retry: { enabled: false, maxRetries: 1, baseDelayMs: 5, maxAgentDelayMs: 9, provider: { maxRetryDelayMs: 60000 } } }),
    { enabled: false, maxRetries: 1, baseDelayMs: 5, maxAgentDelayMs: 9 },
  );
  assert.deepEqual(durableRetryFromSettings({ retry: { enabled: 1, maxRetries: "many", baseDelayMs: -1 } }), {});
});

test("steerDurableTask rejects an idle child without starting untracked work", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-idle-steer-"));
  const piDir = join(root, ".pi");
  const databasePath = join(root, "durable.sqlite");
  let handle: Awaited<ReturnType<typeof openDurableHarness>> | undefined;
  let conversationId: string | undefined;
  try {
    const task = await runDurableTask({
      piDir,
      databasePath,
      taskId: "t-idle-steer",
      task: "Answer once.",
      models: makeModels(["Initial answer."]),
    });
    conversationId = task.conversationId;
    handle = await openDurableHarness(piDir, { databasePath });
    const conversation = await handle.harness.conversation(
      task.conversationId,
      handle.context,
    );
    assert.ok(conversation);
    const before = await conversation.context(handle.context);

    const error = await steerDurableTask(piDir, "t-idle-steer", "Start another run.", {
      databasePath,
    });

    assert.match(error ?? "", /no longer running/i);
    const after = await conversation.context(handle.context);
    assert.deepEqual(after.messages, before.messages, "idle steering must not append a new user input");
  } finally {
    if (handle) {
      await waitForChildIdle(handle, conversationId);
      await handle.harness.close(handle.context);
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("running durable steering settles before the task returns its final answer", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-live-steer-"));
  const piDir = join(root, ".pi");
  const databasePath = join(root, "durable.sqlite");
  const gated = makeGatedModels(["Initial answer.", "Steered answer."]);
  let handle: Awaited<ReturnType<typeof openDurableHarness>> | undefined;
  let conversationId: string | undefined;
  let taskPromise: ReturnType<typeof runDurableTask> | undefined;
  try {
    handle = await openDurableHarness(piDir, {
      databasePath,
      models: () => gated.models,
    });
    taskPromise = runDurableTask({
      piDir,
      databasePath,
      taskId: "t-live-steer",
      task: "Answer the initial question.",
      models: () => gated.models,
      onSubmitted: (id) => { conversationId = id; },
    });
    await gated.firstResultReached;
    assert.equal(
      await steerDurableTask(piDir, "t-live-steer", "Refine the answer.", { databasePath }),
      null,
    );
    const inspection = await handle.harness.inspect(handle.context);
    const steeringSubmission = inspection.submissions.find((submission) =>
      submission.requestId?.startsWith("pi-task:t-live-steer:call:steer-")
    );
    assert.ok(steeringSubmission, "accepted steering has a task-scoped request ID");
    const runState = await handle.harness.snapshot(
      handle.runsDoc,
      Number(conversationId) as never,
      handle.context,
    );
    assert.deepEqual(
      runState?.byRequestId["pi-task:t-live-steer"]?.steeringRequestIds,
      [steeringSubmission.requestId],
    );
    gated.releaseFirstResult();
    await gated.resultReached(1);
    gated.releaseResult(1);

    const result = await taskPromise;
    assert.equal(result.answer, "Steered answer.");
  } finally {
    gated.releaseFirstResult();
    if (taskPromise) await taskPromise.catch(() => undefined);
    if (handle) {
      await waitForChildIdle(handle, conversationId);
      await handle.harness.close(handle.context);
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("a concurrent parent admission cannot erase an in-flight durable reservation", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-concurrent-admission-"));
  const piDir = join(root, ".pi");
  const databasePath = join(root, "durable.sqlite");
  const taskId = "t-concurrent-admission";
  const requestA = durableRequestId(taskId, "call-a");
  const requestB = durableRequestId(taskId, "call-b");
  const gated = makeGatedModels(["First admitted answer.", "Second admitted answer."]);
  let handle: Awaited<ReturnType<typeof openDurableHarness>> | undefined;
  let conversationId: string | undefined;
  let releaseA!: () => void;
  let releaseB!: () => void;
  let reachedA!: () => void;
  let reachedB!: () => void;
  const waitA = new Promise<void>((resolve) => { reachedA = resolve; });
  const waitB = new Promise<void>((resolve) => { reachedB = resolve; });
  const blockA = new Promise<void>((resolve) => { releaseA = resolve; });
  const blockB = new Promise<void>((resolve) => { releaseB = resolve; });
  let firstOutcome: Promise<{ ok: true; result: Awaited<ReturnType<typeof runDurableTask>> } | { ok: false; error: unknown }> | undefined;
  let secondOutcome: typeof firstOutcome;
  try {
    handle = await openDurableHarness(piDir, { databasePath, models: () => gated.models });
    const originalConversation = handle.harness.conversation.bind(handle.harness);
    handle.harness.conversation = async (id, context) => {
      const conversation = await originalConversation(id, context);
      if (!conversation) return conversation;
      const originalSubmit = conversation.submit.bind(conversation);
      conversation.submit = async (submission, submitContext) => {
        if (submission.requestId === requestA) {
          reachedA();
          await blockA;
        } else if (submission.requestId === requestB) {
          reachedB();
          await blockB;
        }
        return originalSubmit(submission, submitContext);
      };
      return conversation;
    };

    const first = runDurableTask({
      piDir,
      databasePath,
      taskId,
      task: "Parent request A.",
      requestId: requestA,
      models: () => gated.models,
      onSubmitted: (id) => { conversationId = id; },
    });
    firstOutcome = first.then(
      (result) => ({ ok: true as const, result }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await waitA;

    const second = runDurableTask({
      piDir,
      databasePath,
      taskId,
      task: "Parent request B.",
      requestId: requestB,
      models: () => gated.models,
      onSubmitted: (id) => { conversationId = id; },
    });
    secondOutcome = second.then(
      (result) => ({ ok: true as const, result }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const secondAdmission = await Promise.race([
      secondOutcome.then((outcome) => ({ type: "settled" as const, outcome })),
      waitB.then(() => ({ type: "submitted" as const })),
    ]);
    releaseA();
    releaseB();
    gated.releaseResult(0);
    gated.releaseResult(1);
    const [outcomeA, outcomeB] = await Promise.all([firstOutcome, secondOutcome]);

    assert.equal(secondAdmission.type, "settled", "a competing parent request is rejected before submission");
    assert.equal(outcomeA.ok, true);
    assert.equal(outcomeB.ok, false);
    if (!outcomeB.ok) assert.match(String(outcomeB.error), /another active request/i);
    assert.ok(conversationId);
    const [admittedA, admittedB] = await Promise.all([
      handle.hasSubmission(Number(conversationId) as never, requestA),
      handle.hasSubmission(Number(conversationId) as never, requestB),
    ]);
    assert.equal(
      Number(admittedA) + Number(admittedB),
      1,
      "only the owner of the reservation may submit an initial request",
    );
  } finally {
    releaseA();
    releaseB();
    gated.releaseResult(0);
    gated.releaseResult(1);
    await firstOutcome?.catch(() => undefined);
    await secondOutcome?.catch(() => undefined);
    if (handle) {
      await waitForChildIdle(handle, conversationId);
      await handle.harness.close(handle.context);
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("durable execution returns the final answer after multiple accepted steering inputs", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-multi-steer-"));
  const piDir = join(root, ".pi");
  const databasePath = join(root, "durable.sqlite");
  const gated = makeGatedModels([
    "Initial answer.",
    "First steering answer.",
    "Second steering answer.",
  ]);
  let handle: Awaited<ReturnType<typeof openDurableHarness>> | undefined;
  let conversationId: string | undefined;
  let taskPromise: ReturnType<typeof runDurableTask> | undefined;
  try {
    handle = await openDurableHarness(piDir, { databasePath, models: () => gated.models });
    taskPromise = runDurableTask({
      piDir,
      databasePath,
      taskId: "t-multi-steer",
      task: "Answer then follow two steering inputs.",
      models: () => gated.models,
      onSubmitted: (id) => { conversationId = id; },
    });
    await gated.resultReached(0);
    assert.equal(
      await steerDurableTask(piDir, "t-multi-steer", "First steering input.", { databasePath }),
      null,
    );
    gated.releaseResult(0);
    await gated.resultReached(1);
    assert.equal(
      await steerDurableTask(piDir, "t-multi-steer", "Second steering input.", { databasePath }),
      null,
    );
    gated.releaseResult(1);
    await gated.resultReached(2);
    gated.releaseResult(2);

    const result = await taskPromise;
    assert.equal(result.answer, "Second steering answer.");
  } finally {
    gated.releaseResult(0);
    gated.releaseResult(1);
    gated.releaseResult(2);
    if (taskPromise) await taskPromise.catch(() => undefined);
    if (handle) {
      await waitForChildIdle(handle, conversationId);
      await handle.harness.close(handle.context);
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed durable steering follow-up fails the parent request", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-steer-failure-"));
  const piDir = join(root, ".pi");
  const databasePath = join(root, "durable.sqlite");
  const permanentFailure = fauxAssistantMessage("", {
    stopReason: "error",
    errorMessage: "permanent follow-up failure",
  });
  const gated = makeGatedModels(["Initial answer.", permanentFailure]);
  let handle: Awaited<ReturnType<typeof openDurableHarness>> | undefined;
  let conversationId: string | undefined;
  let taskPromise: ReturnType<typeof runDurableTask> | undefined;
  try {
    handle = await openDurableHarness(piDir, { databasePath, models: () => gated.models });
    taskPromise = runDurableTask({
      piDir,
      databasePath,
      taskId: "t-steer-failure",
      task: "Answer before steering.",
      models: () => gated.models,
      onSubmitted: (id) => { conversationId = id; },
    });
    await gated.resultReached(0);
    assert.equal(
      await steerDurableTask(piDir, "t-steer-failure", "The successor fails.", { databasePath }),
      null,
    );
    gated.releaseResult(0);
    await gated.resultReached(1);
    gated.releaseResult(1);

    await assert.rejects(taskPromise, /permanent follow-up failure/i);
  } finally {
    gated.releaseResult(0);
    gated.releaseResult(1);
    if (taskPromise) await taskPromise.catch(() => undefined);
    if (handle) {
      await waitForChildIdle(handle, conversationId);
      await handle.harness.close(handle.context);
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("an initial durable failure withdraws steering that cannot be consumed", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-failed-run-queue-"));
  const piDir = join(root, ".pi");
  const databasePath = join(root, "durable.sqlite");
  const permanentFailure = fauxAssistantMessage("", {
    stopReason: "error",
    errorMessage: "permanent initial failure",
  });
  const gated = makeGatedModels([permanentFailure, "This response must not run."]);
  let handle: Awaited<ReturnType<typeof openDurableHarness>> | undefined;
  let conversationId: string | undefined;
  let taskPromise: ReturnType<typeof runDurableTask> | undefined;
  try {
    handle = await openDurableHarness(piDir, { databasePath, models: () => gated.models });
    taskPromise = runDurableTask({
      piDir,
      databasePath,
      taskId: "t-failed-run-queue",
      task: "Fail before the queued steer can run.",
      models: () => gated.models,
      onSubmitted: (id) => { conversationId = id; },
    });
    await gated.resultReached(0);
    assert.equal(
      await steerDurableTask(piDir, "t-failed-run-queue", "This must not be orphaned.", { databasePath }),
      null,
    );
    gated.releaseResult(0);
    await assert.rejects(taskPromise, /permanent initial failure|model_error/i);

    const inspection = await handle.harness.inspect(handle.context);
    assert.equal(
      inspection.submissions.some((submission) => submission.status === "queued"),
      false,
      "failed runs withdraw accepted steering that no active generation can consume",
    );
  } finally {
    gated.releaseResult(0);
    gated.releaseResult(1);
    if (taskPromise) await taskPromise.catch(() => undefined);
    if (handle) {
      await waitForChildIdle(handle, conversationId);
      await handle.harness.close(handle.context);
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart recovery observes steering admitted after its initial discovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-steer-late-recovery-"));
  const piDir = join(root, ".pi");
  const databasePath = join(root, "durable.sqlite");
  const permanentFailure = fauxAssistantMessage("", {
    stopReason: "error",
    errorMessage: "late steering failure",
  });
  const gated = makeGatedModels(["Initial answer.", "First steering answer.", permanentFailure]);
  let handle: Awaited<ReturnType<typeof openDurableHarness>> | undefined;
  let conversationId: string | undefined;
  let taskPromise: ReturnType<typeof runDurableTask> | undefined;
  const recoveredMessages: string[] = [];
  const failureMessages: string[] = [];
  let terminalUsage: { totals?: { totalTokens?: number } } | undefined;
  let recoveryFailureUsage: { totals?: { totalTokens?: number } } | undefined;
  let resolveSettled!: (status: string) => void;
  const recoverySettled = new Promise<string>((resolve) => { resolveSettled = resolve; });
  try {
    handle = await openDurableHarness(piDir, { databasePath, models: () => gated.models });
    taskPromise = runDurableTask({
      piDir,
      databasePath,
      taskId: "t-late-steer-recovery",
      task: "Start the recoverable run.",
      models: () => gated.models,
      onSubmitted: (id) => { conversationId = id; },
      onTerminalUsage: (usage) => { terminalUsage = usage; },
    });
    await gated.resultReached(0);
    assert.equal(
      await steerDurableTask(piDir, "t-late-steer-recovery", "First steering input.", { databasePath }),
      null,
    );
    await resumeDurableTasks(piDir, {
      onRecovered: (_taskId, output) => recoveredMessages.push(output),
      onFailed: (_taskId, reason, usage) => {
        failureMessages.push(reason);
        recoveryFailureUsage = usage;
      },
      onSettled: (_taskId, status) => resolveSettled(status),
    }, { databasePath, models: () => gated.models });
    gated.releaseResult(0);
    await gated.resultReached(1);
    assert.equal(
      await steerDurableTask(piDir, "t-late-steer-recovery", "This successor fails.", { databasePath }),
      null,
      "steering accepted after recovery discovery belongs to the same request lifecycle",
    );
    gated.releaseResult(1);
    await gated.resultReached(2);
    gated.releaseResult(2);
    await taskPromise.catch(() => undefined);
    const status = await Promise.race([
      recoverySettled,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("recovery did not settle")), 5_000).unref();
      }),
    ]);

    assert.equal(status, "failed");
    assert.deepEqual(recoveredMessages, [], "a later steering failure must not deliver a stale success");
    assert.equal(failureMessages.length, 1);
    assert.ok((terminalUsage?.totals.totalTokens ?? 0) > 0, "failed run reports its committed usage ledger");
    assert.ok((recoveryFailureUsage?.totals.totalTokens ?? 0) > 0, "recovery failure reports its committed usage ledger");
    const inspection = await handle.harness.inspect(handle.context);
    assert.equal(inspection.submissions.some((submission) => submission.status === "queued"), false);
  } finally {
    gated.releaseResult(0);
    gated.releaseResult(1);
    gated.releaseResult(2);
    if (taskPromise) await taskPromise.catch(() => undefined);
    if (handle) {
      await waitForChildIdle(handle, conversationId);
      await handle.harness.close(handle.context);
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart recovery treats cancellation of a late steering successor as cancellation", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-late-cancel-recovery-"));
  const piDir = join(root, ".pi");
  const databasePath = join(root, "durable.sqlite");
  const gated = makeGatedModels([
    "Initial answer.",
    "First steering answer.",
    "This cancelled answer must not be used.",
  ]);
  let handle: Awaited<ReturnType<typeof openDurableHarness>> | undefined;
  let conversationId: string | undefined;
  let taskPromise: ReturnType<typeof runDurableTask> | undefined;
  const recoveredMessages: string[] = [];
  const cancelledMessages: string[] = [];
  let terminalUsage: { totals?: { totalTokens?: number } } | undefined;
  let recoveryCancellationUsage: { totals?: { totalTokens?: number } } | undefined;
  let resolveSettled!: (status: string) => void;
  const recoverySettled = new Promise<string>((resolve) => { resolveSettled = resolve; });
  try {
    handle = await openDurableHarness(piDir, { databasePath, models: () => gated.models });
    taskPromise = runDurableTask({
      piDir,
      databasePath,
      taskId: "t-late-steer-cancel",
      task: "Start the cancelable run.",
      models: () => gated.models,
      onSubmitted: (id) => { conversationId = id; },
      onTerminalUsage: (usage) => { terminalUsage = usage; },
    });
    await gated.resultReached(0);
    assert.equal(
      await steerDurableTask(piDir, "t-late-steer-cancel", "First steering input.", { databasePath }),
      null,
    );
    await resumeDurableTasks(piDir, {
      onRecovered: (_taskId, output) => recoveredMessages.push(output),
      onCancelled: (_taskId, reason, usage) => {
        cancelledMessages.push(reason);
        recoveryCancellationUsage = usage;
      },
      onSettled: (_taskId, status) => resolveSettled(status),
    }, { databasePath, models: () => gated.models });

    gated.releaseResult(0);
    await gated.resultReached(1);
    assert.equal(
      await steerDurableTask(piDir, "t-late-steer-cancel", "Cancel during this successor.", { databasePath }),
      null,
    );
    const abortPromise = abortDurableTask(piDir, "t-late-steer-cancel", { databasePath });
    assert.ok(conversationId);
    await waitForAbortRequested(handle, conversationId);
    gated.releaseResult(1);
    await abortPromise;
    await assert.rejects(taskPromise, DurableTaskCancelledError);

    const status = await Promise.race([
      recoverySettled,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("recovery did not settle after cancellation")), 5_000).unref();
      }),
    ]);
    assert.equal(status, "cancelled");
    assert.equal(cancelledMessages.length, 1);
    assert.ok((terminalUsage?.totals.totalTokens ?? 0) > 0, "cancelled run reports its committed usage ledger");
    assert.ok((recoveryCancellationUsage?.totals.totalTokens ?? 0) > 0, "recovery cancellation reports its committed usage ledger");
    assert.deepEqual(recoveredMessages, []);
    const inspection = await handle.harness.inspect(handle.context);
    assert.equal(inspection.submissions.some((submission) => submission.status === "queued"), false);
  } finally {
    gated.releaseResult(0);
    gated.releaseResult(1);
    gated.releaseResult(2);
    if (taskPromise) await taskPromise.catch(() => undefined);
    if (handle) {
      await waitForChildIdle(handle, conversationId);
      await handle.harness.close(handle.context);
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovery promotes an admitted durable request before exposing steering", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-admit-recovery-"));
  const piDir = join(root, ".pi");
  const databasePath = join(root, "durable.sqlite");
  const taskId = "t-admit-recovery";
  const requestId = durableRequestId(taskId);
  const gated = makeGatedModels(["Initial answer.", "Recovered steering answer."]);
  let handle: Awaited<ReturnType<typeof openDurableHarness>> | undefined;
  let conversationId: string | undefined;
  let taskPromise: ReturnType<typeof runDurableTask> | undefined;
  let resolveSettled!: (status: string) => void;
  const settled = new Promise<string>((resolve) => { resolveSettled = resolve; });
  const recoveredMessages: string[] = [];
  try {
    handle = await openDurableHarness(piDir, { databasePath, models: () => gated.models });
    taskPromise = runDurableTask({
      piDir,
      databasePath,
      taskId,
      task: "Start the request before recovering its admission.",
      models: () => gated.models,
      onSubmitted: (id) => { conversationId = id; },
    });
    await gated.resultReached(0);
    assert.ok(conversationId);
    const conversation = await handle.harness.conversation(
      conversationId as never,
      handle.context,
    );
    assert.ok(conversation);
    await conversation.commit(async (tx) => {
      const runs = await tx.doc(handle!.runsDoc, Number(conversationId) as never);
      const record = runs.byRequestId[requestId];
      assert.equal(record?.status, "running");
      runs.byRequestId[requestId] = { taskId, status: "admitting", ownerPid: process.pid };
    }, handle.context);

    await resumeDurableTasks(piDir, {
      onRecovered: (_id, answer) => recoveredMessages.push(answer),
      onSettled: (_id, status) => resolveSettled(status),
    }, { databasePath, models: () => gated.models });
    assert.equal(
      await steerDurableTask(piDir, taskId, "Continue after recovery.", { databasePath }),
      null,
      "recovery makes a submitted admission steerable before waiting for idle",
    );
    gated.releaseResult(0);
    await gated.resultReached(1);
    gated.releaseResult(1);

    const result = await taskPromise;
    const status = await Promise.race([
      settled,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("admission recovery did not settle")), 5_000).unref();
      }),
    ]);
    assert.equal(result.answer, "Recovered steering answer.");
    assert.equal(status, "done");
    assert.deepEqual(recoveredMessages, ["Recovered steering answer."]);
  } finally {
    gated.releaseResult(0);
    gated.releaseResult(1);
    if (taskPromise) await taskPromise.catch(() => undefined);
    if (handle) {
      await waitForChildIdle(handle, conversationId);
      await handle.harness.close(handle.context);
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("durable steering is rejected after cancellation admission", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-cancel-steer-"));
  const piDir = join(root, ".pi");
  const databasePath = join(root, "durable.sqlite");
  const gated = makeGatedModels(["Cancelled response."]);
  const controller = new AbortController();
  let handle: Awaited<ReturnType<typeof openDurableHarness>> | undefined;
  let conversationId: string | undefined;
  let taskPromise: ReturnType<typeof runDurableTask> | undefined;
  try {
    handle = await openDurableHarness(piDir, {
      databasePath,
      models: () => gated.models,
    });
    taskPromise = runDurableTask({
      piDir,
      databasePath,
      taskId: "t-cancel-steer",
      task: "Answer then cancel.",
      models: () => gated.models,
      signal: controller.signal,
      onSubmitted: (id) => { conversationId = id; },
    });
    await gated.firstResultReached;
    assert.ok(conversationId);
    controller.abort();
    await waitForAbortRequested(handle, conversationId);

    const error = await steerDurableTask(piDir, "t-cancel-steer", "Do one more thing.", {
      databasePath,
    });

    assert.match(error ?? "", /no longer running/i);
    gated.releaseFirstResult();
    await assert.rejects(taskPromise, DurableTaskCancelledError);
  } finally {
    gated.releaseFirstResult();
    if (taskPromise) await taskPromise.catch(() => undefined);
    if (handle) {
      await waitForChildIdle(handle, conversationId);
      await handle.harness.close(handle.context);
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart recovery delivers one final answer for a task with queued steering", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-steer-recovery-"));
  const piDir = join(root, ".pi");
  const databasePath = join(root, "durable.sqlite");
  const gated = makeGatedModels(["Initial answer.", "Steered answer."]);
  let handle: Awaited<ReturnType<typeof openDurableHarness>> | undefined;
  let conversationId: string | undefined;
  let taskPromise: ReturnType<typeof runDurableTask> | undefined;
  const recoveredMessages: string[] = [];
  let resolveRecovered!: (message: string) => void;
  const recovered = new Promise<string>((resolve) => { resolveRecovered = resolve; });
  try {
    upsertTaskSessionHistory(piDir, {
      id: "t-steer-recovery",
      status: "running",
      backend: "durable",
      background: true,
      agentType: "general",
      description: "Recover one final answer",
      sessionName: "task-t-steer-recovery",
      startedAt: Date.now(),
      piDir,
      dir: join(piDir, "artifacts"),
      cwd: root,
      ownerSessionId: "sess-steer-recovery",
      durableRequestId: durableRequestId("t-steer-recovery"),
    });
    handle = await openDurableHarness(piDir, {
      databasePath,
      models: () => gated.models,
    });
    taskPromise = runDurableTask({
      piDir,
      databasePath,
      taskId: "t-steer-recovery",
      task: "Answer the initial question.",
      models: () => gated.models,
      onSubmitted: (id) => { conversationId = id; },
    });
    await gated.firstResultReached;
    assert.equal(
      await steerDurableTask(piDir, "t-steer-recovery", "Refine the answer.", { databasePath }),
      null,
    );
    const recoveredTaskIds = await resumeDurableAfterRestart({
      piDir,
      databasePath,
      sessionId: "sess-steer-recovery",
      pi: {
        sendMessage: (message: { content: string }) => {
          recoveredMessages.push(message.content);
          resolveRecovered(message.content);
        },
      } as never,
    });
    assert.ok(recoveredTaskIds.has("t-steer-recovery"));
    gated.releaseFirstResult();
    await gated.resultReached(1);
    gated.releaseResult(1);

    const taskResult = await taskPromise;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const recoveryMessage = await Promise.race([
      recovered,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("durable recovery did not deliver")), 5_000);
      }),
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
    assert.equal(taskResult.answer, "Steered answer.");
    assert.match(recoveryMessage, /Steered answer/);
    assert.equal(recoveredMessages.length, 1, "one task produces one recovery delivery");
    const repeatedRecoveryIds = await resumeDurableAfterRestart({
      piDir,
      databasePath,
      sessionId: "sess-steer-recovery",
      pi: {
        sendMessage: (message: { content: string }) => recoveredMessages.push(message.content),
      } as never,
    });
    assert.equal(repeatedRecoveryIds.size, 0, "settled history suppresses duplicate recovery delivery");
    assert.equal(recoveredMessages.length, 1);
  } finally {
    gated.releaseFirstResult();
    if (taskPromise) await taskPromise.catch(() => undefined);
    if (handle) {
      await waitForChildIdle(handle, conversationId);
      await handle.harness.close(handle.context);
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("durable tool policy is isolated per child and retained on task resume", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-tool-policy-"));
  const piDir = join(root, ".pi");
  const databasePath = join(root, "durable.sqlite");
  const models = makeModels([
    "Read-only.",
    "Restricted.",
    "Default tools.",
    "Resumed.",
    "Readonly drops unbridgeable.",
    "Fail open.",
    "Bridged tools.",
    "Reviewer profile.",
  ]);
  let handle: Awaited<ReturnType<typeof openDurableHarness>> | undefined;
  try {
    const readonlyResult = await runDurableTask({
      piDir,
      databasePath,
      taskId: "t-policy-readonly",
      task: "Run with the readonly agent policy.",
      models,
      readonly: true,
    });
    const restrictedResult = await runDurableTask({
      piDir,
      databasePath,
      taskId: "t-policy-disallowed",
      task: "Run with a disallowed tool.",
      models,
      tools: ["read", "bash"],
      disallowedTools: ["bash"],
    });
    const defaultResult = await runDurableTask({
      piDir,
      databasePath,
      taskId: "t-policy-default",
      task: "Preserve the existing default tool surface.",
      models,
    });
    const resumedResult = await runDurableTask({
      piDir,
      databasePath,
      taskId: "t-policy-disallowed",
      requestId: "pi-task:t-policy-disallowed:call:resume",
      task: "Continue with the same policy.",
      models,
      tools: ["read", "bash"],
      disallowedTools: ["bash"],
    });

    await assert.rejects(
      runDurableTask({
        piDir,
        databasePath,
        taskId: "t-policy-readonly-invalid",
        task: "Reject a mutating explicit tool on a readonly agent.",
        models,
        tools: ["read", "write"],
        readonly: true,
      }),
      /readonly: true but tools requests mutating durable tool: write/i,
    );

    // Readonly drops unbridgeable names instead of failing the admission:
    // containment comes from the deny list, so an unverifiable name can never
    // reach the child. This is the user reviewer profile's durable behavior
    // (codemode/peer dropped, bash kept per the README readonly contract).
    const reviewerProfile = await runDurableTask({
      piDir,
      databasePath,
      taskId: "t-policy-readonly-unsupported",
      task: "A readonly agent with extension-only tools still runs.",
      models,
      tools: ["read", "grep", "find", "bash", "codemode", "peer"],
      readonly: true,
    });
    // Without readonly, an unbridgeable extension tool fails open: the run is
    // admitted and the name is dropped from the child surface (pre-1.0.4
    // behavior for agents carrying their own extension tools).
    const failOpenResult = await runDurableTask({
      piDir,
      databasePath,
      taskId: "t-policy-unsupported",
      task: "An unsupported non-readonly tool is dropped, not fatal.",
      models,
      tools: ["read", "codemode"],
    });
    handle = await openDurableHarness(piDir, { databasePath });
    const toolNames = async (conversationId: string) => {
      const conversation = await handle!.harness.conversation(
        conversationId as never,
        handle!.context,
      );
      assert.ok(conversation);
      return (await conversation.agent(handle!.context)).tools.map((tool) => tool.name);
    };
    // Readonly default surface: the CodingTools four minus write/edit — bash
    // stays, matching the documented CLI readonly contract.
    assert.deepEqual(await toolNames(readonlyResult.conversationId), ["read", "bash"]);
    assert.deepEqual(await toolNames(restrictedResult.conversationId), ["read"]);
    assert.deepEqual(await toolNames(defaultResult.conversationId), ["read", "write", "edit", "bash"]);
    assert.equal(resumedResult.conversationId, restrictedResult.conversationId);
    assert.deepEqual(await toolNames(resumedResult.conversationId), ["read"]);
    // The reviewer profile keeps bash and the bridged read-only trio; only
    // codemode/peer (unhostable) are dropped.
    assert.deepEqual(await toolNames(reviewerProfile.conversationId), ["read", "grep", "find", "bash"]);
    // The bridged read-only trio resolves as real tools when requested.
    const bridgedResult = await runDurableTask({
      piDir,
      databasePath,
      taskId: "t-policy-bridged",
      task: "Resolve bridged read-only parent tools.",
      models,
      tools: ["read", "grep", "find", "ls"],
    });
    assert.deepEqual(await toolNames(bridgedResult.conversationId), ["read", "grep", "find", "ls"]);
    // Fail-open: the unsupported name is dropped while the rest survive.
    const failOpenNames = await toolNames(failOpenResult.conversationId);
    assert.equal(failOpenNames.includes("codemode"), false, "unbridgeable names stay dropped");
    assert.deepEqual(
      [...failOpenNames].sort(),
      [...failOpenNames].filter((name) => name !== "codemode").sort(),
      "only unbridgeable names are dropped",
    );
    const registryNames = handle.toolRegistrations.map((tool) => tool.name);
    for (const bridged of ["grep", "find", "ls"]) {
      assert.ok(registryNames.includes(bridged), `bridge installs ${bridged}`);
    }

    await assert.rejects(
      runDurableTask({
        piDir,
        databasePath,
        taskId: "t-policy-readonly-invalid",
        task: "Reject a mutating explicit tool on a readonly agent.",
        models,
        tools: ["read", "write"],
        readonly: true,
      }),
      /readonly: true but tools requests mutating durable tool: write/i,
    );
    const children = await handle.harness.snapshot(handle.children, handle.context);
    assert.equal(children?.byOwner["pi-task:t-policy-readonly-invalid"], undefined);
  } finally {
    if (handle) await handle.harness.close(handle.context);
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy durable results can reconstruct usage from the committed ledger", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-legacy-usage-"));
  const piDir = join(root, ".pi");
  const databasePath = join(root, "durable.sqlite");
  let handle: Awaited<ReturnType<typeof openDurableHarness>> | undefined;
  try {
    const first = await runDurableTask({
      piDir,
      databasePath,
      taskId: "t-legacy-usage",
      task: "Create a durable result with usage.",
      models: makeModels(["A result with no persisted usage snapshot."]),
    });
    handle = await openDurableHarness(piDir, { databasePath });
    const conversation = await handle.harness.conversation(
      first.conversationId as never,
      handle.context,
    );
    assert.ok(conversation);
    await conversation.commit(async (tx) => {
      const runs = await tx.doc(handle!.runsDoc, Number(first.conversationId) as never);
      const record = runs.byRequestId[durableRequestId("t-legacy-usage")];
      assert.equal(record?.status, "done");
      if (record?.status === "done") delete record.usageJson;
    }, handle.context);

    const replay = await runDurableTask({
      piDir,
      databasePath,
      taskId: "t-legacy-usage",
      task: "Create a durable result with usage.",
    });
    assert.equal(replay.answer, first.answer);
    assert.equal(typeof replay.usage.totals.totalTokens, "number");
  } finally {
    if (handle) await handle.harness.close(handle.context);
    rmSync(root, { recursive: true, force: true });
  }
});

test("runDurableTask answers, reuses the child on rerun, rejects idle steering, and aborts", () => {
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
        models: makeModels(["Magic words.", "Follow-up answer.", "Second task answer."]),
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

      // A new Pi tool-call id resumes the same child conversation with a
      // distinct durable submission, while replay of the same call is stable.
      const resumed = await runDurableTask({
        piDir,
        taskId: "t1",
        task: "Continue with the second concern.",
        requestId: "pi-task:t1:call:call-2",
        databasePath,
      });
      assert.equal(resumed.conversationId, first.conversationId);
      assert.equal(resumed.answer, "Follow-up answer.");
      const replayedResume = await runDurableTask({
        piDir,
        taskId: "t1",
        task: "Continue with the second concern.",
        requestId: "pi-task:t1:call:call-2",
        databasePath,
      });
      assert.equal(replayedResume.answer, "Follow-up answer.");
      const replayedFirst = await runDurableTask({
        piDir,
        taskId: "t1",
        task: "Say the magic words.",
        databasePath,
      });
      assert.equal(
        replayedFirst.answer,
        "Magic words.",
        "replaying an older request returns its own answer, not a later conversation response",
      );
      assert.deepEqual(replayedFirst.usage, first.usage, "replay retains that request's usage snapshot");

      // A second task id gets its own child conversation.
      const second = await runDurableTask({
        piDir,
        taskId: "t2",
        task: "Different task.",
        databasePath,
      });
      assert.notEqual(second.conversationId, first.conversationId);
      assert.equal(second.answer, "Second task answer.");

      // A settled task cannot be steered into an untracked successor run.
      assert.match(
        (await steerDurableTask(piDir, "t2", "Check the logs first.", { databasePath })) ?? "",
        /no longer running/i,
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

test("a no-model admission failure does not leave a mapped child that can poison later control", async () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-durable-no-model-child-"));
  const models = createModels();
  models.getAllModels = () => [];
  models.getModel = () => undefined;
  const modelFactory = () => models;
  let handle: Awaited<ReturnType<typeof openDurableHarness>> | undefined;
  try {
    await assert.rejects(
      runDurableTask({
        piDir,
        taskId: "no-model-child",
        task: "This cannot be admitted without a model.",
        models: modelFactory,
      }),
      /No model available for durable subagent execution/,
    );
    handle = await openDurableHarness(piDir, { models: modelFactory });
    const children = await handle.harness.snapshot(handle.children, handle.context);
    assert.equal(
      children?.byOwner["pi-task:no-model-child"],
      undefined,
      "a failed no-model attempt must not persist an owner mapping for an unusable conversation",
    );
    assert.match(
      (await steerDurableTask(piDir, "no-model-child", "Follow up.")) ?? "",
      /No durable child conversation/,
      "control cannot target an orphaned conversation after no_model",
    );
  } finally {
    if (handle) await handle.harness.close(handle.context);
    rmSync(piDir, { recursive: true, force: true });
  }
});

test("a resumed durable run without a measurement does not keep the previous run's TPS", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-stale-tps-"));
  const piDir = join(root, ".pi");
  try {
    upsertTaskSessionHistory(piDir, {
      id: "t-stale-tps", agentType: "general", description: "resume", sessionName: "task-t-stale-tps",
      startedAt: 1, piDir, dir: join(piDir, "artifacts"), cwd: root, backend: "durable",
      status: "done", background: false, tokensPerSecond: 99,
    } as never);
    await executeDurableTask({
      id: "t-stale-tps",
      agent: { name: "general", description: "General task", body: "", source: "project", path: "test-agent.md" },
      description: "resume", sessionName: "task-t-stale-tps", prompt: "Return.", cwd: root,
      toolCallId: "call-stale-tps", ctx: { modelRegistry: {} } as never, pi: {} as never,
      piDir, artifactsDir: join(piDir, "artifacts"), isBackground: false,
      backgroundTasks: new Map(), foregroundTasks: new Map(), deliveryGuard: new DeliveryGuard(),
      taskWidget: { openTaskView() {}, closeTaskView() {}, noteTaskFinished() {}, setLiveTranscript() {} } as never,
      clearTaskWidgetIfIdle: () => {}, ensureTaskWidget: () => {}, enqueueDelivery: (delivery) => delivery(),
      runTask: async () => ({
        conversationId: "stale-tps-child",
        answer: "Status: success\\nDone.",
        usage: { models: {}, tools: {}, totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costTotal: 0 } },
      }),
    });
    assert.equal(
      readTaskSessionHistory(piDir).find((entry) => entry.id === "t-stale-tps")?.tokensPerSecond,
      undefined,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("foreground durable work registers and opens its task view until the result is ready", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-foreground-view-"));
  const foregroundTasks = new Map<string, import("../src/types.js").BackgroundTask>();
  let openedTaskId: string | undefined;
  let closedTaskId: string | undefined;
  let submittedRequestId: string | undefined;
  let registeredWhileRunning = false;
  let attributedBeforeSettlement = false;
  let finishedTask: import("../src/types.js").BackgroundTask | undefined;
  const liveTranscriptUpdates: (readonly { type: string; text?: string }[])[] = [];
  try {
    const result = await executeDurableTask({
      id: "t-foreground-view",
      agent: {
        name: "general",
        description: "General task",
        body: "",
        source: "project",
        path: "test-agent.md",
      },
      description: "Inspect task view",
      sessionName: "task-t-foreground-view",
      prompt: "Return a short result.",
      cwd: root,
      toolCallId: "call-foreground-view",
      ctx: { modelRegistry: {} } as never,
      pi: {} as never,
      piDir: join(root, ".pi"),
      artifactsDir: join(root, ".pi", "artifacts"),
      isBackground: false,
      backgroundTasks: new Map(),
      foregroundTasks,
      deliveryGuard: new DeliveryGuard(),
      taskWidget: {
        openTaskView: (taskId: string) => { openedTaskId = taskId; },
        closeTaskView: (taskId: string) => { closedTaskId = taskId; },
        noteTaskFinished: (_taskId: string, task: import("../src/types.js").BackgroundTask) => {
          finishedTask = task;
        },
        setLiveTranscript: (_taskId: string, items: readonly { type: string; text?: string }[]) => {
          liveTranscriptUpdates.push([...items]);
        },
      } as never,
      clearTaskWidgetIfIdle: () => {},
      ensureTaskWidget: () => {},
      enqueueDelivery: (delivery) => delivery(),
      runTask: async (input) => {
        submittedRequestId = input.requestId;
        registeredWhileRunning = foregroundTasks.has("t-foreground-view");
        input.onSubmitted?.("durable-foreground-child");
        attributedBeforeSettlement = readTaskSessionHistory(join(root, ".pi")).find(
          (entry) => entry.id === "t-foreground-view",
        )?.conversationId === "durable-foreground-child";
        input.onSnapshot?.({
          type: "snapshot",
          entries: [],
          tools: [],
          compactions: [],
          inbox: [],
          agent: {},
          usage: { models: {}, tools: {}, totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costTotal: 0 } },
        } as never);
        input.onEvents?.([{ type: "run_start", inputs: [1] } as never]);
        await new Promise((resolve) => setTimeout(resolve, 5));
        input.onEvents?.([{
          type: "message_end",
          entry: {
            id: 1,
            conversationId: 1,
            kind: "pi.assistant",
            model: [{
              role: "assistant",
              content: [
                { type: "text", text: "Live child progress." },
                { type: "toolCall", id: "call-no-start", name: "read", arguments: {} },
              ],
              usage: { input: 1, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 51 },
              timestamp: 0,
            }],
          },
        } as never, {
          type: "message_end",
          entry: {
            id: 2,
            conversationId: 1,
            kind: "pi.toolResult",
            model: [{ role: "toolResult", toolCallId: "call-no-start", toolName: "read", content: [], isError: false }],
          },
        } as never, { type: "run_end", inputs: [1] } as never]);
        return {
          conversationId: "durable-foreground-child",
          answer: "Status: success\\nThe task view stayed active.",
          usage: { models: {}, tools: {}, totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costTotal: 0 } },
        };
      },
    });

    assert.equal(registeredWhileRunning, true, "foreground task is available to the panel while running");
    assert.equal(openedTaskId, "t-foreground-view", "foreground task view opens before waiting");
    assert.equal(closedTaskId, "t-foreground-view", "the task view closes when the synchronous call settles");
    assert.equal(foregroundTasks.has("t-foreground-view"), false, "active row is removed after settlement");
    assert.equal(submittedRequestId, "pi-task:t-foreground-view:call:call-foreground-view");
    assert.equal(attributedBeforeSettlement, true, "submission admission immediately persists the child conversation identity");
    assert.equal(finishedTask?.status, "done", "finished task is retained with its outcome");
    assert.equal(finishedTask?.backend, "durable");
    assert.equal(finishedTask?.toolUses, 1, "live tool-call events update the foreground activity count");
    assert.ok(
      liveTranscriptUpdates.some((items) => items.some((item) => item.type === "assistant" && item.text === "Live child progress.")),
      "durable child messages reach the task transcript",
    );
    assert.equal(result.details.phase, "done");
    assert.equal(result.details.tool_uses, 1, "result usage count includes calls without execution-start events");
    const foregroundHistory = readTaskSessionHistory(join(root, ".pi")).find(
      (entry) => entry.id === "t-foreground-view",
    );
    assert.equal(foregroundHistory?.backend, "durable", "foreground task history preserves backend identity");
    assert.ok(
      (foregroundHistory?.tokensPerSecond ?? 0) > 0,
      "the observed run's TPS survives settlement so persisted read-only history can show it",
    );
    assert.equal(
      foregroundHistory?.conversationId,
      "durable-foreground-child",
      "the durable conversation attribution survives the terminal history upsert",
    );
    assert.equal(
      foregroundHistory?.durableRequestId,
      "pi-task:t-foreground-view:call:call-foreground-view",
      "foreground history records the exact submission identity before admission",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("foreground durable cancellation propagates its signal and settles as cancelled", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-foreground-cancel-"));
  const parentAbortController = new AbortController();
  const foregroundTasks = new Map<string, import("../src/types.js").BackgroundTask>();
  let observedSignal: AbortSignal | undefined;
  let finishedTask: import("../src/types.js").BackgroundTask | undefined;
  try {
    const result = await executeDurableTask({
      id: "t-foreground-cancel",
      agent: {
        name: "general",
        description: "General task",
        body: "",
        source: "project",
        path: "test-agent.md",
      },
      description: "Cancel foreground work",
      sessionName: "task-t-foreground-cancel",
      prompt: "Wait for cancellation.",
      cwd: root,
      ctx: { modelRegistry: {} } as never,
      pi: {} as never,
      piDir: join(root, ".pi"),
      artifactsDir: join(root, ".pi", "artifacts"),
      signal: parentAbortController.signal,
      isBackground: false,
      backgroundTasks: new Map(),
      foregroundTasks,
      deliveryGuard: new DeliveryGuard(),
      taskWidget: {
        openTaskView: () => {},
        closeTaskView: () => {},
        noteTaskFinished: (_taskId: string, task: import("../src/types.js").BackgroundTask) => {
          finishedTask = task;
        },
      } as never,
      clearTaskWidgetIfIdle: () => {},
      ensureTaskWidget: () => {},
      enqueueDelivery: (delivery) => delivery(),
      runTask: async (input) => {
        observedSignal = input.signal;
        parentAbortController.abort();
        assert.equal(input.signal?.aborted, true, "the runner receives the parent cancellation");
        throw new DurableTaskCancelledError();
      },
    });

    assert.notEqual(observedSignal, parentAbortController.signal, "the runner uses its own control signal");
    assert.equal(result.details.phase, "cancelled");
    assert.equal(result.details.execution_phase, "cancelled");
    assert.equal(result.details.backend, "durable");
    assert.equal(result.isError, undefined, "cancellation is not reported as an execution failure");
    assert.equal(finishedTask?.status, "cancelled");
    assert.equal(foregroundTasks.has("t-foreground-cancel"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("panel stop latches durable cancellation before submission admission", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-panel-admission-cancel-"));
  const piDir = join(root, ".pi");
  const databasePath = join(piDir, "durable", "tasks.sqlite");
  const taskId = "t-panel-admission-cancel";
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  let modelStarted = false;
  faux.setResponses([() => {
    modelStarted = true;
    return fauxAssistantMessage("The panel stop must preempt submission.");
  }]);
  const foregroundTasks = new Map<string, import("../src/types.js").BackgroundTask>();
  let editorFactory: ((tui: unknown, theme: unknown, keybindings: unknown) => {
    handleInput(data: string): void;
  }) | undefined;
  let directAbortCalls = 0;
  let submissionAdmitted = false;
  let handle: Awaited<ReturnType<typeof openDurableHarness>> | undefined;
  const taskWidget = createTaskWidgetController(foregroundTasks, new Map(), {
    steerTask: () => null,
    stopTask: async (id) => {
      directAbortCalls++;
      return abortDurableTask(piDir, id, { databasePath });
    },
  });
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd: root,
    modelRegistry: undefined,
    sessionManager: {
      getSessionId: () => "session-panel-cancel",
      getLeafId: () => null,
      getBranch: () => [],
    },
    ui: {
      getEditorComponent: () => undefined,
      setEditorComponent: (factory: unknown) => {
        editorFactory = factory as typeof editorFactory;
      },
      setWidget: () => {},
      notify: () => {},
    },
  } as never;

  try {
    handle = await openDurableHarness(piDir, { databasePath, models: () => models });
    const result = await executeDurableTask({
      id: taskId,
      agent: {
        name: "general",
        description: "General task",
        body: "",
        source: "project",
        path: "test-agent.md",
      },
      description: "Cancel from panel before admission",
      sessionName: `task-${taskId}`,
      prompt: "Do not run after panel cancellation.",
      cwd: root,
      ctx,
      pi: { sendMessage: () => {} } as never,
      piDir,
      artifactsDir: join(piDir, "artifacts"),
      isBackground: false,
      backgroundTasks: new Map(),
      foregroundTasks,
      deliveryGuard: new DeliveryGuard(),
      taskWidget,
      clearTaskWidgetIfIdle: taskWidget.clearTaskWidgetIfIdle,
      ensureTaskWidget: () => taskWidget.ensureTaskWidget(ctx),
      enqueueDelivery: (delivery) => delivery(),
      runTask: (input) => {
        const editor = editorFactory?.({}, {}, {});
        assert.ok(editor, "the panel editor is installed before the durable runner starts");
        return runDurableTask({
          ...input,
          databasePath,
          models: () => models,
          onSnapshot: (snapshot) => {
            input.onSnapshot?.(snapshot);
            editor.handleInput("\x1b[B");
            editor.handleInput("\x1b[B");
            editor.handleInput("x");
          },
          onSubmitted: (conversationId) => {
            submissionAdmitted = true;
            input.onSubmitted?.(conversationId);
          },
        });
      },
    });

    assert.equal(result.details.phase, "cancelled");
    assert.equal(submissionAdmitted, false, "panel stop prevents durable input admission");
    assert.equal(modelStarted, false, "panel stop prevents provider execution");
    assert.equal(directAbortCalls, 0, "the active panel row aborts the runner latch, not an idle child");
  } finally {
    taskWidget.dispose();
    if (handle) await handle.harness.close(handle.context);
    rmSync(root, { recursive: true, force: true });
  }
});

test("foreground task control latches cancellation before durable submission admission", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-admission-cancel-"));
  const piDir = join(root, ".pi");
  const databasePath = join(piDir, "durable", "tasks.sqlite");
  const taskId = "t-admission-cancel";
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  let modelStarted = false;
  faux.setResponses([() => {
    modelStarted = true;
    return fauxAssistantMessage("This submission must not be admitted.");
  }]);
  const foregroundTasks = new Map<string, import("../src/types.js").BackgroundTask>();
  let cancelPromise: ReturnType<typeof handleTaskControl> | undefined;
  let submissionAdmitted = false;
  let directAbortCalls = 0;
  let completeTaskCalls = 0;
  let handle: Awaited<ReturnType<typeof openDurableHarness>> | undefined;

  try {
    handle = await openDurableHarness(piDir, { databasePath, models: () => models });
    const result = await executeDurableTask({
      id: taskId,
      agent: {
        name: "general",
        description: "General task",
        body: "",
        source: "project",
        path: "test-agent.md",
      },
      description: "Cancel before durable admission",
      sessionName: `task-${taskId}`,
      prompt: "Do not run after cancellation.",
      cwd: root,
      ctx: {} as never,
      pi: {} as never,
      piDir,
      artifactsDir: join(piDir, "artifacts"),
      isBackground: false,
      backgroundTasks: new Map(),
      foregroundTasks,
      deliveryGuard: new DeliveryGuard(),
      taskWidget: {
        openTaskView: () => {},
        closeTaskView: () => {},
        noteTaskFinished: () => {},
        setLiveTranscript: () => {},
      } as never,
      clearTaskWidgetIfIdle: () => {},
      ensureTaskWidget: () => {},
      enqueueDelivery: (delivery) => delivery(),
      runTask: (input) => runDurableTask({
        ...input,
        databasePath,
        models: () => models,
        onSnapshot: (snapshot) => {
          input.onSnapshot?.(snapshot);
          cancelPromise = handleTaskControl(
            { operation: "cancel", taskId },
            {
              pi: {} as never,
              piDir,
              backgroundTasks: new Map(),
              foregroundTasks,
              registryEntryStatus: () => "missing",
              clearTaskWidgetIfIdle: () => {},
              completeTask: () => {
                completeTaskCalls++;
                return { cleanupSucceeded: true };
              },
              abortDurable: async (id) => {
                directAbortCalls++;
                return abortDurableTask(piDir, id, { databasePath });
              },
            },
          );
        },
        onSubmitted: (conversationId) => {
          submissionAdmitted = true;
          input.onSubmitted?.(conversationId);
        },
      }),
    });

    assert.ok(cancelPromise, "task control runs while the child is still idle");
    const cancelResult = await cancelPromise;
    assert.equal(cancelResult.details.status, "cancelled");
    assert.equal(result.details.phase, "cancelled");
    assert.equal(submissionAdmitted, false, "cancelled work is rejected before submit");
    assert.equal(modelStarted, false, "the provider is not invoked after an idle-child abort");
    assert.equal(directAbortCalls, 0, "the active runner's latch replaces a racy idle-child abort");
    assert.equal(completeTaskCalls, 0, "the active runner owns cancellation settlement");
    assert.equal(
      readTaskSessionHistory(piDir).find((entry) => entry.id === taskId)?.status,
      "cancelled",
    );
  } finally {
    if (handle) await handle.harness.close(handle.context);
    rmSync(root, { recursive: true, force: true });
  }
});

for (const outcome of ["done", "failed"] as const) {
  test(`durable background ${outcome} history preserves the admitted conversation id`, async () => {
    const root = mkdtempSync(join(tmpdir(), `pi-task-durable-history-attribution-${outcome}-`));
    const piDir = join(root, ".pi");
    const taskId = `t-history-attribution-${outcome}`;
    const models = createModels();
    const faux = fauxProvider({ models: [{ id: "faux-1" }] });
    models.setProvider(faux.provider);
    faux.setResponses([outcome === "done"
      ? fauxAssistantMessage("<status>success</status>\n<summary>Finished.</summary>")
      : fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "synthetic durable failure",
        })]);
    const modelFactory = () => models;
    let admittedConversationId: string | undefined;
    let attributedAtAdmission = false;
    let handle: Awaited<ReturnType<typeof openDurableHarness>> | undefined;
    try {
      handle = await openDurableHarness(piDir, { models: modelFactory });
      await executeDurableTask({
        id: taskId,
        agent: {
          name: "general",
          description: "General task",
          body: "",
          source: "project",
          path: "test-agent.md",
        },
        description: "Preserve durable history attribution",
        sessionName: `task-${taskId}`,
        prompt: "Finish the task.",
        cwd: root,
        ctx: { modelRegistry: {} } as never,
        pi: { sendMessage: () => {} } as never,
        piDir,
        artifactsDir: join(piDir, "artifacts"),
        isBackground: true,
        backgroundTasks: new Map(),
        foregroundTasks: new Map(),
        deliveryGuard: new DeliveryGuard(),
        taskWidget: { noteTaskFinished: () => {}, setLiveTranscript: () => {} } as never,
        clearTaskWidgetIfIdle: () => {},
        ensureTaskWidget: () => {},
        enqueueDelivery: (delivery) => delivery(),
        runTask: (input) => runDurableTask({
          ...input,
          models: modelFactory,
          onSubmitted: (conversationId) => {
            admittedConversationId = conversationId;
            input.onSubmitted?.(conversationId);
            attributedAtAdmission = readTaskSessionHistory(piDir).find(
              (entry) => entry.id === taskId,
            )?.conversationId === conversationId;
          },
        }),
      });

      const terminalStatus = outcome === "done" ? "done" : "failed";
      let history = readTaskSessionHistory(piDir).find((entry) => entry.id === taskId);
      for (let waited = 0; waited < 2_000 && history?.status !== terminalStatus; waited += 10) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        history = readTaskSessionHistory(piDir).find((entry) => entry.id === taskId);
      }
      assert.equal(attributedAtAdmission, true, "admission persists the known durable child identity");
      assert.ok(admittedConversationId, "the durable child was admitted");
      assert.equal(history?.status, terminalStatus, "the detached lifecycle settled as requested");
      assert.equal(
        history?.conversationId,
        admittedConversationId,
        `${terminalStatus} history keeps the durable child identity written at admission`,
      );
    } finally {
      if (handle) await handle.harness.close(handle.context);
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("durable background completion receipt carries its usage ledger", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-receipt-"));
  const sent: { details?: Record<string, unknown> }[] = [];
  let queuedDeliveryId: string | undefined;
  const modelRegistry = {} as never;
  const parentAbortController = new AbortController();
  let releaseRunner!: () => void;
  const runnerGate = new Promise<void>((resolve) => { releaseRunner = resolve; });
  let runInput: Parameters<typeof runDurableTask>[0] | undefined;
  let openedTaskViews = 0;
  const liveTranscriptUpdates: (readonly { type: string; name?: string }[])[] = [];
  const usage = {
    models: {},
    tools: {},
    totals: { inputTokens: 11, outputTokens: 4, totalTokens: 15, costTotal: 0.25 },
  };
  try {
    await executeDurableTask({
      id: "t-background-usage",
      agent: {
        name: "general",
        description: "General task",
        body: "",
        source: "project",
        path: "test-agent.md",
        tools: ["read", "bash"],
        disallowedTools: ["bash"],
        readonly: true,
      },
      description: "Check usage receipt",
      sessionName: "task-t-background-usage",
      prompt: "Return a short result.",
      cwd: root,
      ctx: {
        model: { provider: "faux", id: "vendor/model" },
        modelRegistry,
      } as never,
      pi: {
        sendMessage: (message: { details?: Record<string, unknown> }) => {
          sent.push(message);
        },
      } as never,
      piDir: join(root, ".pi"),
      artifactsDir: join(root, ".pi", "artifacts"),
      signal: parentAbortController.signal,
      isBackground: true,
      backgroundTasks: new Map(),
      foregroundTasks: new Map(),
      deliveryGuard: new DeliveryGuard(),
      taskWidget: {
        noteTaskFinished: () => {},
        openTaskView: () => { openedTaskViews++; },
        setLiveTranscript: (_taskId: string, items: readonly { type: string; name?: string }[]) => {
          liveTranscriptUpdates.push([...items]);
        },
      } as never,
      clearTaskWidgetIfIdle: () => {},
      ensureTaskWidget: () => {},
      enqueueDelivery: (delivery, deliveryId) => {
        queuedDeliveryId = deliveryId;
        delivery();
      },
      runTask: async (input) => {
        runInput = input;
        input.onSnapshot?.({
          type: "snapshot",
          entries: [],
          tools: [],
          compactions: [],
          inbox: [],
          agent: {},
          usage: { models: {}, tools: {}, totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costTotal: 0 } },
        } as never);
        input.onEvents?.([{
          type: "tool_execution_start",
          toolCallId: "call-background-read",
          toolName: "read",
          args: { path: "README.md" },
        } as never]);
        await runnerGate;
        if (input.signal?.aborted) throw new DurableTaskCancelledError();
        return {
          conversationId: "durable-child-usage",
          answer: "<status>success</status>\n<summary>Finished.</summary>",
          usage,
        };
      },
    });

    for (let waited = 0; waited < 2_000 && runInput === undefined; waited += 10) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(runInput, "the detached runner starts independently of the parent tool call");
    parentAbortController.abort();
    releaseRunner();
    for (let waited = 0; waited < 2_000 && sent.length === 0; waited += 10) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(sent.length, 1, "background task sends one completion receipt");
    assert.equal(openedTaskViews, 0, "background progress does not take over the parent view");
    assert.ok(
      liveTranscriptUpdates.some((items) => items.some((item) => item.type === "tool" && item.name === "read")),
      "background child events still update its task view transcript",
    );
    assert.deepEqual(sent[0]?.details?.usage, usage);
    assert.equal(sent[0]?.details?.completion_delivery_id, queuedDeliveryId);
    const backgroundHistory = readTaskSessionHistory(join(root, ".pi")).find(
      (entry) => entry.id === "t-background-usage",
    );
    assert.equal(
      backgroundHistory?.durableRequestId,
      "pi-task:t-background-usage",
      "background history records its exact submission identity before admission",
    );
    assert.equal(backgroundHistory?.ownerPid, process.pid, "background history records its owning process");
    assert.equal(sent[0]?.details?.phase, "done", "parent cancellation does not abort detached work");
    assert.equal(parentAbortController.signal.aborted, true);
    assert.notEqual(runInput?.signal, parentAbortController.signal);
    assert.equal(runInput?.signal?.aborted, false);
    assert.equal(runInput?.model, undefined);
    assert.deepEqual(runInput?.sessionModel, {
      provider: "faux",
      modelId: "vendor/model",
    });
    assert.equal(runInput?.modelRegistry, modelRegistry);
    assert.deepEqual(runInput?.tools, ["read", "bash"]);
    assert.deepEqual(runInput?.disallowedTools, ["bash"]);
    assert.equal(runInput?.readonly, true);
  } finally {
    releaseRunner();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const isBackground of [false, true] as const) {
  for (const outcome of ["failed", "cancelled"] as const) {
    test(`durable ${isBackground ? "background" : "foreground"} ${outcome} receipt includes available usage`, async () => {
      const root = mkdtempSync(join(tmpdir(), `pi-task-durable-${outcome}-usage-`));
      const sent: { details?: Record<string, unknown> }[] = [];
      const usage = {
        models: {},
        tools: {},
        totals: { inputTokens: 7, outputTokens: 3, totalTokens: 10, costTotal: 0.12 },
      };
      try {
        const result = await executeDurableTask({
          id: `t-${outcome}-usage-${isBackground ? "background" : "foreground"}`,
          agent: {
            name: "general",
            description: "General task",
            body: "",
            source: "project",
            path: "test-agent.md",
          },
          description: "Usage receipt regression",
          sessionName: "task-usage-receipt",
          prompt: "Return a short result.",
          cwd: root,
          ctx: { modelRegistry: {} } as never,
          pi: { sendMessage: (message: { details?: Record<string, unknown> }) => { sent.push(message); } } as never,
          piDir: join(root, ".pi"),
          artifactsDir: join(root, ".pi", "artifacts"),
          isBackground,
          backgroundTasks: new Map(),
          foregroundTasks: new Map(),
          deliveryGuard: new DeliveryGuard(),
          taskWidget: {
            noteTaskFinished: () => {},
            openTaskView: () => {},
            closeTaskView: () => {},
            setLiveTranscript: () => {},
          } as never,
          clearTaskWidgetIfIdle: () => {},
          ensureTaskWidget: () => {},
          enqueueDelivery: (delivery) => { delivery(); },
          runTask: async (input) => {
            const terminalInput = input as typeof input & {
              onTerminalUsage?: (value: typeof usage) => void;
            };
            terminalInput.onTerminalUsage?.(usage);
            if (outcome === "cancelled") throw new DurableTaskCancelledError("cancelled for test");
            throw new Error("provider failed for test");
          },
        });

        if (isBackground) {
          for (let waited = 0; waited < 2_000 && sent.length === 0; waited += 10) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          assert.equal(sent.length, 1, "one terminal background receipt is sent");
          assert.equal(sent[0]?.details?.phase, outcome);
          assert.deepEqual(sent[0]?.details?.usage, usage);
        } else {
          assert.equal(result.details.phase, outcome);
          assert.deepEqual(result.details.usage, usage);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

for (const outcome of ["success", "failure"] as const) {
  test(`durable background ${outcome} marks stale-context sends suppressed`, async () => {
    const root = mkdtempSync(join(tmpdir(), `pi-task-durable-stale-send-${outcome}-`));
    const queue = createCompletionDeliveryQueue(0);
    let sendAttempts = 0;
    try {
      await executeDurableTask({
        id: `t-stale-send-${outcome}`,
        agent: {
          name: "general",
          description: "General task",
          body: "",
          source: "project",
          path: "test-agent.md",
        },
        description: "Exercise stale completion sends",
        sessionName: `task-t-stale-send-${outcome}`,
        prompt: "Return a short result.",
        cwd: root,
        ctx: { modelRegistry: {} } as never,
        pi: {
          sendMessage: () => {
            sendAttempts++;
            throw new Error("This extension ctx is stale after session replacement");
          },
        } as never,
        piDir: join(root, ".pi"),
        artifactsDir: join(root, ".pi", "artifacts"),
        isBackground: true,
        backgroundTasks: new Map(),
        foregroundTasks: new Map(),
        deliveryGuard: new DeliveryGuard(),
        taskWidget: {
          noteTaskFinished: () => {},
          setLiveTranscript: () => {},
        } as never,
        clearTaskWidgetIfIdle: () => {},
        ensureTaskWidget: () => {},
        enqueueDelivery: (delivery, deliveryId) => queue.enqueue(deliveryId, delivery),
        runTask: async () => {
          if (outcome === "failure") throw new Error("simulated durable failure");
          return {
            conversationId: "durable-child-stale-send",
            answer: "<status>success</status>\\n<summary>Finished.</summary>",
            usage: { models: {}, tools: {}, totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costTotal: 0 } },
          };
        },
      });

      for (let waited = 0; waited < 1_000 && sendAttempts === 0; waited += 10) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(sendAttempts, 1, "the stale send callback ran once");
      assert.equal(queue.hasPending(), false, "a stale-context send releases the completion guard");
    } finally {
      queue.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

// ── Crash matrix through the integrated delivery path ──────────────────────

test("aborting a recovered durable task is recorded and delivered as cancelled", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-recovered-cancel-"));
  const piDir = join(root, ".pi");
  const databasePath = join(piDir, "durable", "tasks.sqlite");
  const taskId = "t-recovered-cancel";
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 30" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("The aborted tool must not continue."),
  ]);
  const sent: { content?: string; details?: Record<string, unknown> }[] = [];
  let settledStatus: string | undefined;
  let handle: Awaited<ReturnType<typeof openDurableHarness>> | undefined;
  let abortTask: (() => Promise<string | null>) | undefined;
  let completion: Promise<unknown> = Promise.resolve();

  try {
    upsertTaskSessionHistory(piDir, {
      id: taskId,
      status: "running",
      background: true,
      backend: "durable",
      agentType: "general",
      description: "Cancel recovered durable work",
      sessionName: `task-${taskId}`,
      startedAt: Date.now(),
      piDir,
      dir: join(piDir, "artifacts"),
      cwd: root,
      ownerSessionId: "sess-cancel",
    });
    handle = await openDurableHarness(piDir, { databasePath, models: () => models });
    abortTask = () => abortDurableTask(piDir, taskId, { databasePath });

    let markSubmitted!: () => void;
    const submitted = new Promise<void>((resolve) => { markSubmitted = resolve; });
    const taskRun = runDurableTask({
      piDir,
      databasePath,
      taskId,
      task: "Run a cancellable tool.",
      models: () => models,
      onSubmitted: () => markSubmitted(),
    });
    completion = taskRun.then(
      () => undefined,
      (error: unknown) => error,
    );
    await submitted;
    await new Promise((resolve) => setTimeout(resolve, 100));

    await resumeDurableAfterRestart({
      pi: { sendMessage: (message: { content?: string; details?: Record<string, unknown> }) => { sent.push(message); } } as never,
      piDir,
      sessionId: "sess-cancel",
      databasePath,
      models: () => models,
      onTaskSettled: (_id, _history, status) => { settledStatus = status; },
    });
    assert.equal(await abortTask(), null);
    assert.ok((await completion) instanceof DurableTaskCancelledError);

    for (let waited = 0; waited < 2_000 && settledStatus === undefined; waited += 10) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(settledStatus, "cancelled");
    assert.equal(readTaskSessionHistory(piDir).find((entry) => entry.id === taskId)?.status, "cancelled");
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.details?.phase, "cancelled");
  } finally {
    if (abortTask) await abortTask().catch(() => null);
    await completion;
    if (handle) await handle.harness.close(handle.context);
    rmSync(root, { recursive: true, force: true });
  }
});

test("session_start reconciles stale SDK siblings before replaying their comparison", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-session-start-order-"));
  const piDir = join(root, ".pi");
  const databasePath = join(piDir, "durable", "tasks.sqlite");
  const taskId = "t-session-start-order";
  const legacyTaskId = "t-session-start-ambiguous-legacy";
  const foreignSdkTaskId = "t-session-start-foreign-sdk";
  const testDir = dirname(fileURLToPath(import.meta.url));
  const crashScript = join(testDir, "durable-crash-child.ts");
  const startupScript = join(testDir, "durable-session-start-child.ts");
  let crashChild: ReturnType<typeof spawn> | undefined;
  let startupChild: ReturnType<typeof spawn> | undefined;

  try {
    upsertTaskSessionHistory(piDir, {
      id: taskId,
      status: "running",
      background: true,
      agentType: "general",
      description: "Recover session-start ordering",
      sessionName: `task-${taskId}`,
      startedAt: Date.now(),
      piDir,
      dir: join(piDir, "artifacts"),
      cwd: root,
      ownerSessionId: "sess-start",
    });
    for (const [id, model, index] of [
      ["t-sdk-compare-m0", "model-a", 0],
      ["t-sdk-compare-m1", "model-b", 1],
    ] as const) {
      upsertTaskSessionHistory(piDir, {
        id,
        status: "running",
        background: true,
        agentType: "reviewer",
        description: "Interrupted SDK comparison",
        sessionName: `task-${id}`,
        startedAt: Date.now(),
        piDir,
        dir: join(piDir, "artifacts"),
        ownerSessionId: "sess-start",
        comparisonGroupId: "g-session-start-sdk",
        comparisonModel: model,
        comparisonDescription: "Interrupted SDK comparison",
        comparisonIndex: index,
      });
    }
    upsertTaskSessionHistory(piDir, {
      id: legacyTaskId,
      status: "running",
      background: true,
      agentType: "general",
      description: "Ambiguous legacy task",
      sessionName: `task-${legacyTaskId}`,
      startedAt: Date.now(),
      piDir,
      dir: join(piDir, "artifacts"),
      ownerSessionId: "sess-start",
    });
    upsertTaskSessionHistory(piDir, {
      id: foreignSdkTaskId,
      status: "running",
      background: true,
      backend: "sdk",
      agentType: "general",
      description: "SDK task owned by another session",
      sessionName: `task-${foreignSdkTaskId}`,
      startedAt: Date.now(),
      piDir,
      dir: join(piDir, "artifacts"),
      ownerSessionId: "sess-other",
    });

    const crash = spawn(
      process.execPath,
      ["--import", "tsx", crashScript, databasePath, piDir, taskId],
      { env: process.env, stdio: ["ignore", "pipe", "inherit"] },
    );
    crashChild = crash;
    await new Promise<void>((resolve, reject) => {
      let output = "";
      crash.stdout!.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes("M2 child: submitted")) resolve();
      });
      crash.on("exit", (code) => reject(new Error(`crash child exited early: ${code}`)));
      setTimeout(() => reject(new Error("crash child never submitted")), 20_000).unref();
    });
    await new Promise((resolve) => setTimeout(resolve, 1_500)); // land mid-tool
    const crashExit = new Promise<void>((resolve) => crash.once("exit", () => resolve()));
    crash.kill("SIGKILL");
    await crashExit;

    const startup = spawn(
      process.execPath,
      ["--import", "tsx", startupScript, piDir, root, taskId],
      {
        env: { ...process.env, PI_TASK_BACKEND: "auto" },
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    startupChild = startup;
    const startupExit = new Promise<number | null>((resolve) => {
      startup.once("exit", (code) => resolve(code));
    });
    let output = "";
    const statePromise = new Promise<{
      status?: string;
      backend?: string;
      modelStarted?: boolean;
      comparisonReports?: number;
    }>((resolve, reject) => {
      startup.stdout!.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const match = output.match(/SESSION_START_ORDER (\{[^\n]+\})/);
        if (match) resolve(JSON.parse(match[1]!) as { status?: string; backend?: string; modelStarted?: boolean });
      });
      startup.once("exit", (code) => {
        if (!output.includes("SESSION_START_ORDER ")) {
          reject(new Error(`startup child exited before reporting state (${code}): ${output}`));
        }
      });
      setTimeout(() => reject(new Error(`startup child did not report state: ${output}`)), 20_000).unref();
    });
    const state = await statePromise;
    assert.equal(await startupExit, 0, "startup helper exits after recording the restored state");
    assert.equal(state.status, "running", "session_start must not stale-fail the durable row");
    assert.equal(state.backend, "durable", "session_start identifies the recovered backend");
    assert.equal(state.modelStarted, true, "the interrupted submission is actively resumed");
    assert.equal(state.comparisonReports, 1, "interrupted SDK siblings are reported on this startup");
    const comparisonHistory = readTaskSessionHistory(piDir).filter(
      (entry) => entry.comparisonGroupId === "g-session-start-sdk",
    );
    assert.equal(comparisonHistory.length, 2);
    assert.ok(comparisonHistory.every((entry) => entry.status === "failed"));
    assert.ok(comparisonHistory.every((entry) => entry.comparisonDelivered === true));
    assert.equal(
      readTaskSessionHistory(piDir).find((entry) => entry.id === legacyTaskId)?.status,
      "running",
      "successful durable recovery must not classify ambiguous legacy history as SDK work",
    );
    assert.equal(
      readTaskSessionHistory(piDir).find((entry) => entry.id === foreignSdkTaskId)?.status,
      "running",
      "session_start must not reconcile SDK work owned by another session",
    );
  } finally {
    for (const child of [startupChild, crashChild]) {
      if (child && child.exitCode === null && child.signalCode === null) {
        const childExit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        child.kill("SIGKILL");
        await childExit;
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("session_start reconciles SDK comparison siblings after durable recovery fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-session-start-recovery-error-"));
  const piDir = join(root, ".pi");
  const databasePath = join(piDir, "durable", "tasks.sqlite");
  const startupScript = join(dirname(fileURLToPath(import.meta.url)), "durable-session-start-child.ts");
  const taskId = "t-session-start-recovery-error";
  let startupChild: ReturnType<typeof spawn> | undefined;

  try {
    mkdirSync(dirname(databasePath), { recursive: true });
    writeFileSync(databasePath, "not a SQLite database");
    upsertTaskSessionHistory(piDir, {
      id: taskId,
      status: "running",
      background: true,
      backend: "durable",
      agentType: "general",
      description: "Preserve durable history when recovery storage is unreadable",
      sessionName: `task-${taskId}`,
      startedAt: Date.now(),
      piDir,
      dir: join(piDir, "artifacts"),
      cwd: root,
      ownerSessionId: "sess-start",
    });
    for (const [id, model, index] of [
      ["t-sdk-error-compare-m0", "model-a", 0],
      ["t-sdk-error-compare-m1", "model-b", 1],
    ] as const) {
      upsertTaskSessionHistory(piDir, {
        id,
        status: "running",
        background: true,
        ...(index === 0 ? { backend: "sdk" as const } : {}),
        agentType: "reviewer",
        description: "Interrupted SDK comparison",
        sessionName: `task-${id}`,
        startedAt: Date.now(),
        piDir,
        dir: join(piDir, "artifacts"),
        ownerSessionId: "sess-start",
        comparisonGroupId: "g-session-start-recovery-error",
        comparisonModel: model,
        comparisonDescription: "Interrupted SDK comparison",
        comparisonIndex: index,
      });
    }
    const legacyTaskId = "t-unclassified-error-legacy";
    upsertTaskSessionHistory(piDir, {
      id: legacyTaskId,
      status: "running",
      background: true,
      agentType: "general",
      description: "Unclassified legacy task",
      sessionName: `task-${legacyTaskId}`,
      startedAt: Date.now(),
      piDir,
      dir: join(piDir, "artifacts"),
      ownerSessionId: "sess-start",
    });

    const startup = spawn(
      process.execPath,
      ["--import", "tsx", startupScript, piDir, root, taskId],
      { env: { ...process.env, PI_TASK_BACKEND: "auto" }, stdio: ["ignore", "pipe", "inherit"] },
    );
    startupChild = startup;
    const startupExit = new Promise<number | null>((resolve) => startup.once("exit", resolve));
    let output = "";
    const statePromise = new Promise<{
      status?: string;
      backend?: string;
      modelStarted?: boolean;
      comparisonReports?: number;
    }>((resolve, reject) => {
      startup.stdout!.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const match = output.match(/SESSION_START_ORDER (\{[^\n]+\})/);
        if (match) resolve(JSON.parse(match[1]!) as {
          status?: string;
          backend?: string;
          modelStarted?: boolean;
          comparisonReports?: number;
        });
      });
      startup.once("exit", (code) => {
        if (!output.includes("SESSION_START_ORDER ")) {
          reject(new Error(`startup child exited before reporting state (${code}): ${output}`));
        }
      });
      setTimeout(() => reject(new Error(`startup child did not report state: ${output}`)), 20_000).unref();
    });
    const state = await statePromise;
    assert.equal(await startupExit, 0);
    assert.equal(state.status, "running", "unreadable durable history is preserved for diagnosis");
    assert.equal(state.backend, "durable");
    assert.equal(state.modelStarted, false, "unreadable storage cannot resume its durable child");
    assert.equal(state.comparisonReports, 1, "comparison replay runs despite durable recovery failure");
    const comparisonHistory = readTaskSessionHistory(piDir).filter(
      (entry) => entry.comparisonGroupId === "g-session-start-recovery-error",
    );
    assert.equal(comparisonHistory.length, 2);
    assert.ok(comparisonHistory.every((entry) => entry.status === "failed"));
    assert.ok(comparisonHistory.every((entry) => entry.comparisonDelivered === true));
    assert.equal(
      readTaskSessionHistory(piDir).find((entry) => entry.id === legacyTaskId)?.status,
      "running",
      "unclassified legacy history is preserved while durable recovery is unavailable",
    );
  } finally {
    if (startupChild && startupChild.exitCode === null && startupChild.signalCode === null) {
      const childExit = new Promise<void>((resolve) => startupChild!.once("exit", () => resolve()));
      startupChild.kill("SIGKILL");
      await childExit;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("unreadable durable storage does not make a running task retryable", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-unstatable-storage-"));
  const piDir = join(root, ".pi");
  const storagePath = join(root, "storage-file");
  const taskId = "t-unreadable-durable-storage";
  const databasePath = join(storagePath, "tasks.sqlite");
  try {
    writeFileSync(storagePath, "not a directory");
    upsertTaskSessionHistory(piDir, {
      id: taskId,
      status: "running",
      background: true,
      backend: "durable",
      durableRequestId: durableRequestId(taskId, "call-unreadable-storage"),
      agentType: "general",
      description: "Preserve state when the database path cannot be inspected",
      sessionName: `task-${taskId}`,
      startedAt: Date.now(),
      piDir,
      dir: join(piDir, "artifacts"),
      ownerSessionId: "sess-unreadable-storage",
    });

    const reconciled = await reconcileUnadmittedDurableTasks({
      piDir,
      sessionId: "sess-unreadable-storage",
      recoveredTaskIds: new Set(),
      activeTaskIds: new Set(),
      databasePath,
    });
    assert.deepEqual(reconciled, []);
    assert.equal(readTaskSessionHistory(piDir).find((entry) => entry.id === taskId)?.status, "running");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("durable restart recovery does not treat an unstatable database as missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-recovery-unstatable-"));
  const piDir = join(root, ".pi");
  const storagePath = join(root, "storage-file");
  try {
    mkdirSync(piDir, { recursive: true });
    writeFileSync(storagePath, "not a directory");

    await assert.rejects(
      resumeDurableAfterRestart({
        pi: {} as never,
        piDir,
        databasePath: join(storagePath, "tasks.sqlite"),
      }),
      (error: unknown) =>
        error instanceof Error &&
        (error as NodeJS.ErrnoException).code === "ENOTDIR",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pre-admission recovery preserves a durable runner still active in this process", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-active-unadmitted-"));
  const piDir = join(root, ".pi");
  const taskId = "t-active-before-admission";
  try {
    upsertTaskSessionHistory(piDir, {
      id: taskId,
      status: "running",
      background: true,
      backend: "durable",
      durableRequestId: durableRequestId(taskId, "call-active-before-admission"),
      agentType: "general",
      description: "Keep a live runner active before admission",
      sessionName: `task-${taskId}`,
      startedAt: Date.now(),
      piDir,
      dir: join(piDir, "artifacts"),
      ownerSessionId: "sess-live",
    });

    const reconciled = await reconcileUnadmittedDurableTasks({
      piDir,
      sessionId: "sess-live",
      recoveredTaskIds: new Set(),
      activeTaskIds: new Set([taskId]),
    });
    assert.deepEqual(reconciled, []);
    assert.equal(readTaskSessionHistory(piDir).find((entry) => entry.id === taskId)?.status, "running");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pre-admission reconciliation preserves tasks with live owner processes", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-live-owner-unadmitted-"));
  const piDir = join(root, ".pi");
  const taskEntries = [
    { id: "t-live-same-session-owner", ownerPid: 4242, ownerSessionId: "sess-live-owner" },
    { id: "t-live-ownerless", ownerPid: 4343 },
  ];
  try {
    for (const task of taskEntries) {
      upsertTaskSessionHistory(piDir, {
        id: task.id,
        status: "running",
        background: true,
        backend: "durable",
        durableRequestId: durableRequestId(task.id, `call-${task.id}`),
        agentType: "general",
        description: "Preserve a runner owned by another live process",
        sessionName: `task-${task.id}`,
        startedAt: Date.now(),
        piDir,
        dir: join(piDir, "artifacts"),
        ownerPid: task.ownerPid,
        ...(task.ownerSessionId ? { ownerSessionId: task.ownerSessionId } : {}),
      });
    }

    const reconciled = await reconcileUnadmittedDurableTasks({
      piDir,
      sessionId: "sess-live-owner",
      recoveredTaskIds: new Set(),
      activeTaskIds: new Set(),
      isProcessAlive: (pid: number) => pid === 4242 || pid === 4343,
    });
    assert.deepEqual(reconciled, []);
    const history = readTaskSessionHistory(piDir);
    assert.ok(taskEntries.every((task) => history.find((entry) => entry.id === task.id)?.status === "running"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pre-admission reconciliation preserves session-owned work when current session is unknown", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-unknown-session-owner-"));
  const piDir = join(root, ".pi");
  const taskId = "t-unknown-current-session";
  try {
    upsertTaskSessionHistory(piDir, {
      id: taskId,
      status: "running",
      background: true,
      backend: "durable",
      durableRequestId: durableRequestId(taskId, "call-unknown-current-session"),
      agentType: "general",
      description: "Keep ownership ambiguous without a current session id",
      sessionName: `task-${taskId}`,
      startedAt: Date.now(),
      piDir,
      dir: join(piDir, "artifacts"),
      ownerSessionId: "sess-persisted-owner",
    });

    const reconciled = await reconcileUnadmittedDurableTasks({
      piDir,
      recoveredTaskIds: new Set(),
      activeTaskIds: new Set(),
    });
    assert.deepEqual(reconciled, []);
    assert.equal(readTaskSessionHistory(piDir).find((entry) => entry.id === taskId)?.status, "running");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pre-admission recovery releases only a reservation owned by a dead process", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-dead-admission-"));
  const piDir = join(root, ".pi");
  const databasePath = join(piDir, "durable", "tasks.sqlite");
  const taskId = "t-dead-admission";
  const requestId = durableRequestId(taskId, "call-retry-after-admission");
  const priorRequestId = durableRequestId(taskId, "call-prior");
  let handle: Awaited<ReturnType<typeof openDurableHarness>> | undefined;
  try {
    handle = await openDurableHarness(piDir, {
      databasePath,
      models: makeModels(["Prior answer.", "Retry answer.", "Other prior answer."]),
    });
    const prior = await runDurableTask({
      piDir,
      databasePath,
      taskId,
      task: "Complete a prior request.",
      requestId: priorRequestId,
      models: makeModels(["Prior answer.", "Retry answer."]),
    });
    const conversation = await handle.harness.conversation(
      prior.conversationId as never,
      handle.context,
    );
    assert.ok(conversation);
    await conversation.commit(async (tx) => {
      const runs = await tx.doc(handle!.runsDoc, Number(prior.conversationId) as never);
      runs.byRequestId[requestId] = { taskId, status: "admitting", ownerPid: 4242 };
      runs.activeByTask[taskId] = requestId;
    }, handle.context);
    upsertTaskSessionHistory(piDir, {
      id: taskId,
      status: "running",
      background: true,
      backend: "durable",
      durableRequestId: requestId,
      agentType: "general",
      description: "Retry after an owner dies before durable submission.",
      sessionName: `task-${taskId}`,
      startedAt: Date.now(),
      piDir,
      dir: join(piDir, "artifacts"),
      ownerSessionId: "sess-dead-admission",
      ownerPid: 4242,
    });

    const reconciled = await reconcileUnadmittedDurableTasks({
      piDir,
      sessionId: "sess-dead-admission",
      recoveredTaskIds: new Set(),
      activeTaskIds: new Set(),
      databasePath,
      isProcessAlive: () => false,
    });
    assert.deepEqual(reconciled, [taskId]);
    const state = await handle.harness.snapshot(
      handle.runsDoc,
      Number(prior.conversationId) as never,
      handle.context,
    );
    assert.equal(state?.byRequestId[requestId], undefined);
    assert.equal(state?.activeByTask[taskId], undefined);

    const retry = await runDurableTask({
      piDir,
      databasePath,
      taskId,
      task: "Retry the previously unsubmitted request.",
      requestId,
    });
    assert.equal(retry.answer, "Retry answer.");

    const unknownOwnerTaskId = "t-unknown-admission-owner";
    const unknownOwnerRequestId = durableRequestId(unknownOwnerTaskId, "call-unknown-owner");
    const unknownOwnerPrior = await runDurableTask({
      piDir,
      databasePath,
      taskId: unknownOwnerTaskId,
      task: "Create a second child before an uncertain admission.",
    });
    const unknownOwnerConversation = await handle.harness.conversation(
      unknownOwnerPrior.conversationId as never,
      handle.context,
    );
    assert.ok(unknownOwnerConversation);
    await unknownOwnerConversation.commit(async (tx) => {
      const runs = await tx.doc(handle!.runsDoc, Number(unknownOwnerPrior.conversationId) as never);
      runs.byRequestId[unknownOwnerRequestId] = {
        taskId: unknownOwnerTaskId,
        status: "admitting",
        ownerPid: process.pid,
      };
      runs.activeByTask[unknownOwnerTaskId] = unknownOwnerRequestId;
    }, handle.context);
    upsertTaskSessionHistory(piDir, {
      id: unknownOwnerTaskId,
      status: "running",
      background: true,
      backend: "durable",
      durableRequestId: unknownOwnerRequestId,
      agentType: "general",
      description: "Preserve a live reservation when stale history has another PID.",
      sessionName: `task-${unknownOwnerTaskId}`,
      startedAt: Date.now(),
      piDir,
      dir: join(piDir, "artifacts"),
      ownerSessionId: "sess-dead-admission",
      ownerPid: 4242,
    });
    const unknownOwnerReconciled = await reconcileUnadmittedDurableTasks({
      piDir,
      sessionId: "sess-dead-admission",
      recoveredTaskIds: new Set(),
      activeTaskIds: new Set(),
      databasePath,
      isProcessAlive: (pid) => pid === process.pid,
    });
    assert.deepEqual(unknownOwnerReconciled, []);
    const unknownOwnerState = await handle.harness.snapshot(
      handle.runsDoc,
      Number(unknownOwnerPrior.conversationId) as never,
      handle.context,
    );
    assert.equal(unknownOwnerState?.byRequestId[unknownOwnerRequestId]?.status, "admitting");
    assert.equal(
      readTaskSessionHistory(piDir).find((entry) => entry.id === unknownOwnerTaskId)?.status,
      "running",
    );
  } finally {
    if (handle) await handle.harness.close(handle.context);
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale pre-admission reconciliation cannot overwrite a newer request history", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-reconcile-history-race-"));
  const piDir = join(root, ".pi");
  const databasePath = join(piDir, "durable", "tasks.sqlite");
  const taskId = "t-reconcile-history-race";
  const oldRequestId = durableRequestId(taskId, "call-old-owner");
  const newRequestId = durableRequestId(taskId, "call-new-owner");
  const gated = makeGatedModels(["Prior answer.", "New request answer."]);
  let handle: Awaited<ReturnType<typeof openDurableHarness>> | undefined;
  let newTaskPromise: ReturnType<typeof runDurableTask> | undefined;
  let resumeOldInspection!: () => void;
  let oldInspectionReached!: () => void;
  const oldInspectionGate = new Promise<void>((resolve) => { resumeOldInspection = resolve; });
  const oldInspectionStarted = new Promise<void>((resolve) => { oldInspectionReached = resolve; });
  let oldReconcilePromise: Promise<string[]> | undefined;
  try {
    handle = await openDurableHarness(piDir, { databasePath, models: () => gated.models });
    const prior = runDurableTask({
      piDir,
      databasePath,
      taskId,
      task: "Create the durable child.",
      requestId: durableRequestId(taskId, "call-prior"),
      models: () => gated.models,
    });
    await gated.resultReached(0);
    gated.releaseResult(0);
    const priorResult = await prior;
    const conversation = await handle.harness.conversation(
      priorResult.conversationId as never,
      handle.context,
    );
    assert.ok(conversation);
    await conversation.commit(async (tx) => {
      const runs = await tx.doc(handle!.runsDoc, Number(priorResult.conversationId) as never);
      runs.byRequestId[oldRequestId] = {
        taskId,
        status: "admitting",
        ownerPid: 4242,
      };
      runs.activeByTask[taskId] = oldRequestId;
    }, handle.context);
    upsertTaskSessionHistory(piDir, {
      id: taskId,
      status: "running",
      background: true,
      backend: "durable",
      durableRequestId: oldRequestId,
      agentType: "general",
      description: "Old owner before the delayed recovery pass.",
      sessionName: `task-${taskId}`,
      startedAt: Date.now(),
      piDir,
      dir: join(piDir, "artifacts"),
      ownerSessionId: "sess-history-race",
      ownerPid: 4242,
    });

    const originalHasSubmission = handle.hasSubmission.bind(handle);
    let pauseOldInspection = true;
    handle.hasSubmission = async (conversationId, requestId) => {
      if (requestId === oldRequestId && pauseOldInspection) {
        pauseOldInspection = false;
        oldInspectionReached();
        await oldInspectionGate;
      }
      return originalHasSubmission(conversationId, requestId);
    };
    const recoveryOptions = {
      piDir,
      sessionId: "sess-history-race",
      recoveredTaskIds: new Set<string>(),
      activeTaskIds: new Set<string>(),
      databasePath,
      isProcessAlive: () => false,
    };
    oldReconcilePromise = reconcileUnadmittedDurableTasks(recoveryOptions);
    await oldInspectionStarted;

    const newerReconcile = await reconcileUnadmittedDurableTasks(recoveryOptions);
    assert.deepEqual(newerReconcile, [taskId], "the second pass releases the dead owner's reservation");
    upsertTaskSessionHistory(piDir, {
      id: taskId,
      status: "running",
      background: true,
      backend: "durable",
      durableRequestId: newRequestId,
      agentType: "general",
      description: "A newer owner has admitted a request.",
      sessionName: `task-${taskId}`,
      startedAt: Date.now(),
      piDir,
      dir: join(piDir, "artifacts"),
      ownerSessionId: "sess-history-race",
      ownerPid: process.pid,
    });
    newTaskPromise = runDurableTask({
      piDir,
      databasePath,
      taskId,
      task: "NEW_INSTRUCTION",
      requestId: newRequestId,
    });
    await gated.resultReached(1);

    resumeOldInspection();
    const oldReconciled = await oldReconcilePromise;
    assert.deepEqual(oldReconciled, [], "the stale pass must not claim the newer history row");
    const currentHistory = readTaskSessionHistory(piDir).find((entry) => entry.id === taskId);
    assert.equal(currentHistory?.status, "running");
    assert.equal(currentHistory?.durableRequestId, newRequestId);
    assert.equal(currentHistory?.ownerPid, process.pid);

    gated.releaseResult(1);
    const newResult = await newTaskPromise;
    assert.equal(newResult.answer, "New request answer.");
  } finally {
    resumeOldInspection();
    gated.releaseResult(0);
    gated.releaseResult(1);
    if (newTaskPromise) await newTaskPromise.catch(() => undefined);
    if (oldReconcilePromise) await oldReconcilePromise.catch(() => undefined);
    if (handle) await handle.harness.close(handle.context);
    rmSync(root, { recursive: true, force: true });
  }
});

test("session_start makes a durable task retriable after a pre-admission crash with no storage", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-session-start-unadmitted-"));
  const piDir = join(root, ".pi");
  const taskId = "t-session-start-unadmitted";
  const startupScript = join(dirname(fileURLToPath(import.meta.url)), "durable-session-start-child.ts");
  let startupChild: ReturnType<typeof spawn> | undefined;

  try {
    upsertTaskSessionHistory(piDir, {
      id: taskId,
      status: "running",
      background: true,
      backend: "durable",
      durableRequestId: durableRequestId(taskId, "call-not-admitted"),
      agentType: "general",
      description: "Retry after crashing before durable admission",
      sessionName: `task-${taskId}`,
      startedAt: Date.now(),
      piDir,
      dir: join(piDir, "artifacts"),
      cwd: root,
      ownerSessionId: "sess-start",
    });

    const startup = spawn(
      process.execPath,
      ["--import", "tsx", startupScript, piDir, root, taskId],
      { env: { ...process.env, PI_TASK_BACKEND: "auto" }, stdio: ["ignore", "pipe", "inherit"] },
    );
    startupChild = startup;
    const startupExit = new Promise<number | null>((resolve) => startup.once("exit", resolve));
    let output = "";
    const statePromise = new Promise<{
      status?: string;
      backend?: string;
      modelStarted?: boolean;
      comparisonReports?: number;
    }>((resolve, reject) => {
      startup.stdout!.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const match = output.match(/SESSION_START_ORDER (\{[^\n]+\})/);
        if (match) resolve(JSON.parse(match[1]!) as {
          status?: string;
          backend?: string;
          modelStarted?: boolean;
          comparisonReports?: number;
        });
      });
      startup.once("exit", (code) => {
        if (!output.includes("SESSION_START_ORDER ")) {
          reject(new Error(`startup child exited before reporting state (${code}): ${output}`));
        }
      });
      setTimeout(() => reject(new Error(`startup child did not report state: ${output}`)), 20_000).unref();
    });
    const state = await statePromise;
    assert.equal(await startupExit, 0);
    assert.equal(state.status, "failed", "the absent store proves that no durable submission was admitted");
    assert.equal(state.backend, "durable");
    assert.equal(state.modelStarted, false);
    const history = readTaskSessionHistory(piDir).find((entry) => entry.id === taskId);
    assert.equal(history?.rawStatus, "host-restarted-before-admission");
    assert.equal(history?.durableRequestId, durableRequestId(taskId, "call-not-admitted"));

    const resolution = resolveTaskResume({
      requestedTaskId: taskId,
      taskParams: {
        agent_type: "general",
        description: "Retry the unadmitted task",
        prompt: "Continue the task.",
        task_id: taskId,
      },
      agentName: "general",
      piDir,
      artifactsDir: join(piDir, "artifacts"),
      extensionPiDir: piDir,
      ctx: {} as never,
      backgroundTasks: new Map(),
      deliveryGuard: new DeliveryGuard(),
      registryEntryStatus: () => "missing",
    });
    assert.equal(resolution.kind, "continue", "the task ID is eligible for a new durable submission");
    if (resolution.kind === "continue") {
      assert.equal(resolution.id, taskId);
      assert.equal(resolution.resume, true);
      assert.equal(resolution.backend, "durable");
    }
  } finally {
    if (startupChild && startupChild.exitCode === null && startupChild.signalCode === null) {
      const childExit = new Promise<void>((resolve) => startupChild!.once("exit", () => resolve()));
      startupChild.kill("SIGKILL");
      await childExit;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("session_start makes a durable task retriable when its child has no admitted submission", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-session-start-idle-child-"));
  const piDir = join(root, ".pi");
  const databasePath = join(piDir, "durable", "tasks.sqlite");
  const taskId = "t-session-start-idle-child";
  const requestId = durableRequestId(taskId, "call-no-submission");
  const priorRequestId = durableRequestId(taskId, "call-prior-submission");
  const startupScript = join(dirname(fileURLToPath(import.meta.url)), "durable-session-start-child.ts");
  let handle: Awaited<ReturnType<typeof openDurableHarness>> | undefined;
  let startupChild: ReturnType<typeof spawn> | undefined;

  try {
    const exitedOwner = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise<void>((resolve, reject) => {
      exitedOwner.once("exit", () => resolve());
      exitedOwner.once("error", reject);
    });
    const deadOwnerPid = exitedOwner.pid;
    assert.ok(deadOwnerPid);
    upsertTaskSessionHistory(piDir, {
      id: taskId,
      status: "running",
      background: true,
      backend: "durable",
      durableRequestId: requestId,
      agentType: "general",
      description: "Retry after creating a child but before submission admission",
      sessionName: `task-${taskId}`,
      startedAt: Date.now(),
      piDir,
      dir: join(piDir, "artifacts"),
      cwd: root,
      ownerSessionId: "sess-start",
      ownerPid: deadOwnerPid,
    });
    handle = await openDurableHarness(piDir, {
      databasePath,
      models: makeModels(["Prior submission completed."]),
    });
    await runDurableTask({
      piDir,
      taskId,
      task: "Finish an earlier submission on this child.",
      requestId: priorRequestId,
      databasePath,
      models: makeModels(["Prior submission completed."]),
    });
    const cancelledBeforeAdmission = new AbortController();
    cancelledBeforeAdmission.abort();
    await assert.rejects(
      runDurableTask({
        piDir,
        taskId,
        task: "This input is never submitted.",
        requestId,
        databasePath,
        models: makeModels([]),
        signal: cancelledBeforeAdmission.signal,
      }),
      DurableTaskCancelledError,
    );
    await handle.harness.close(handle.context);
    handle = undefined;

    const startup = spawn(
      process.execPath,
      ["--import", "tsx", startupScript, piDir, root, taskId],
      { env: { ...process.env, PI_TASK_BACKEND: "auto" }, stdio: ["ignore", "pipe", "inherit"] },
    );
    startupChild = startup;
    const startupExit = new Promise<number | null>((resolve) => startup.once("exit", resolve));
    let output = "";
    const statePromise = new Promise<{
      status?: string;
      backend?: string;
      modelStarted?: boolean;
      comparisonReports?: number;
    }>((resolve, reject) => {
      startup.stdout!.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const match = output.match(/SESSION_START_ORDER (\{[^\n]+\})/);
        if (match) resolve(JSON.parse(match[1]!) as {
          status?: string;
          backend?: string;
          modelStarted?: boolean;
          comparisonReports?: number;
        });
      });
      startup.once("exit", (code) => {
        if (!output.includes("SESSION_START_ORDER ")) {
          reject(new Error(`startup child exited before reporting state (${code}): ${output}`));
        }
      });
      setTimeout(() => reject(new Error(`startup child did not report state: ${output}`)), 20_000).unref();
    });
    const state = await statePromise;
    assert.equal(await startupExit, 0);
    assert.equal(state.status, "failed", "an idle mapped child has no admitted work to recover");
    assert.equal(state.backend, "durable");
    assert.equal(state.modelStarted, false);

    const resolution = resolveTaskResume({
      requestedTaskId: taskId,
      taskParams: {
        agent_type: "general",
        description: "Retry the unadmitted task",
        prompt: "Continue the task.",
        task_id: taskId,
      },
      agentName: "general",
      piDir,
      artifactsDir: join(piDir, "artifacts"),
      extensionPiDir: piDir,
      ctx: {} as never,
      backgroundTasks: new Map(),
      deliveryGuard: new DeliveryGuard(),
      registryEntryStatus: () => "missing",
    });
    assert.equal(resolution.kind, "continue", "the idle child can receive a new durable submission");
    if (resolution.kind === "continue") {
      assert.equal(resolution.id, taskId);
      assert.equal(resolution.resume, true);
      assert.equal(resolution.backend, "durable");
    }
  } finally {
    if (handle) await handle.harness.close(handle.context);
    if (startupChild && startupChild.exitCode === null && startupChild.signalCode === null) {
      const childExit = new Promise<void>((resolve) => startupChild!.once("exit", () => resolve()));
      startupChild.kill("SIGKILL");
      await childExit;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("SIGKILL mid-tool: the next process resumes and delivers exactly once", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-crash-"));
  const piDir = join(root, ".pi");
  const databasePath = join(piDir, "durable", "tasks.sqlite");
  const scriptPath = fileURLToPath(import.meta.url);
  const childScript = join(dirname(scriptPath), "durable-crash-child.ts");
  const completionQueue = createCompletionDeliveryQueue(0);

  return (async () => {
    upsertTaskSessionHistory(piDir, {
      id: "t-crash",
      status: "running",
      background: true,
      agentType: "general",
      description: "Recover visible progress",
      sessionName: "task-t-crash",
      startedAt: Date.now(),
      piDir,
      dir: join(piDir, "artifacts"),
      cwd: root,
      ownerSessionId: "sess-1",
    });

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
    let queuedDeliveryId: string | undefined;
    const pi = { sendMessage: (message: { content?: string; details?: Record<string, unknown> }) => { sent.push(message); } };
    const recovered = makeRuntimeModelRegistry(["Recovered after crash."]);
    let restoredTask: { taskId: string; status: string | undefined; conversationId: string } | undefined;
    let restoredBackend: string | undefined;
    const recoveredDurableIds = new Set<string>();
    const recoveredProgress: { items: readonly { type: string; name?: string }[]; toolUses: number }[] = [];
    let settledStatus: string | undefined;
    // Delivery is asynchronous: the resumed generation settles on the event
    // loop after the pass registers its hooks, so poll for it.
    const waitForDelivery = async (): Promise<void> => {
      for (let waited = 0; waited < 10_000 && (sent.length === 0 || settledStatus === undefined); waited += 50) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    const recoveredIds = await resumeDurableAfterRestart({
      pi: pi as never,
      piDir,
      sessionId: "sess-1",
      databasePath,
      modelRegistry: recovered,
      enqueueDelivery: (deliveryId, delivery) => {
        queuedDeliveryId = deliveryId;
        completionQueue.enqueue(deliveryId, delivery);
      },
      onTaskResumed: (taskId, history, conversationId) => {
        recoveredDurableIds.add(taskId);
        restoredBackend = history?.backend;
        restoredTask = { taskId, status: history?.status, conversationId };
      },
      onTaskProgress: (_taskId, items, toolUses) => {
        recoveredProgress.push({ items, toolUses });
      },
      onTaskSettled: (_taskId, _history, status) => {
        settledStatus = status;
      },
    });
    assert.equal(recoveredIds.has("t-crash"), true, "startup discovery claims the durable task id");
    assert.equal(restoredBackend, "durable", "legacy history is migrated before UI restoration");
    assert.deepEqual(
      reconcileStaleSdkBackgroundTasks(piDir, recoveredIds),
      [],
      "the SDK stale-history pass runs after durable recovery and preserves this task",
    );
    assert.equal(recoveredDurableIds.has("t-crash"), true);
    await waitForDelivery();
    assert.equal(sent.length, 1, `exactly one delivery, got ${sent.length}`);
    assert.match(sent[0]!.content ?? "", /resumed after restart and finished/);
    assert.equal(sent[0]!.details?.task_id, "t-crash");
    assert.equal(sent[0]!.details?.backend, "durable");
    assert.equal(sent[0]!.details?.resumed, true);
    assert.ok(sent[0]!.details?.usage, "resumed receipt carries the usage ledger");
    assert.equal(sent[0]!.details?.completion_delivery_id, queuedDeliveryId);
    assert.equal(completionQueue.hasPending(), true, "native persistence is still outstanding");
    acknowledgePersistedCompletionDeliveries(completionQueue, [{
      type: "custom_message",
      customType: "task-complete",
      details: sent[0]!.details,
    }]);
    assert.equal(completionQueue.hasPending(), false);
    assert.equal(restoredTask?.taskId, "t-crash", "running task is restored for the task panel");
    assert.equal(restoredTask?.status, "running");
    assert.ok(restoredTask?.conversationId);
    assert.ok(
      recoveredProgress.some((progress) => progress.items.some((item) => item.type === "tool" && item.name === "bash")),
      "the restored task transcript hydrates its in-flight tool from a durable snapshot",
    );
    assert.ok(recoveredProgress.some((progress) => progress.toolUses >= 1));
    assert.equal(settledStatus, "done", "recovered task state settles after completion");

    // 3. Running the resume pass again delivers nothing: the submission is
    // settled, so chaos retries cannot duplicate the delivery.
    await resumeDurableAfterRestart({
      pi: pi as never,
      piDir,
      sessionId: "sess-1",
      databasePath,
      modelRegistry: recovered,
    });
    assert.equal(sent.length, 1, "no duplicate delivery on the second pass");
  })().finally(() => {
    completionQueue.dispose();
    rmSync(root, { recursive: true, force: true });
  });
});

test("durable thinking levels accept only canonical Pi values", () => {
  assert.equal(parseDurableThinkingLevel("high"), "high");
  assert.equal(parseDurableThinkingLevel("  XHigh "), "xhigh");
  assert.equal(parseDurableThinkingLevel("off"), "off");
  assert.equal(parseDurableThinkingLevel(undefined), undefined);
  assert.equal(parseDurableThinkingLevel(""), undefined);
  assert.equal(parseDurableThinkingLevel("disable"), undefined);
});

test("durable failover reconfigures the same child conversation and resubmits", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-failover-"));
  const piDir = join(root, ".pi");
  const databasePath = join(root, "durable.sqlite");
  const quotaFailure = fauxAssistantMessage("", {
    stopReason: "error",
    errorMessage: "Monthly usage limit reached",
  });
  const { registry, calls, faux } = makeFailoverRegistry([quotaFailure, "Fallback answer."]);
  const provider = faux.provider.id;
  let handle: Awaited<ReturnType<typeof openDurableHarness>> | undefined;
  let conversationId: string | undefined;
  const events: { type?: string }[] = [];
  try {
    const result = await runDurableTask({
      piDir,
      databasePath,
      taskId: "t-failover-resubmit",
      task: "Answer the question.",
      modelSpecs: [
        { model: `${provider}/primary`, thinking: "max" },
        { model: `${provider}/fallback`, thinking: "max" },
      ],
      modelRegistry: registry,
      onSubmitted: (id) => { conversationId = id; },
      onEvents: (batch) => { events.push(...(batch as unknown as { type?: string }[])); },
    });
    assert.equal(result.answer, "Fallback answer.");
    assert.deepEqual(calls, ["primary", "fallback"], "strict frontmatter order, one call per model");

    handle = await openDurableHarness(piDir, { databasePath });
    const conversation = await handle.harness.conversation(conversationId as never, handle.context);
    assert.ok(conversation, "the fallback reuses the primary's child conversation");
    assert.deepEqual(
      (await conversation.agent(handle.context)).model,
      { provider, modelId: "fallback" },
      "the same conversation is configured to the fallback before resubmission",
    );
    const context = await conversation.context(handle.context);
    assert.equal(
      context.messages.filter((message) => message.role === "user").length,
      2,
      "both attempts are submitted into the same conversation",
    );
    assert.ok(
      events.some((event) => event.type === "agent_changed"),
      "the configure commit reaches the live transcript (footer) stream",
    );
  } finally {
    if (handle) await handle.harness.close(handle.context);
    rmSync(root, { recursive: true, force: true });
  }
});

test("durable admission re-points a reused child at the frontmatter primary", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-repin-"));
  const piDir = join(root, ".pi");
  const databasePath = join(root, "durable.sqlite");
  const { registry, calls, faux } = makeFailoverRegistry(["Primary answer.", "Reversed answer."]);
  const provider = faux.provider.id;
  let handle: Awaited<ReturnType<typeof openDurableHarness>> | undefined;
  try {
    const first = await runDurableTask({
      piDir,
      databasePath,
      taskId: "t-failover-repin",
      task: "First request.",
      modelSpecs: [{ model: `${provider}/primary` }],
      modelRegistry: registry,
    });
    assert.equal(first.answer, "Primary answer.");

    const second = await runDurableTask({
      piDir,
      databasePath,
      taskId: "t-failover-repin",
      task: "Second request.",
      requestId: "pi-task:t-failover-repin:call:second",
      modelSpecs: [{ model: `${provider}/fallback` }, { model: `${provider}/primary` }],
      modelRegistry: registry,
    });
    assert.equal(second.answer, "Reversed answer.");
    assert.equal(second.conversationId, first.conversationId, "the child conversation is reused");
    assert.deepEqual(
      calls,
      ["primary", "fallback"],
      "admission configures the reversed frontmatter primary before submitting",
    );

    handle = await openDurableHarness(piDir, { databasePath });
    const conversation = await handle.harness.conversation(
      second.conversationId as never,
      handle.context,
    );
    assert.ok(conversation);
    assert.deepEqual((await conversation.agent(handle.context)).model, {
      provider,
      modelId: "fallback",
    });
  } finally {
    if (handle) await handle.harness.close(handle.context);
    rmSync(root, { recursive: true, force: true });
  }
});

test("durable failover exhaustion surfaces the original error after each model once", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-failover-exhausted-"));
  const piDir = join(root, ".pi");
  const databasePath = join(root, "durable.sqlite");
  const primaryFailure = fauxAssistantMessage("", {
    stopReason: "error",
    errorMessage: "Monthly usage limit reached",
  });
  const fallbackFailure = fauxAssistantMessage("", {
    stopReason: "error",
    errorMessage: "FreeUsageLimitError: weekly limit",
  });
  const { registry, calls, faux } = makeFailoverRegistry([
    primaryFailure,
    fallbackFailure,
    "This third response must never run.",
  ]);
  const provider = faux.provider.id;
  try {
    await assert.rejects(
      runDurableTask({
        piDir,
        databasePath,
        taskId: "t-failover-exhausted",
        task: "Fail on every configured model.",
        modelSpecs: [
          { model: `${provider}/primary` },
          { model: `${provider}/fallback` },
          { model: `${provider}/primary` },
        ],
        modelRegistry: registry,
      }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(
          message,
          /Monthly usage limit reached/,
          "the original error stays the primary message",
        );
        assert.match(
          message,
          /FreeUsageLimitError: weekly limit/,
          "the last attempt's provider error is preserved",
        );
        return true;
      },
    );
    assert.deepEqual(calls, ["primary", "fallback"], "a duplicate model is never retried");
    assert.equal(faux.getPendingResponseCount(), 1, "the unclaimed third response was never consumed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("durable cancellation never fails over to the next model", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-failover-cancel-"));
  const piDir = join(root, ".pi");
  const databasePath = join(root, "durable.sqlite");
  const { registry, calls, faux } = makeFailoverRegistry(["This answer must not be used."]);
  const provider = faux.provider.id;
  let releaseResult!: () => void;
  let resultReached!: () => void;
  const gate = new Promise<void>((resolve) => { releaseResult = resolve; });
  const started = new Promise<void>((resolve) => { resultReached = resolve; });
  const originalStreamSimple = registry.streamSimple;
  registry.streamSimple = (model, context, options) => {
    const stream = originalStreamSimple(model, context, options);
    const result = stream.result.bind(stream);
    stream.result = async () => {
      resultReached();
      await gate;
      return result();
    };
    return stream;
  };
  const controller = new AbortController();
  let run: ReturnType<typeof runDurableTask> | undefined;
  try {
    run = runDurableTask({
      piDir,
      databasePath,
      taskId: "t-failover-cancel",
      task: "Cancel before any answer.",
      modelSpecs: [{ model: `${provider}/primary` }, { model: `${provider}/fallback` }],
      modelRegistry: registry,
      signal: controller.signal,
    });
    await started;
    controller.abort();
    releaseResult();
    await assert.rejects(run, DurableTaskCancelledError);
    assert.deepEqual(calls, ["primary"], "cancellation never advances the chain");
  } finally {
    releaseResult();
    if (run) await run.catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a steering successor failure never advances the durable model chain", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-failover-steer-"));
  const piDir = join(root, ".pi");
  const databasePath = join(root, "durable.sqlite");
  const steeringFailure = fauxAssistantMessage("", {
    stopReason: "error",
    errorMessage: "permanent follow-up failure",
  });
  const { registry, calls, faux } = makeFailoverRegistry([
    "Initial answer.",
    steeringFailure,
    "The fallback must not run.",
  ]);
  const provider = faux.provider.id;
  let releaseFirst!: () => void;
  let firstStarted!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const firstReached = new Promise<void>((resolve) => { firstStarted = resolve; });
  const originalStreamSimple = registry.streamSimple;
  let streamCount = 0;
  registry.streamSimple = (model, context, options) => {
    const stream = originalStreamSimple(model, context, options);
    if (streamCount++ === 0) {
      const result = stream.result.bind(stream);
      stream.result = async () => {
        firstStarted();
        await firstGate;
        return result();
      };
    }
    return stream;
  };
  let run: ReturnType<typeof runDurableTask> | undefined;
  try {
    run = runDurableTask({
      piDir,
      databasePath,
      taskId: "t-failover-steer",
      task: "Answer before steering.",
      modelSpecs: [{ model: `${provider}/primary` }, { model: `${provider}/fallback` }],
      modelRegistry: registry,
    });
    await firstReached;
    assert.equal(
      await steerDurableTask(piDir, "t-failover-steer", "Refine the answer.", { databasePath }),
      null,
    );
    releaseFirst();
    await assert.rejects(run, /permanent follow-up failure/i);
    assert.deepEqual(
      calls,
      ["primary", "primary"],
      "the steering successor stays on the current model and never advances the chain",
    );
  } finally {
    releaseFirst();
    if (run) await run.catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("an explicit child /model change owns a durable failure instead of the chain", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-failover-model-command-"));
  const piDir = join(root, ".pi");
  const databasePath = join(root, "durable.sqlite");
  const primaryFailure = fauxAssistantMessage("", {
    stopReason: "error",
    errorMessage: "Monthly usage limit reached",
  });
  const { registry, calls, faux } = makeFailoverRegistry([
    primaryFailure,
    "The fallback must not run.",
  ]);
  const provider = faux.provider.id;
  let releaseFirst!: () => void;
  let firstStarted!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const firstReached = new Promise<void>((resolve) => { firstStarted = resolve; });
  const originalStreamSimple = registry.streamSimple;
  let streamCount = 0;
  registry.streamSimple = (model, context, options) => {
    const stream = originalStreamSimple(model, context, options);
    if (streamCount++ === 0) {
      const result = stream.result.bind(stream);
      stream.result = async () => {
        firstStarted();
        await firstGate;
        return result();
      };
    }
    return stream;
  };
  let run: ReturnType<typeof runDurableTask> | undefined;
  try {
    run = runDurableTask({
      piDir,
      databasePath,
      taskId: "t-failover-explicit-model",
      task: "Fail after an explicit model change.",
      modelSpecs: [{ model: `${provider}/primary` }, { model: `${provider}/fallback` }],
      modelRegistry: registry,
    });
    await firstReached;
    const update = await executeDurableChildBuiltinCommand(
      piDir,
      "t-failover-explicit-model",
      {
        name: "model",
        argument: `${provider}/fallback`,
        rawText: `/model ${provider}/fallback`,
      },
      { databasePath, modelRegistry: registry },
    );
    assert.equal(update.level, "info", update.message);
    releaseFirst();
    await assert.rejects(run, /Monthly usage limit reached/);
    assert.deepEqual(
      calls,
      ["primary"],
      "the explicit /model change owns the failure; the chain does not advance",
    );
  } finally {
    releaseFirst();
    if (run) await run.catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("durable models adapter injects an opencode routing session id", () => {
  const captured: Array<Record<string, unknown> | undefined> = [];
  const registry = {
    getAll: () => [],
    find: () => undefined,
    streamSimple: (_model: unknown, _context: unknown, options: Record<string, unknown>) => {
      captured.push(options);
      return {} as never;
    },
  };
  const adapter = createPiRuntimeModels({ current: registry as never }, undefined);

  adapter.streamSimple({ provider: "opencode-go" } as never, { messages: [] }, { apiKey: "k" });
  adapter.streamSimple({ provider: "zai" } as never, { messages: [] }, { apiKey: "k" });
  adapter.streamSimple(
    { provider: "opencode-go" } as never,
    { messages: [] },
    { apiKey: "k", sessionId: "explicit" },
  );

  assert.match(
    String(captured[0]?.sessionId),
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    "opencode gets a bare UUID routing id (opencode rejects a decorated one)",
  );
  assert.equal(captured[1]?.sessionId, undefined, "non-opencode providers are untouched");
  assert.equal(captured[2]?.sessionId, "explicit", "an explicit session id wins");
});

test("durable Codex tasks request detailed reasoning summaries without changing effort", async () => {
  const captured: Array<Record<string, unknown> | undefined> = [];
  const registry = {
    getAll: () => [],
    find: () => undefined,
    streamSimple: (_model: unknown, _context: unknown, options: Record<string, unknown>) => {
      captured.push(options);
      return {} as never;
    },
  };
  const adapter = createPiRuntimeModels({ current: registry as never }, undefined);
  const codexModel = { provider: "openai-codex", api: "openai-codex-responses" };
  let callerHookCalls = 0;

  adapter.streamSimple(codexModel as never, { messages: [] }, {
    apiKey: "test",
    onPayload: (payload: unknown) => {
      callerHookCalls += 1;
      return { ...(payload as Record<string, unknown>), callerMarker: true };
    },
  });

  const onPayload = captured[0]?.onPayload as
    | ((payload: unknown, model: unknown) => unknown | Promise<unknown>)
    | undefined;
  assert.equal(typeof onPayload, "function", "the durable adapter installs a Codex request hook");

  const defaultBody = {
    model: "gpt-6.1-sol",
    reasoning: { effort: "high", summary: "auto" },
  };
  assert.deepEqual(await onPayload!(defaultBody, codexModel), {
    model: "gpt-6.1-sol",
    reasoning: { effort: "high", summary: "detailed" },
    callerMarker: true,
  });
  assert.equal(callerHookCalls, 1, "the caller's existing payload hook is preserved");

  const explicitBody = { reasoning: { effort: "high", summary: "concise" } };
  assert.deepEqual(await onPayload!(explicitBody, codexModel), {
    ...explicitBody,
    callerMarker: true,
  }, "an explicit non-auto summary is respected");

  const disabledBody = { reasoning: { effort: "none", summary: "auto" } };
  assert.deepEqual(await onPayload!(disabledBody, codexModel), {
    ...disabledBody,
    callerMarker: true,
  }, "reasoning-off requests are left unchanged");
  assert.equal(callerHookCalls, 3);

  adapter.streamSimple(
    { provider: "openai", api: "openai-responses" } as never,
    { messages: [] },
    { apiKey: "test" },
  );
  assert.equal(captured[1]?.onPayload, undefined, "other APIs are untouched");
});

test("durable Codex tasks request the priority service tier only under fast mode", async () => {
  const captured: Array<Record<string, unknown> | undefined> = [];
  const registry = {
    getAll: () => [],
    find: () => undefined,
    streamSimple: (_model: unknown, _context: unknown, options: Record<string, unknown>) => {
      captured.push(options);
      return {} as never;
    },
  };
  const codexModel = { provider: "openai-codex", api: "openai-codex-responses" };
  const body = { model: "gpt-6.1-sol", reasoning: { effort: "high", summary: "auto" } };

  const fastAdapter = createPiRuntimeModels(
    { current: registry as never },
    undefined,
    () => true,
  );
  fastAdapter.streamSimple(codexModel as never, { messages: [] }, { apiKey: "test" });
  const fastHook = captured[0]?.onPayload as (p: unknown, m: unknown) => Promise<unknown>;
  assert.deepEqual(await fastHook(body, codexModel), {
    ...body,
    reasoning: { effort: "high", summary: "detailed" },
    service_tier: "priority",
  });

  const normalAdapter = createPiRuntimeModels(
    { current: registry as never },
    undefined,
    () => false,
  );
  normalAdapter.streamSimple(codexModel as never, { messages: [] }, { apiKey: "test" });
  const normalHook = captured[1]?.onPayload as (p: unknown, m: unknown) => Promise<unknown>;
  assert.deepEqual(await normalHook(body, codexModel), {
    ...body,
    reasoning: { effort: "high", summary: "detailed" },
  });

  const defaultAdapter = createPiRuntimeModels({ current: registry as never }, undefined);
  defaultAdapter.streamSimple(codexModel as never, { messages: [] }, { apiKey: "test" });
  const defaultHook = captured[2]?.onPayload as (p: unknown, m: unknown) => Promise<unknown>;
  assert.deepEqual(await defaultHook(body, codexModel), {
    ...body,
    reasoning: { effort: "high", summary: "detailed" },
  }, "fast mode is off unless a predicate says otherwise");
});

test("durable children host requested parent extension tools via the module bridge", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-ext-bridge-"));
  const piDir = join(root, ".pi");
  const databasePath = join(root, "durable.sqlite");
  const fixturePath = join(root, "fixture-research-extension.mjs");
  writeFileSync(
    fixturePath,
    [
      "export default function fixtureExtension(pi) {",
      "  pi.registerTool({",
      '    name: "fixture_websearch",',
      '    description: "Fixture external research tool.",',
      "    parameters: { type: \"object\", properties: {} },",
      "    execute: async () => ({ content: [{ type: \"text\", text: \"fixture ok\" }] }),",
      "  });",
      '  pi.on("session_start", () => {});',
      "}",
    ].join("\n"),
    "utf-8",
  );
  const models = makeModels(["With bridge.", "Without bridge."]);
  let handle: Awaited<ReturnType<typeof openDurableHarness>> | undefined;
  try {
    const withBridge = await runDurableTask({
      piDir,
      databasePath,
      taskId: "t-ext-bridge-with",
      task: "Use the bridged research tool.",
      models,
      tools: ["read", "fixture_websearch"],
      parentExtensionToolSources: { fixture_websearch: fixturePath },
    });
    const withoutBridge = await runDurableTask({
      piDir,
      databasePath,
      taskId: "t-ext-bridge-without",
      task: "No catalog, no bridge.",
      models,
      tools: ["read", "fixture_websearch"],
    });
    handle = await openDurableHarness(piDir, { databasePath });
    const toolNames = async (conversationId: string) => {
      const conversation = await handle!.harness.conversation(
        conversationId as never,
        handle!.context,
      );
      assert.ok(conversation);
      return (await conversation.agent(handle!.context)).tools.map((tool) => tool.name);
    };
    assert.deepEqual(await toolNames(withBridge.conversationId), ["read", "fixture_websearch"]);
    assert.deepEqual(await toolNames(withoutBridge.conversationId), ["read"]);
  } finally {
    if (handle) await handle.harness.close(handle.context);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a later narrower bridge never evicts tools from a running child", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-durable-ext-evict-"));
  const piDir = join(root, ".pi");
  const databasePath = join(root, "durable.sqlite");
  const fixturePath = join(root, "fixture-two-tool-extension.mjs");
  writeFileSync(
    fixturePath,
    [
      "export default function fixtureExtension(pi) {",
      "  for (const name of [\"fixture_websearch\", \"fixture_context7\"]) {",
      "    pi.registerTool({",
      "      name,",
      "      description: `Fixture ${name}.`,",
      "      parameters: { type: \"object\", properties: {} },",
      "      execute: async () => ({ content: [{ type: \"text\", text: \"fixture ok\" }] }),",
      "    });",
      "  }",
      "}",
    ].join("\n"),
    "utf-8",
  );
  const models = makeModels(["First.", "Second."]);
  let handle: Awaited<ReturnType<typeof openDurableHarness>> | undefined;
  try {
    const first = await runDurableTask({
      piDir,
      databasePath,
      taskId: "t-ext-evict-first",
      task: "Bridge the search tool.",
      models,
      tools: ["read", "fixture_websearch"],
      parentExtensionToolSources: {
        fixture_websearch: fixturePath,
        fixture_context7: fixturePath,
      },
    });
    // A second, narrower run must not evict the first child's tool.
    const second = await runDurableTask({
      piDir,
      databasePath,
      taskId: "t-ext-evict-second",
      task: "Bridge a different tool.",
      models,
      tools: ["read", "fixture_context7"],
      parentExtensionToolSources: {
        fixture_websearch: fixturePath,
        fixture_context7: fixturePath,
      },
    });
    handle = await openDurableHarness(piDir, { databasePath });
    const toolNames = async (conversationId: string) => {
      const conversation = await handle!.harness.conversation(
        conversationId as never,
        handle!.context,
      );
      assert.ok(conversation);
      return (await conversation.agent(handle!.context)).tools.map((tool) => tool.name);
    };
    assert.deepEqual(await toolNames(first.conversationId), ["read", "fixture_websearch"]);
    assert.deepEqual(await toolNames(second.conversationId), ["read", "fixture_context7"]);
  } finally {
    if (handle) await handle.harness.close(handle.context);
    rmSync(root, { recursive: true, force: true });
  }
});
