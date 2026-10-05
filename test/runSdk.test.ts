import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  armableTimeoutMs,
  buildSdkResourceLoaderOptions,
  createSdkChildModelRuntime,
  getFinalAssistantResult,
  SdkSubagentInterruptedError,
} from "../src/subagent/runSdk.js";
import {
  assistantOutputProduced,
  classifyModelFailover,
  planModelChain,
  shouldRetrySdkWithNextModel,
} from "../src/model-failover.js";

function tempAgentDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-task-child-runtime-"));
}

test("SDK child resources include parent prompt files without enabling extensions", () => {
  const promptTemplatePaths = ["/tmp/parent-prompt.md"];
  const options = buildSdkResourceLoaderOptions({
    cwd: "/tmp/child",
    agentDir: tempAgentDir(),
    settingsManager: {} as never,
    promptTemplatePaths,
  });
  assert.deepEqual(options.additionalPromptTemplatePaths, promptTemplatePaths);
  assert.equal(options.noExtensions, true, "prompt discovery does not enable parent extensions");
});

test("re-registers extension providers into an isolated child runtime", async () => {
  const config = {
    name: "Fake Prov",
    baseUrl: "https://fake.invalid/v1",
    api: "openai-completions",
    models: [
      {
        id: "fake-model",
        name: "Fake Model",
        reasoning: false,
        input: ["text"],
        contextWindow: 1024,
        maxTokens: 1024,
      },
    ],
  };
  const registry = {
    getRegisteredProviderIds: () => ["fake-prov"],
    getRegisteredProviderConfig: (id: string) => (id === "fake-prov" ? config : undefined),
    getRegisteredNativeProvider: () => undefined,
  };

  const runtime = await createSdkChildModelRuntime(
    { modelRegistry: registry } as any,
    tempAgentDir(),
  );

  assert.ok(runtime);
  assert.deepEqual(runtime.getRegisteredProviderIds(), ["fake-prov"]);
  assert.ok(runtime.getModel("fake-prov", "fake-model"));
});

test("re-registers native extension providers into an isolated child runtime", async () => {
  const native = { id: "fake-native", name: "Fake Native", auth: {} };
  const registry = {
    getRegisteredProviderIds: () => ["fake-native"],
    getRegisteredProviderConfig: () => undefined,
    getRegisteredNativeProvider: (id: string) => (id === "fake-native" ? native : undefined),
  };

  const runtime = await createSdkChildModelRuntime(
    { modelRegistry: registry } as any,
    tempAgentDir(),
  );

  assert.ok(runtime);
  assert.equal(runtime.getRegisteredNativeProvider("fake-native"), native);
});

test("prefers the config form when an id is registered both ways", async () => {
  const config = {
    name: "Dual Prov",
    baseUrl: "https://dual.invalid/v1",
    api: "openai-completions",
    models: [
      {
        id: "dual-model",
        name: "Dual Model",
        reasoning: false,
        input: ["text"],
        contextWindow: 1024,
        maxTokens: 1024,
      },
    ],
  };
  const native = { id: "dual-prov", name: "Dual Prov Native", auth: {} };
  const registry = {
    getRegisteredProviderIds: () => ["dual-prov"],
    getRegisteredProviderConfig: (id: string) => (id === "dual-prov" ? config : undefined),
    getRegisteredNativeProvider: (id: string) => (id === "dual-prov" ? native : undefined),
  };

  const runtime = await createSdkChildModelRuntime(
    { modelRegistry: registry } as any,
    tempAgentDir(),
  );

  assert.ok(runtime);
  assert.ok(runtime.getModel("dual-prov", "dual-model"));
  assert.equal(runtime.getRegisteredNativeProvider("dual-prov"), undefined);
});

test("skips the custom child runtime when the parent has no registered providers", async () => {
  const registry = { getRegisteredProviderIds: () => [] };

  const runtime = await createSdkChildModelRuntime(
    { modelRegistry: registry } as any,
    tempAgentDir(),
  );

  assert.equal(runtime, undefined);
});

