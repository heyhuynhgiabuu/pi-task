import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  clampThinkingLevel,
  streamOpenAICodexResponses,
  streamSimpleOpenAICodexResponses,
  streamOpenAIResponses,
  streamSimpleOpenAIResponses,
  type Api,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type OpenAICodexResponsesOptions,
  type OpenAIResponsesOptions,
  type SimpleStreamOptions,
  type ThinkingLevel,
} from "@earendil-works/pi-ai/compat";
import {
  getAgentDir,
  type ExtensionAPI,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";

/**
 * Task-local adaptation of pi-codex-fast v1.1.0's provider bridge.
 * It deliberately omits that extension's command, status UI, and config writes.
 *
 * All pi-ai imports go through the `@earendil-works/pi-ai/compat` entry. Pi's
 * extension loader aliases the pi-ai package root to its bundled `compat.js`
 * entrypoint, so deep subpath imports (e.g. `/api/openai-codex-responses`) do
 * not resolve at runtime.
 */
const DEFAULT_FAST_MODELS = [
  "openai/gpt-5.4",
  "openai/gpt-5.5",
  "openai-codex/gpt-5.4",
  "openai-codex/gpt-5.5",
] as const;

interface TaskFastModeConfig {
  models: string[];
}

export interface TaskFastModeStreamers {
  streamOpenAIResponses: (
    model: Model<"openai-responses">,
    context: Context,
    options?: OpenAIResponsesOptions,
  ) => AssistantMessageEventStream;
  streamSimpleOpenAIResponses: (
    model: Model<"openai-responses">,
    context: Context,
    options?: SimpleStreamOptions,
  ) => AssistantMessageEventStream;
  streamOpenAICodexResponses: (
    model: Model<"openai-codex-responses">,
    context: Context,
    options?: OpenAICodexResponsesOptions,
  ) => AssistantMessageEventStream;
  streamSimpleOpenAICodexResponses: (
    model: Model<"openai-codex-responses">,
    context: Context,
    options?: SimpleStreamOptions,
  ) => AssistantMessageEventStream;
}

export interface TaskFastModeBridgeDeps {
  agentDir?: string;
  streamers?: Partial<TaskFastModeStreamers>;
}

const DEFAULT_STREAMERS: TaskFastModeStreamers = {
  streamOpenAIResponses,
  streamSimpleOpenAIResponses,
  streamOpenAICodexResponses,
  streamSimpleOpenAICodexResponses,
};

/**
 * Mirror of pi-ai's `buildBaseOptions` (api/simple-options) that only relies
 * on the compat-exported surface. pi-codex-fast's bridge uses the same
 * construction: forward all native options, then add the priority service tier.
 * maxTokens is clamped to the model context window as an upper bound (the
 * native implementation subtracts estimated context usage; we use the window
 * to avoid importing pi-ai's internal token estimator).
 */
function buildFastBaseOptions(
  model: Model<Api>,
  options: SimpleStreamOptions | undefined,
  apiKey: string | undefined,
): OpenAIResponsesOptions & OpenAICodexResponsesOptions {
  const samplingParams = model.samplingParams || options?.samplingParams
    ? { ...model.samplingParams, ...options?.samplingParams }
    : undefined;
  const requestedMaxTokens = options?.maxTokens ?? model.maxTokens;
  const maxTokens = model.contextWindow > 0
    ? Math.min(requestedMaxTokens, model.contextWindow)
    : requestedMaxTokens;
  return {
    temperature: options?.temperature,
    samplingParams,
    maxTokens,
    signal: options?.signal,
    telemetryContext: options?.telemetryContext,
    apiKey: apiKey ?? options?.apiKey,
    fetch: options?.fetch,
    transport: options?.transport,
    cacheRetention: options?.cacheRetention,
    sessionId: options?.sessionId,
    headers: options?.headers,
    onPayload: options?.onPayload,
    onResponse: options?.onResponse,
    timeoutMs: options?.timeoutMs,
    websocketConnectTimeoutMs: options?.websocketConnectTimeoutMs,
    maxRetries: options?.maxRetries,
    maxRetryDelayMs: options?.maxRetryDelayMs,
    metadata: options?.metadata,
    env: options?.env,
  };
}

function normalizeModels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const models = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const normalized = entry.trim().toLowerCase();
    if (normalized) models.add(normalized);
  }
  return [...models];
}

