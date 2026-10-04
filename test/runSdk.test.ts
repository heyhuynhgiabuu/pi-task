import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  armableTimeoutMs,
  createSdkChildModelRuntime,
  getFinalAssistantResult,
} from "../src/subagent/runSdk.js";

function tempAgentDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-task-child-runtime-"));
}

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