test("skips the custom child runtime when the registry lacks the registration API", async () => {
  const runtime = await createSdkChildModelRuntime(
    { modelRegistry: {} } as any,
    tempAgentDir(),
  );

  assert.equal(runtime, undefined);
});

test("accepts the final successful assistant message", () => {
  const result = getFinalAssistantResult([
    { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "stale" }] },
    { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "current" }] },
  ]);
  assert.deepEqual(result, { output: "current" });
});

test("classifies provider errors without reusing earlier assistant text", () => {
  const result = getFinalAssistantResult([
    { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "stale" }] },
    { role: "assistant", stopReason: "error", errorMessage: "rate limit", content: [] },
  ]);
  assert.deepEqual(result, { error: "rate limit" });
});

test("classifies aborted SDK runs", () => {
  const result = getFinalAssistantResult([
    { role: "assistant", stopReason: "aborted", content: [] },
  ]);
  assert.deepEqual(result, { error: "SDK subagent was aborted." });
});

test("rejects a terminal assistant message with no usable output", () => {
  const result = getFinalAssistantResult([
    { role: "assistant", stopReason: "stop", content: [] },
  ]);
  assert.deepEqual(result, { error: "SDK subagent completed without assistant text." });
});

test("does not treat an intermediate tool-use message as a result", () => {
  const result = getFinalAssistantResult([
    { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "partial" }] },
  ]);
  assert.deepEqual(result, { error: "SDK subagent has not reached a terminal result." });
});

test("arms the run timer for a finite timeout", () => {
  assert.equal(armableTimeoutMs(1_000), 1_000);
  assert.equal(armableTimeoutMs(0), 0);
});

test("never arms the run timer for a disabled or non-finite timeout", () => {
  assert.equal(armableTimeoutMs(undefined), undefined);
  assert.equal(armableTimeoutMs(Number.POSITIVE_INFINITY), undefined);
  assert.equal(armableTimeoutMs(Number.NEGATIVE_INFINITY), undefined);
  assert.equal(armableTimeoutMs(Number.NaN), undefined);
});

test("clamps a timeout past the setTimeout range instead of overflowing to 1ms", () => {
  assert.equal(armableTimeoutMs(Number.MAX_SAFE_INTEGER), 2_147_483_647);
});

test("model failover classification follows the approved fallback matrix", () => {
  const fallback = (signal: Parameters<typeof classifyModelFailover>[0]) =>
    classifyModelFailover(signal).fallback;

  // Fallback: clear provider/model failures only.
  assert.equal(fallback({ submissionReason: "model_error", message: "boom" }), true);
  assert.equal(fallback({ submissionReason: "no_model" }), true);
  assert.equal(
    fallback({ message: "durable subagent failed: model_error: 429 too many requests" }),
    true,
    "legacy durable records are classified from their composed reason text",
  );
  assert.equal(fallback({ message: "HTTP 401: invalid api key" }), true);
  assert.equal(fallback({ message: "Request failed with status 503" }), true);
  assert.equal(fallback({ message: "Monthly usage limit reached" }), true);
  assert.equal(fallback({ message: "GoUsageLimitError: weekly limit" }), true);
  assert.equal(
    fallback({ message: 'Model "missing-model" is not available in the model registry' }),
    true,
    "an unknown model is a no_model failure",
  );

  // No fallback: cancellations, aborts, tool failures, lifecycle anomalies.
  assert.equal(fallback({ submissionReason: "aborted", message: "aborted" }), false);
  assert.equal(fallback({ submissionReason: "stale" }), false);
  // Harness faults are lifecycle failures: their arbitrary message text (which
  // may quote a tool's own provider error) must not reach the heuristics.
  assert.equal(
    fallback({ submissionReason: "faulted", message: "Tool summarize failed: rate limit exceeded" }),
    false,
    "a faulted run is a tool/lifecycle failure even when its message mentions a provider error",
  );
  assert.equal(fallback({ submissionReason: "failed", message: "HTTP 401" }), false);
  assert.equal(fallback({ message: "SDK subagent was aborted." }), false);
  assert.equal(fallback({ message: "Tool bash failed: exit code 1" }), false);
  assert.equal(
    fallback({ message: "Durable submissions settled without an assistant answer." }),
    false,
  );
  assert.equal(
    fallback({ message: "Durable submission pi-task:x was placed without an active run." }),
    false,
  );
  assert.equal(fallback({ message: "request timed out waiting for the provider" }), false);
});

