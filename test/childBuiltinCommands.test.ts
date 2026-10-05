import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { executeDurableChildBuiltinCommand, openDurableHarness, runDurableTask } from "../src/subagent/durable.js";
import { executeSdkChildBuiltinCommand } from "../src/subagent/runSdk.js";
import type { ChildBuiltinCommand } from "../src/types.js";

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
  const nameResult = await executeSdkChildBuiltinCommand(session as never, command("name", "Review child"));
  const sessionResult = await executeSdkChildBuiltinCommand(session as never, command("session"));

  assert.equal(modelResult.level, "info");
  assert.equal(thinkingResult.level, "info");
  assert.equal(nameResult.level, "info");
  assert.deepEqual(calls, [
    { kind: "model", value: model2, options: { persist: false } },
    { kind: "thinking", value: "medium", options: { persist: false } },
    { kind: "name", value: "Review child" },
  ]);
  assert.match(sessionResult.message, /sdk-child-session/);
  assert.match(sessionResult.message, /30/);

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
