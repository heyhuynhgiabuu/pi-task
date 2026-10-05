import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  executeDurableChildBuiltinCommand,
  openDurableHarness,
  readDurableTaskHistoryTranscript,
  readDurableTaskHistoryTranscriptForOwner,
  runDurableTask,
} from "../src/subagent/durable.js";
import { readTaskSessionHistory, upsertTaskSessionHistory } from "../src/conversation.js";
import { executeSdkChildBuiltinCommand } from "../src/subagent/runSdk.js";
import type { ChildBuiltinCommand, TaskSessionHistoryEntry } from "../src/types.js";

function command(name: string, argument = ""): ChildBuiltinCommand {
  const suffix = argument ? ` ${argument}` : "";
  return { name, argument, rawText: `/${name}${suffix}` };
}

test("SDK child built-ins call only the passed AgentSession and never persist global defaults", async () => {
  const model1 = { provider: "openai", id: "gpt-1", name: "GPT 1" };
  const model2 = { provider: "openai", id: "gpt-2", name: "GPT 2" };
  const calls: Array<{ kind: string; value: unknown; options?: unknown }> = [];
  let sessionName: string | undefined;
  const session = {
    modelRuntime: { getAvailableSnapshot: () => [model1, model2] },
    scopedModels: [],
    model: model1,
    thinkingLevel: "off",
    sessionName,
    sessionId: "sdk-child-session",
    sessionManager: { getSessionName: () => sessionName },
    getAvailableThinkingLevels: () => ["off", "low", "medium"],
    setModel: async (model: unknown, options: unknown) => calls.push({ kind: "model", value: model, options }),
    setThinkingLevel: (level: unknown, options: unknown) => calls.push({ kind: "thinking", value: level, options }),
    setSessionName: (name: string) => {
      sessionName = name;
      calls.push({ kind: "name", value: name });
    },
    getSessionStats: () => ({
      sessionFile: "/tmp/sdk-child.jsonl",
      sessionId: "sdk-child-session",
      userMessages: 2,
      assistantMessages: 1,
      toolCalls: 1,
      toolResults: 1,
      totalMessages: 5,
      tokens: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, total: 30 },
      cost: 0.02,
    }),
  };

  const modelResult = await executeSdkChildBuiltinCommand(session as never, command("model", "openai/gpt-2"));
  const thinkingResult = await executeSdkChildBuiltinCommand(session as never, command("thinking", "medium"));
  const modelSelector = await executeSdkChildBuiltinCommand(session as never, command("model"));
  const thinkingSelector = await executeSdkChildBuiltinCommand(session as never, command("thinking"));
  const nameResult = await executeSdkChildBuiltinCommand(session as never, command("name", "Review child"));
  const sessionResult = await executeSdkChildBuiltinCommand(session as never, command("session"));

  assert.equal(modelResult.level, "info");
  assert.equal(thinkingResult.level, "info");
  assert.equal(nameResult.level, "info");
  assert.deepEqual(modelSelector.selector, {
    kind: "model",
    models: [
      { provider: "openai", id: "gpt-1", name: "GPT 1" },
      { provider: "openai", id: "gpt-2", name: "GPT 2" },
    ],
    currentModel: { provider: "openai", id: "gpt-1" },
  }, "no-argument /model returns a structured child catalog and current model");
  assert.deepEqual(thinkingSelector.selector, {
    kind: "thinking",
    currentLevel: "off",
    levels: ["off", "low", "medium"],
  }, "no-argument /thinking returns canonical supported child levels");
  assert.deepEqual(calls, [
    { kind: "model", value: model2, options: { persist: false } },
    { kind: "thinking", value: "medium", options: { persist: false } },
    { kind: "name", value: "Review child" },
  ]);
  assert.match(sessionResult.message, /sdk-child-session/);
  assert.deepEqual(sessionResult.sessionInfo, {
    sessionId: "sdk-child-session",
    sessionName: "Review child",
    storagePath: "/tmp/sdk-child.jsonl",
    model: "openai/gpt-1",
    thinkingLevel: "off",
    counts: {
      scope: "session",
      userMessages: 2,
      assistantMessages: 1,
      toolCalls: 1,
      toolResults: 1,
      totalMessages: 5,
    },
    tokens: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, total: 30 },
    cost: 0.02,
  }, "SDK /session returns structured data from the child's own SessionStats");

  const invalid = await executeSdkChildBuiltinCommand(session as never, command("model", "unknown/model"));
  assert.equal(invalid.level, "error");
  assert.equal(calls.length, 3, "an unknown model does not invoke the child's model setter or any parent API");
});

