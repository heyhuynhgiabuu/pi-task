import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildBaseOptions as buildNativeBaseOptions } from "@earendil-works/pi-ai/api/simple-options";
import taskExtension, * as taskModule from "../src/index.js";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { createTaskFastModeStream } from "../src/fast-mode.js";
import type { AgentConfig } from "../src/helpers.js";
import {
  buildPiArgv,
  type BuildPiArgvOptions,
} from "../src/subagent/buildArgv.js";
import {
  buildSdkResourceLoaderOptions,
} from "../src/subagent/runSdk.js";
import { taskParametersSchema } from "../src/tool/schema.js";

const agent: AgentConfig = {
  name: "test",
  description: "test agent",
  body: "",
  source: "bundled",
  path: "/agents/test.md",
};

const baseArgvOptions: BuildPiArgvOptions = {
  agent,
  sessionName: "task-fast-test",
  sessionDir: "/tmp/task-fast-test",
  promptContent: "perform the task",
};

function createFastStreamHarness(models: string[]) {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-task-fast-options-"));
  const configDir = join(agentDir, "extensions");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "pi-codex-fast.json"), JSON.stringify({ models }));

  const calls: Array<{ model: unknown; context: unknown; options: Record<string, unknown> }> = [];
  const capture = (model: unknown, context: unknown, options: unknown) => {
    calls.push({ model, context, options: options as Record<string, unknown> });
    return {} as never;
  };
  const stream = createTaskFastModeStream(agentDir, {
    streamOpenAIResponses: capture,
    streamSimpleOpenAIResponses: capture,
    streamOpenAICodexResponses: capture,
    streamSimpleOpenAICodexResponses: capture,
  });
  return { agentDir, calls, stream };
}

test("task schema advertises an optional fast boolean", () => {
  const schema = taskParametersSchema() as {
    properties?: Record<string, { type?: string; description?: string; default?: boolean }>;
    required?: string[];
  };
  const fast = schema.properties?.fast;

  assert.ok(fast);
  assert.equal(fast.type, "boolean");
  assert.match(fast.description ?? "", /priority service tier/i);
  assert.equal(fast.default, undefined);
  assert.equal(Boolean(schema.required?.includes("fast")), false);
});

test("terminal argv isolates every fast task and preserves env-controlled isolation", () => {
  const previousNoExtensions = process.env.PI_TASK_CHILD_NO_EXTENSIONS;
  const options = {
    ...baseArgvOptions,
    fast: true,
    fastExtensionPath: "/fork/dist/index.js",
  } as BuildPiArgvOptions & { fast: boolean; fastExtensionPath: string };

  try {
    delete process.env.PI_TASK_CHILD_NO_EXTENSIONS;
    const fastArgs = buildPiArgv(options);
    const normalArgs = buildPiArgv({ ...options, fast: false });

    const extensionIndex = fastArgs.indexOf("--extension");
    assert.notEqual(extensionIndex, -1);
    assert.deepEqual(
      fastArgs.slice(extensionIndex, extensionIndex + 3),
      ["--extension", "/fork/dist/index.js", "--fast"],
    );
    assert.equal(fastArgs.filter((arg) => arg === "--no-extensions").length, 1);
    assert.equal(normalArgs.filter((arg) => arg === "--no-extensions").length, 0);
    assert.equal(normalArgs.includes("--fast"), false);
    assert.equal(normalArgs.includes("/fork/dist/index.js"), false);
    assert.equal(fastArgs.includes("--model"), false);
    assert.equal(fastArgs.includes("--thinking"), false);

    process.env.PI_TASK_CHILD_NO_EXTENSIONS = "1";
    const fastArgsWithEnv = buildPiArgv(options);
    const normalArgsWithEnv = buildPiArgv({ ...options, fast: false });
    assert.equal(fastArgsWithEnv.filter((arg) => arg === "--no-extensions").length, 1);
    assert.equal(normalArgsWithEnv.filter((arg) => arg === "--no-extensions").length, 1);
  } finally {
    if (previousNoExtensions === undefined) delete process.env.PI_TASK_CHILD_NO_EXTENSIONS;
    else process.env.PI_TASK_CHILD_NO_EXTENSIONS = previousNoExtensions;
  }
});