test("SDK failover retries only a clean pre-output model error", () => {
  const retry = (
    over: Partial<Parameters<typeof shouldRetrySdkWithNextModel>[0]>,
  ) => shouldRetrySdkWithNextModel({
    error: new Error("rate limit"),
    hadAssistantOutput: false,
    remaining: 1,
    ...over,
  });

  assert.equal(retry({}), true, "a provider error with no assistant output may restart on the next model");
  assert.equal(retry({ error: new Error("Monthly usage limit reached") }), true);
  assert.equal(retry({ hadAssistantOutput: true }), false, "assistant output closes the restart seam");
  assert.equal(retry({ remaining: 0 }), false, "the last model is never retried");
  assert.equal(
    retry({ error: new SdkSubagentInterruptedError("cancelled") }),
    false,
    "cancellation never fails over",
  );
  assert.equal(
    retry({ error: new SdkSubagentInterruptedError("timeout") }),
    false,
    "a timeout never fails over",
  );
  assert.equal(retry({ error: new Error("tool exploded") }), false);
  assert.equal(
    retry({ explicitModelChange: true }),
    false,
    "an explicit /model change owns its failure instead of the chain",
  );
});

test("SDK assistant output detection ignores empty error messages", () => {
  assert.equal(assistantOutputProduced([]), false);
  assert.equal(assistantOutputProduced([{ role: "assistant", content: [] }]), false);
  assert.equal(
    assistantOutputProduced([
      { role: "assistant", stopReason: "error", errorMessage: "rate limit", content: [] },
    ]),
    false,
    "a provider error message without content is not output",
  );
  assert.equal(
    assistantOutputProduced([{ role: "assistant", content: [{ type: "text", text: "partial" }] }]),
    true,
  );
  assert.equal(
    assistantOutputProduced([{ role: "assistant", content: [{ type: "toolCall", id: "c", name: "read" }] }]),
    true,
  );
  assert.equal(assistantOutputProduced([{ role: "user", content: "hi" }]), false);
});

test("model chains preserve strict frontmatter order and drop duplicates", () => {
  assert.deepEqual(planModelChain(undefined), []);
  assert.deepEqual(
    planModelChain([
      { model: "a/one", thinking: "max" },
      { model: " a/one " },
      { model: "b/two" },
      { model: "" },
    ]),
    [{ model: "a/one", thinking: "max" }, { model: "b/two" }],
  );
});

test("skips providers whose stored config fails re-registration", async () => {
  const goodConfig = {
    name: "Good Prov",
    baseUrl: "https://good.invalid/v1",
    api: "openai-completions",
    models: [
      {
        id: "good-model",
        name: "Good Model",
        reasoning: false,
        input: ["text"],
        contextWindow: 1024,
        maxTokens: 1024,
      },
    ],
  };
  const registry = {
    getRegisteredProviderIds: () => ["broken", "good"],
    getRegisteredProviderConfig: (id: string) => {
      if (id === "broken") throw new Error("bad stored config");
      return id === "good" ? goodConfig : undefined;
    },
    getRegisteredNativeProvider: () => undefined,
  };

  const runtime = await createSdkChildModelRuntime(
    { modelRegistry: registry } as any,
    tempAgentDir(),
  );

  assert.ok(runtime, "a broken provider must not kill the subagent runtime");
  assert.deepEqual(runtime.getRegisteredProviderIds(), ["good"]);
  assert.ok(runtime.getModel("good", "good-model"));
});