test("durable model command reconfigures only the running child conversation", async () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-durable-child-command-"));
  const models = createModels();
  const faux = fauxProvider({ models: [{ id: "faux-1" }, { id: "faux-2" }] });
  faux.setResponses([fauxAssistantMessage("Task complete.")]);
  models.setProvider(faux.provider);
  let reachedResult!: () => void;
  let releaseResult!: () => void;
  const resultReached = new Promise<void>((resolve) => { reachedResult = resolve; });
  const resultGate = new Promise<void>((resolve) => { releaseResult = resolve; });
  const originalStreamSimple = models.streamSimple.bind(models);
  models.streamSimple = (model, context, options) => {
    const stream = originalStreamSimple(model, context, options);
    const originalResult = stream.result.bind(stream);
    stream.result = async () => {
      reachedResult();
      await resultGate;
      return originalResult();
    };
    return stream;
  };
  const modelFactory = () => models;
  let conversationId: string | undefined;
  let run: ReturnType<typeof runDurableTask> | undefined;
  let handle: Awaited<ReturnType<typeof openDurableHarness>> | undefined;
  try {
    run = runDurableTask({
      piDir,
      taskId: "child-command-task",
      task: "Finish this test task.",
      models: modelFactory,
      onSubmitted: (id) => { conversationId = id; },
    });
    await resultReached;
    assert.ok(conversationId, "the child conversation was admitted before the command runs");

    const update = await executeDurableChildBuiltinCommand(
      piDir,
      "child-command-task",
      command("model", `${faux.provider.id}/faux-2`),
      { models: modelFactory },
    );
    assert.equal(update.level, "info", update.message);

    const modelSelector = await executeDurableChildBuiltinCommand(
      piDir,
      "child-command-task",
      command("model"),
      { models: modelFactory },
    );
    assert.equal(modelSelector.selector?.kind, "model");
    assert.deepEqual(modelSelector.selector?.currentModel, {
      provider: faux.provider.id,
      id: "faux-2",
    });
    assert.deepEqual(
      modelSelector.selector?.models.map(({ provider, id }) => `${provider}/${id}`),
      [`${faux.provider.id}/faux-1`, `${faux.provider.id}/faux-2`],
      "the picker receives the structured live child model catalog",
    );

    handle = await openDurableHarness(piDir, { models: modelFactory });
    const conversation = await handle.harness.conversation(conversationId as never, handle.context);
    assert.ok(conversation);
    assert.deepEqual((await conversation.agent(handle.context)).model, {
      provider: faux.provider.id,
      modelId: "faux-2",
    });

    releaseResult();
    await run;
    const settledUpdate = await executeDurableChildBuiltinCommand(
      piDir,
      "child-command-task",
      command("model", `${faux.provider.id}/faux-1`),
      { models: modelFactory },
    );
    assert.equal(settledUpdate.level, "error");
    assert.deepEqual((await conversation.agent(handle.context)).model, {
      provider: faux.provider.id,
      modelId: "faux-2",
    }, "a stale task row cannot reconfigure a settled child");
  } finally {
    releaseResult();
    if (run) await run.catch(() => {});
    if (handle) await handle.harness.close(handle.context);
    rmSync(piDir, { recursive: true, force: true });
  }
});