test("PI_TASK_TOOL_DISABLED child registers fast providers after real flag application and startup", async () => {
  const previousDisabled = process.env.PI_TASK_TOOL_DISABLED;
  process.env.PI_TASK_TOOL_DISABLED = "1";
  const cwd = mkdtempSync(join(tmpdir(), "pi-task-fast-cwd-"));
  const agentDir = mkdtempSync(join(tmpdir(), "pi-task-fast-agent-"));

  try {
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      extensionFlagValues: new Map([["fast", true]]),
      resourceLoaderOptions: {
        noExtensions: true,
        extensionFactories: [{ name: "pi-task-terminal", factory: taskExtension }],
      },
    });

    // The old factory-time getFlag() read leaves the bridge absent here and after startup.
    assert.deepEqual(services.modelRuntime.getRegisteredProviderIds(), []);

    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(cwd),
      noTools: "all",
    });
    try {
      await session.bindExtensions({});
      assert.deepEqual(
        new Set(services.modelRuntime.getRegisteredProviderIds()),
        new Set(["openai", "openai-codex"]),
      );
      assert.equal(
        services.modelRuntime.getRegisteredProviderConfig("openai")?.api,
        "openai-responses",
      );
      assert.equal(
        services.modelRuntime.getRegisteredProviderConfig("openai-codex")?.api,
        "openai-codex-responses",
      );
    } finally {
      session.dispose();
    }
  } finally {
    if (previousDisabled === undefined) delete process.env.PI_TASK_TOOL_DISABLED;
    else process.env.PI_TASK_TOOL_DISABLED = previousDisabled;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("SDK loader keeps extensions disabled and injects fast bridge only when requested", () => {
  const fast = buildSdkResourceLoaderOptions({
    cwd: "/repo",
    agentDir: "/agent",
    settingsManager: {} as never,
    systemPrompt: "child prompt",
    fast: true,
  });
  const normal = buildSdkResourceLoaderOptions({
    cwd: "/repo",
    agentDir: "/agent",
    settingsManager: {} as never,
    systemPrompt: "child prompt",
    fast: false,
  });

  assert.equal(fast.noExtensions, true);
  assert.equal(fast.extensionFactories?.length, 1);
  assert.equal(fast.extensionFactories?.[0]?.name, "pi-task-fast-mode");
  assert.equal(normal.noExtensions, true);
  assert.deepEqual(normal.extensionFactories ?? [], []);
});

test("configured fast models preserve native options and add only priority", () => {
  const { agentDir, calls, stream } = createFastStreamHarness([
    "openai/gpt-fast",
    "openai-codex/gpt-fast",
  ]);
  const openAIModel = {
    provider: "openai",
    id: "gpt-fast",
    api: "openai-responses",
    maxTokens: 131_072,
    contextWindow: 400_000,
    reasoning: true,
  };
  const codexModel = {
    ...openAIModel,
    provider: "openai-codex",
    api: "openai-codex-responses",
  };
  const context = { messages: [] };
  const options = {
    reasoning: "high" as const,
    maxTokens: 20_000,
    apiKey: "test-key",
    env: { HTTPS_PROXY: "http://proxy.test" },
    websocketConnectTimeoutMs: 12_345,
  };

  try {
    stream(openAIModel as never, context, options);
    stream(codexModel as never, context, options);

    assert.equal(calls[0]?.model, openAIModel);
    assert.equal(calls[1]?.model, codexModel);
    assert.deepEqual(calls[0]?.options, {
      ...buildNativeBaseOptions(openAIModel as never, context, options, options.apiKey),
      reasoningEffort: "high",
      serviceTier: "priority",
    });
    assert.deepEqual(calls[1]?.options, {
      ...buildNativeBaseOptions(codexModel as never, context, options, options.apiKey),
      reasoningEffort: "high",
      serviceTier: "priority",
    });
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("unlisted and unsupported models use their normal streamer", () => {
  const { agentDir, calls, stream } = createFastStreamHarness(["openai/gpt-fast"]);
  const model = {
    provider: "openai",
    id: "gpt-normal",
    api: "openai-responses",
    maxTokens: 64_000,
    contextWindow: 400_000,
    reasoning: true,
  };
  const unsupported = {
    provider: "anthropic",
    id: "gpt-fast",
    api: "openai-responses",
    maxTokens: 64_000,
    contextWindow: 400_000,
    reasoning: true,
  };

  try {
    const normalOptions = { reasoning: "low" as const };
    const unsupportedOptions = { reasoning: "medium" as const };
    const normalResult = stream(model as never, { messages: [] }, normalOptions);
    const unsupportedResult = stream(unsupported as never, { messages: [] }, unsupportedOptions);

    assert.ok(normalResult);
    assert.ok(unsupportedResult);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.options, normalOptions);
    assert.equal(calls[1]?.options, unsupportedOptions);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("fast mode ignores config enabled and never writes config", () => {
  const registerBridge = (
    taskModule as unknown as {
      registerTaskFastModeBridge?: (pi: unknown, deps: unknown) => void;
    }
  ).registerTaskFastModeBridge;
  assert.equal(typeof registerBridge, "function");

  const agentDir = mkdtempSync(join(tmpdir(), "pi-task-fast-mode-"));
  const configDir = join(agentDir, "extensions");
  const configPath = join(configDir, "pi-codex-fast.json");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify({ enabled: false, models: ["openai/gpt-fast"] }, null, 2) + "\n",
    "utf8",
  );
  const before = readFileSync(configPath, "utf8");
  const priorityCalls: Array<Record<string, unknown>> = [];
  const normalCalls: Array<Record<string, unknown>> = [];
  const providers = new Map<string, { streamSimple: (...args: unknown[]) => unknown }>();
  const resultToken = {};

  try {
    registerBridge!({
      registerProvider(name: string, config: { streamSimple: (...args: unknown[]) => unknown }) {
        providers.set(name, config);
      },
      on() {},
    }, {
      agentDir,
      streamers: {
        streamOpenAIResponses(_model: unknown, _context: unknown, options: Record<string, unknown>) {
          priorityCalls.push(options);
          return resultToken;
        },
        streamSimpleOpenAIResponses(_model: unknown, _context: unknown, options: Record<string, unknown>) {
          normalCalls.push(options);
          return resultToken;
        },
        streamOpenAICodexResponses() {
          return resultToken;
        },
        streamSimpleOpenAICodexResponses() {
          return resultToken;
        },
      },
    });

    const stream = providers.get("openai")?.streamSimple;
    assert.ok(stream);
    assert.equal(stream({
      provider: "openai",
      id: "gpt-fast",
      api: "openai-responses",
      maxTokens: 64_000,
      reasoning: true,
    }, { messages: [] }, { reasoning: "high", maxTokens: 1234 }), resultToken);
    assert.equal(stream({
      provider: "openai",
      id: "gpt-normal",
      api: "openai-responses",
      maxTokens: 64_000,
      reasoning: true,
    }, { messages: [] }, { reasoning: "low" }), resultToken);

    assert.equal(priorityCalls.length, 1);
    assert.equal(priorityCalls[0]?.serviceTier, "priority");
    assert.equal(priorityCalls[0]?.reasoningEffort, "high");
    assert.equal(normalCalls.length, 1);
    assert.equal(readFileSync(configPath, "utf8"), before);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});