function loadTaskFastModeConfig(agentDir: string): TaskFastModeConfig {
  const configPath = join(agentDir, "extensions", "pi-codex-fast.json");
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const config = parsed as Record<string, unknown>;
      return {
        models: "models" in config
          ? normalizeModels(config.models)
          : [...DEFAULT_FAST_MODELS],
      };
    }
  } catch {
    // Match pi-codex-fast's invalid/missing-config fallback without creating a file.
  }
  return { models: [...DEFAULT_FAST_MODELS] };
}

function isConfiguredModel(
  config: TaskFastModeConfig,
  model: Pick<Model<Api>, "provider" | "id">,
): boolean {
  if (model.provider !== "openai" && model.provider !== "openai-codex") return false;
  const bare = model.id.trim().toLowerCase();
  const qualified = `${model.provider}/${model.id}`.trim().toLowerCase();
  return config.models.some((entry) => entry === bare || entry === qualified);
}

function mapReasoningEffort(
  model: Model<Api>,
  reasoning: ThinkingLevel | undefined,
): ThinkingLevel | undefined {
  const clamped = reasoning ? clampThinkingLevel(model, reasoning) : undefined;
  return clamped === "off" ? undefined : clamped;
}

export function createTaskFastModeStream(
  agentDir: string,
  streamers: TaskFastModeStreamers,
) {
  return (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => {
    const applyFast = isConfiguredModel(loadTaskFastModeConfig(agentDir), model);

    if (model.api === "openai-responses") {
      const openAIModel = model as Model<"openai-responses">;
      if (!applyFast) {
        return streamers.streamSimpleOpenAIResponses(openAIModel, context, options);
      }
      return streamers.streamOpenAIResponses(openAIModel, context, {
        ...buildFastBaseOptions(model, options, options?.apiKey),
        reasoningEffort: mapReasoningEffort(model, options?.reasoning),
        serviceTier: "priority",
      });
    }

    if (model.api === "openai-codex-responses") {
      const codexModel = model as Model<"openai-codex-responses">;
      if (!applyFast) {
        return streamers.streamSimpleOpenAICodexResponses(codexModel, context, options);
      }
      return streamers.streamOpenAICodexResponses(codexModel, context, {
        ...buildFastBaseOptions(model, options, options?.apiKey),
        reasoningEffort: mapReasoningEffort(model, options?.reasoning),
        serviceTier: "priority",
      });
    }

    throw new Error(`pi-task fast mode: unsupported API for provider override: ${String(model.api)}`);
  };
}

export function registerTaskFastModeBridge(
  pi: ExtensionAPI,
  deps: TaskFastModeBridgeDeps = {},
): void {
  const agentDir = deps.agentDir ?? getAgentDir();
  const streamers = { ...DEFAULT_STREAMERS, ...deps.streamers };
  const streamSimple = createTaskFastModeStream(agentDir, streamers);
  const registerProviders = () => {
    pi.registerProvider("openai", {
      api: "openai-responses",
      streamSimple,
    });
    pi.registerProvider("openai-codex", {
      api: "openai-codex-responses",
      streamSimple,
    });
  };

  registerProviders();
  // Re-apply after all extension-load registrations so explicit task fast wins
  // over a globally installed pi-codex-fast without changing its configuration.
  pi.on("session_start", registerProviders);
}

export function createTaskFastModeInlineExtension(agentDir: string): InlineExtension {
  return {
    name: "pi-task-fast-mode",
    factory: (pi) => registerTaskFastModeBridge(pi, { agentDir }),
  };
}