test("durable /session remains read-only and reports stored cache totals after settlement", async () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-durable-session-info-"));
  const models = createModels();
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  faux.setResponses([fauxAssistantMessage("Task complete.")]);
  models.setProvider(faux.provider);
  const modelFactory = () => models;
  let handle: Awaited<ReturnType<typeof openDurableHarness>> | undefined;
  try {
    const result = await runDurableTask({
      piDir,
      taskId: "child-session-info-task",
      task: "Finish this test task.",
      cwd: "/work/child",
      models: modelFactory,
    });
    handle = await openDurableHarness(piDir, { models: modelFactory });
    const conversation = await handle.harness.conversation(result.conversationId as never, handle.context);
    assert.ok(conversation);
    await conversation.commit(async (tx) => {
      const usage = await tx.doc(handle!.usageDoc, conversation.id);
      usage.models[`${faux.provider.id}/faux-1`] = {
        input: 100,
        output: 25,
        cacheRead: 40,
        cacheWrite: 50,
        totalTokens: 125,
        cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.004, total: 0.037 },
      };
    }, handle.context);

    const info = await executeDurableChildBuiltinCommand(
      piDir,
      "child-session-info-task",
      command("session"),
      { models: modelFactory },
    );
    assert.equal(info.level, "info", "settled durable /session is read-only, not a mutation");
    assert.deepEqual(info.sessionInfo, {
      sessionId: result.conversationId,
      storagePath: join(piDir, "durable", "tasks.sqlite"),
      model: `${faux.provider.id}/faux-1`,
      thinkingLevel: "off",
      cwd: "/work/child",
      counts: {
        scope: "current context",
        userMessages: 1,
        assistantMessages: 1,
        toolCalls: 0,
        toolResults: 0,
        totalMessages: 3,
      },
      tokens: { input: 100, output: 25, cacheRead: 40, cacheWrite: 50, total: 215 },
      cost: 0.037,
    }, "durable /session reports the raw pi.usage cache counters without dropping them");

    const mutation = await executeDurableChildBuiltinCommand(
      piDir,
      "child-session-info-task",
      command("thinking", "high"),
      { models: modelFactory },
    );
    assert.equal(mutation.level, "error", "a settled child remains immutable");
  } finally {
    if (handle) await handle.harness.close(handle.context);
    rmSync(piDir, { recursive: true, force: true });
  }
});

test("durable /resume lists all mapped project child tasks and snapshots history read-only", async () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-durable-resume-history-"));
  const models = createModels();
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  faux.setResponses([
    ...["Current", "Sibling", "Foreign", "Older-session", "Prior-leaf", "Spoof-map", "SDK", "Claude"]
      .map((label) => fauxAssistantMessage(`${label} transcript body.`)),
  ]);
  models.setProvider(faux.provider);
  const modelFactory = () => models;
  let handle: Awaited<ReturnType<typeof openDurableHarness>> | undefined;
  let activeRun: ReturnType<typeof runDurableTask> | undefined;
  let releaseActiveResult: (() => void) | undefined;
  try {
    const completed = new Map<string, string>();
    for (const id of [
      "resume-current",
      "resume-sibling",
      "resume-foreign",
      "resume-older-session",
      "resume-prior-leaf",
      "resume-spoof-map",
      "resume-sdk",
      "resume-claude",
    ]) {
      const result = await runDurableTask({ piDir, taskId: id, task: `${id} task`, models: modelFactory });
      completed.set(id, result.conversationId);
    }

    handle = await openDurableHarness(piDir, { models: modelFactory });
    const root = await handle.harness.root(handle.context);
    const record = (
      id: string,
      conversationId: string,
      ownerSessionId: string,
      ownerLeafId: string,
      extra: Partial<TaskSessionHistoryEntry> = {},
    ): TaskSessionHistoryEntry => ({
      id,
      agentType: "general",
      description: `${id} description`,
      sessionName: `${id} session`,
      startedAt: 1000,
      piDir,
      dir: join(piDir, "artifacts", "tasks", id),
      cwd: "/work/child",
      conversationId,
      background: true,
      backend: "durable",
      ownerSessionId,
      ownerLeafId,
      status: "done",
      completedAt: 2000 + id.length,
      ...extra,
    });
    const entries = [
      record("resume-current", completed.get("resume-current")!, "parent-a", "leaf-a"),
      record("resume-sibling", completed.get("resume-sibling")!, "parent-a", "leaf-a", { startedAt: 2000 }),
      record("resume-foreign", completed.get("resume-foreign")!, "previous-parent-session", "previous-leaf", { startedAt: 1800 }),
      record("resume-older-session", completed.get("resume-older-session")!, "older-parent-session", "older-leaf", { startedAt: 500 }),
      record("resume-prior-leaf", completed.get("resume-prior-leaf")!, "parent-a", "prior-turn-leaf", { startedAt: 1500 }),
      // This entry claims another mapped task's conversation, so byOwner rejects it.
      record("resume-spoof-map", completed.get("resume-foreign")!, "parent-a", "leaf-a"),
      record("resume-sdk", completed.get("resume-sdk")!, "parent-a", "leaf-a", { backend: "sdk" }),
      record("resume-claude", completed.get("resume-claude")!, "parent-a", "leaf-a", { runtime: "claude" }),
      // Root and untracked/internal conversations have no task-specific byOwner record.
      record("resume-root", String(root.id), "parent-a", "leaf-a"),
      record("resume-orphan", "unmapped-internal-conversation", "parent-a", "leaf-a"),
    ];
    for (const entry of entries) upsertTaskSessionHistory(piDir, entry);

    let activeConversationId = "";
    let reachedActiveResult!: () => void;
    const activeResultReached = new Promise<void>((resolve) => { reachedActiveResult = resolve; });
    let unblockActiveResult!: () => void;
    const activeResultGate = new Promise<void>((resolve) => { unblockActiveResult = resolve; });
    releaseActiveResult = unblockActiveResult;
    faux.setResponses([fauxAssistantMessage("Active transcript body.")]);
    const originalStreamSimple = models.streamSimple.bind(models);
    models.streamSimple = (model, context, options) => {
      const stream = originalStreamSimple(model, context, options);
      const originalResult = stream.result.bind(stream);
      stream.result = async () => {
        reachedActiveResult();
        await activeResultGate;
        return originalResult();
      };
      return stream;
    };
    activeRun = runDurableTask({
      piDir,
      taskId: "resume-active",
      task: "active historical child task",
      models: modelFactory,
      onSubmitted: (conversationId) => { activeConversationId = conversationId; },
    });
    await activeResultReached;
    assert.ok(activeConversationId, "the candidate active child was durably admitted");
    upsertTaskSessionHistory(
      piDir,
      record("resume-active", activeConversationId, "previous-parent-session", "active-leaf", {
        status: "running",
        completedAt: undefined,
        startedAt: 2500,
      }),
    );

    const picker = await executeDurableChildBuiltinCommand(piDir, "resume-current", command("resume"), {
      models: modelFactory,
    });
    assert.equal(picker.level, "info", picker.message);
    assert.deepEqual(picker.historyPicker?.sessions.map(({ taskId }) => taskId), [
      "resume-active",
      "resume-sibling",
      "resume-foreign",
      "resume-prior-leaf",
      "resume-current",
      "resume-older-session",
    ], "all mapped durable Pi children in this project appear newest-first across parent sessions and leaves");
    assert.equal(picker.historyPicker?.currentTaskId, "resume-current");
    for (const excluded of ["resume-spoof-map", "resume-sdk", "resume-claude", "resume-root", "resume-orphan"]) {
      assert.ok(!picker.historyPicker?.sessions.some(({ taskId }) => taskId === excluded), `${excluded} is excluded`);
    }
    await assert.rejects(
      readDurableTaskHistoryTranscript(piDir, "resume-current", "resume-spoof-map", { models: modelFactory }),
      /not in this task's attributed history/,
      "the snapshot reader independently enforces the byOwner mapping",
    );
    await assert.rejects(
      readDurableTaskHistoryTranscriptForOwner(piDir, "parent-a", "resume-foreign", { models: modelFactory }),
      /not attributed to this parent session/,
      "the /agents adapter refuses a durable task owned by another parent session",
    );
    const currentOwned = await readDurableTaskHistoryTranscriptForOwner(
      piDir,
      "parent-a",
      "resume-current",
      { models: modelFactory },
    );
    assert.ok(currentOwned.items.some((item) => item.type === "user" && item.text.includes("resume-current task")));

    const activeConversation = await handle.harness.conversation(activeConversationId as never, handle.context);
    assert.ok(activeConversation);
    const beforeRuns = await handle.harness.snapshot(handle.runsDoc, activeConversation.id, handle.context);
    const before = readTaskSessionHistory(piDir).map(({ id, status, conversationId }) => ({ id, status, conversationId }));
    const historical = await readDurableTaskHistoryTranscript(
      piDir,
      "resume-current",
      "resume-active",
      { models: modelFactory },
    );
    const after = readTaskSessionHistory(piDir).map(({ id, status, conversationId }) => ({ id, status, conversationId }));
    const afterRuns = await handle.harness.snapshot(handle.runsDoc, activeConversation.id, handle.context);
    assert.equal(historical.option.taskId, "resume-active");
    assert.equal(historical.option.status, "running", "an active foreign-owner task is browseable as a snapshot");
    assert.ok(historical.items.some((item) => item.type === "user" && item.text.includes("active historical child task")));
    assert.deepEqual(after, before, "browsing a history snapshot does not alter task lifecycle metadata");
    assert.deepEqual(afterRuns, beforeRuns, "browsing a foreign active child does not mutate its durable run state");
  } finally {
    releaseActiveResult?.();
    if (activeRun) await activeRun.catch(() => {});
    if (handle) await handle.harness.close(handle.context);
    rmSync(piDir, { recursive: true, force: true });
  }
});

test("durable thinking commands follow Pi's canonical thinkingLevelMap rule", async () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-durable-thinking-"));
  const models = createModels();
  // The claude-opus-4-6 style map maps only `max`: Pi accepts xhigh only when
  // a model maps it explicitly, and max only when it is mapped at all.
  const faux = fauxProvider({ models: [{ id: "claude-opus-4-6-style", reasoning: true }] });
  faux.models[0].thinkingLevelMap = { max: "max" };
  faux.setResponses([fauxAssistantMessage("Task complete.")]);
  models.setProvider(faux.provider);
  let reachedResult!: () => void;
  let releaseResult!: () => void;
  const resultReached = new Promise<void>((resolve) => { reachedResult = resolve; });
  const resultGate = new Promise<void>((resolve) => { releaseResult = resolve; });
  const originalStreamSimple = models.streamSimple.bind(models);
  models.streamSimple = (model, context, options) => {
    const stream = originalStreamSimple(model, context, options);
    const originalResult = stream.result.bind(stream);
    stream.result = async () => {
      reachedResult();
      await resultGate;
      return originalResult();
    };
    return stream;
  };
  const modelFactory = () => models;
  let run: ReturnType<typeof runDurableTask> | undefined;
  try {
    run = runDurableTask({
      piDir,
      taskId: "child-thinking-task",
      task: "Finish this test task.",
      models: modelFactory,
    });
    await resultReached;

    const xhigh = await executeDurableChildBuiltinCommand(
      piDir,
      "child-thinking-task",
      command("thinking", "xhigh"),
      { models: modelFactory },
    );
    assert.equal(xhigh.level, "error", "an unmapped xhigh is not a supported thinking level");
    assert.match(xhigh.message, /Available levels: off, minimal, low, medium, high, max/);

    const max = await executeDurableChildBuiltinCommand(
      piDir,
      "child-thinking-task",
      command("thinking", "max"),
      { models: modelFactory },
    );
    assert.equal(max.level, "info", max.message);

    const selector = await executeDurableChildBuiltinCommand(
      piDir,
      "child-thinking-task",
      command("thinking"),
      { models: modelFactory },
    );
    assert.deepEqual(selector.selector, {
      kind: "thinking",
      currentLevel: "max",
      levels: ["off", "minimal", "low", "medium", "high", "max"],
    }, "the selector uses Pi's canonical supported-level list, not assistant text");
  } finally {
    releaseResult();
    if (run) await run.catch(() => {});
    rmSync(piDir, { recursive: true, force: true });
  }
});

test("durable compact admits a manual compaction for the active child and refuses a settled one", async () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-durable-compact-"));
  const models = createModels();
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  faux.setResponses([fauxAssistantMessage("Task complete."), fauxAssistantMessage("Summary.")]);
  models.setProvider(faux.provider);
  let reachedResult!: () => void;
  let releaseResult!: () => void;
  const resultReached = new Promise<void>((resolve) => { reachedResult = resolve; });
  const resultGate = new Promise<void>((resolve) => { releaseResult = resolve; });
  const originalStreamSimple = models.streamSimple.bind(models);
  models.streamSimple = (model, context, options) => {
    const stream = originalStreamSimple(model, context, options);
    const originalResult = stream.result.bind(stream);
    stream.result = async () => {
      reachedResult();
      await resultGate;
      return originalResult();
    };
    return stream;
  };
  const modelFactory = () => models;
  let run: ReturnType<typeof runDurableTask> | undefined;
  try {
    run = runDurableTask({
      piDir,
      taskId: "child-compact-task",
      task: "Finish this test task.",
      models: modelFactory,
    });
    await resultReached;

    const admitted = await executeDurableChildBuiltinCommand(
      piDir,
      "child-compact-task",
      command("compact", "keep the failing test names"),
      { models: modelFactory },
    );
    assert.equal(admitted.level, "info", admitted.message);
    assert.match(admitted.message, /Compaction admitted/);
    assert.match(admitted.message, /may finish after this view closes/);
    assert.match(admitted.message, /progress is not shown/);
    assert.match(admitted.message, /Task completion may be delayed until compaction finishes/);

    releaseResult();
    await run;
    const settled = await executeDurableChildBuiltinCommand(
      piDir,
      "child-compact-task",
      command("compact"),
      { models: modelFactory },
    );
    assert.equal(settled.level, "error");
    assert.match(settled.message, /no longer active/i);
  } finally {
    releaseResult();
    if (run) await run.catch(() => {});
    rmSync(piDir, { recursive: true, force: true });
  }
});
