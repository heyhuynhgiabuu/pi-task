import type {
  AgentSession,
  ExtensionContext,
  ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { isChildProjectTrusted } from "../panel/child-prompts.js";
import { createTaskFastModeInlineExtension } from "../fast-mode.js";
import {
  assistantOutputProduced,
  errorMessageOf,
  failoverExhaustedError,
  planModelChain,
  shouldRetrySdkWithNextModel,
} from "../model-failover.js";
import type { AgentConfig, AgentModelSpec } from "../helpers.js";
import type {
  ChildBuiltinCommand,
  ChildBuiltinCommandResult,
} from "../types.js";

export interface RunSdkSubagentOptions {
  prompt: string;
  agent: AgentConfig;
  cwd: string;
  ctx: ExtensionContext;
  model?: string;
  /** Ordered frontmatter models; failover only before any assistant output. */
  modelChain?: AgentModelSpec[];
  thinkingLevel?: string;
  tools?: string[];
  excludeTools?: string[];
  systemPrompt?: string;
  skillPaths?: string[];
  /** Parent-session prompt files; the SDK child expands them natively. */
  promptTemplatePaths?: string[];
  fast?: boolean;
  sessionName?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * Called with the AgentSession after creation but before prompt().
   * Return an unsubscribe function that will be called on cleanup.
   */
  onSession?: (session: AgentSession) => () => void;
}

export function buildSdkResourceLoaderOptions(options: {
  cwd: string;
  agentDir: string;
  settingsManager: SettingsManager;
  systemPrompt?: string;
  skillPaths?: string[];
  promptTemplatePaths?: string[];
  fast?: boolean;
}) {
  return {
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager: options.settingsManager,
    systemPromptOverride: () => options.systemPrompt,
    additionalSkillPaths: options.skillPaths,
    additionalPromptTemplatePaths: options.promptTemplatePaths,
    noExtensions: true,
    extensionFactories: options.fast
      ? [createTaskFastModeInlineExtension(options.agentDir)]
      : [],
  };
}

export async function resolveSdkModel(
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
  requested?: string,
) {
  const registry = ctx.modelRegistry as any;
  if (requested) {
    const [provider, ...rest] = requested.split("/");
    const modelId = rest.join("/");
    const exact = modelId
      ? registry?.find?.(provider, modelId)
      : registry?.find?.(requested);
    if (exact) return exact;
  } else if (ctx.model) {
    return ctx.model;
  }

  const all = registry?.getAll?.() ?? [];
  const available = all.length > 0 ? all : ((await registry?.getAvailable?.()) ?? []);
  if (requested) {
    const byId = available.find(
      (model: any) =>
        model?.id === requested ||
        `${model?.provider?.id ?? model?.provider}/${model?.id}` === requested ||
        model?.name === requested,
    );
    if (byId) return byId;
    return undefined;
  }
  return available[0];
}

/**
 * Build the model runtime for an isolated SDK subagent session.
 *
 * Child sessions deliberately load no extensions (`noExtensions: true`), but
 * providers registered by parent-session packages/extensions via
 * `pi.registerProvider` (for example OAuth providers like `antigravity`)
 * would then be unknown to the child's default runtime, so auth resolution
 * fails with "No API key found for <provider>" even though credentials exist.
 * Re-register those providers into a fresh runtime, through the public
 * registry facade, so auth resolves exactly as it does for the parent.
 * Returns undefined when the parent has no extension-registered providers;
 * the child then uses the SDK's default runtime.
 */
export async function createSdkChildModelRuntime(
  ctx: Pick<ExtensionContext, "modelRegistry">,
  agentDir: string,
): Promise<ModelRuntime | undefined> {
  const registry = ctx.modelRegistry as any;
  const registeredIds: readonly string[] = registry?.getRegisteredProviderIds?.() ?? [];
  if (registeredIds.length === 0) return undefined;
  const { ModelRuntime: ModelRuntimeClass } = await import("@earendil-works/pi-coding-agent");
  const runtime = await ModelRuntimeClass.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  for (const id of registeredIds) {
    // A provider whose stored config fails re-validation must not kill the
    // whole subagent run — skip it (the child loses that provider; other
    // tools and providers keep working) instead of aborting.
    try {
      const config = registry.getRegisteredProviderConfig?.(id);
      if (config) {
        runtime.registerProvider(id, config);
        continue;
      }
      const native = registry.getRegisteredNativeProvider?.(id);
      if (native) runtime.registerNativeProvider(native);
    } catch {
      // Skip the broken provider; keep the rest of the run alive.
    }
  }
  return runtime;
}

let activeSdkRuns = 0;
let outerDisabledSnapshot: string | undefined;

export type SdkAssistantResult =
  | { output: string }
  | { error: string };

export class SdkSubagentInterruptedError extends Error {
  readonly kind: "cancelled" | "timeout";

  constructor(kind: "cancelled" | "timeout") {
    super(kind === "cancelled" ? "SDK subagent was cancelled." : "SDK subagent timed out.");
    this.name = "SdkSubagentInterruptedError";
    this.kind = kind;
  }
}

function commandInfo(message: string): ChildBuiltinCommandResult {
  return { level: "info", message };
}

function commandError(message: string): ChildBuiltinCommandResult {
  return { level: "error", message };
}

/** Run a verified child-session command against this SDK task's own AgentSession. */
export async function executeSdkChildBuiltinCommand(
  session: AgentSession,
  command: ChildBuiltinCommand,
): Promise<ChildBuiltinCommandResult> {
  try {
    if (command.name === "model") {
      const scoped = session.scopedModels.map(({ model }) => model);
      const models = scoped.length > 0 ? scoped : [...session.modelRuntime.getAvailableSnapshot()];
      if (!command.argument) {
        const current = session.model
          ? `${session.model.provider}/${session.model.id}`
          : "none";
        const choices = models.map((model) => `${model.provider}/${model.id}`);
        return commandInfo(
          `Child model: ${current}. Set with /model <provider/model>. Available: ${choices.join(", ") || "none"}.`,
        );
      }
      const separator = command.argument.indexOf("/");
      const match = separator < 0
        ? models.find((model) => model.id === command.argument || model.name === command.argument)
        : models.find((model) =>
            model.provider === command.argument.slice(0, separator) &&
            model.id === command.argument.slice(separator + 1)
          );
      if (!match) {
        return commandError(
          `Unknown child model "${command.argument}". Use /model to list available child models.`,
        );
      }
      await session.setModel(match, { persist: false });
      return commandInfo(`Child model set to ${match.provider}/${match.id}.`);
    }

    if (command.name === "thinking") {
      const levels = session.getAvailableThinkingLevels();
      if (!command.argument) {
        return commandInfo(
          `Child thinking level: ${session.thinkingLevel}. Available: ${levels.join(", ") || "none"}. Set with /thinking <level>.`,
        );
      }
      const requested = command.argument.toLowerCase();
      const level = levels.find((candidate) => candidate.toLowerCase() === requested);
      if (!level) {
        return commandError(
          `Unknown thinking level "${command.argument}". Available child levels: ${levels.join(", ") || "none"}.`,
        );
      }
      session.setThinkingLevel(level, { persist: false });
      return commandInfo(`Child thinking level set to ${level}.`);
    }

    if (command.name === "name") {
      const current = session.sessionManager.getSessionName();
      if (!command.argument) {
        return current
          ? commandInfo(`Child session name: ${current}`)
          : commandError("Usage: /name <name>");
      }
      session.setSessionName(command.argument);
      return commandInfo(`Child session name set to ${session.sessionManager.getSessionName() ?? command.argument}.`);
    }

    if (command.name === "session") {
      const stats = session.getSessionStats();
      const model = session.model
        ? `${session.model.provider}/${session.model.id}`
        : "none";
      return commandInfo([
        `Child session ${stats.sessionId}`,
        `Model: ${model}; thinking: ${session.thinkingLevel}; name: ${session.sessionManager.getSessionName() ?? "(unnamed)"}`,
        `Messages: ${stats.totalMessages} total (${stats.userMessages} user, ${stats.assistantMessages} assistant); tools: ${stats.toolCalls} calls/${stats.toolResults} results`,
        `Tokens: ${stats.tokens.total} total (${stats.tokens.input} input, ${stats.tokens.output} output); cost: $${stats.cost.toFixed(4)}`,
      ].join("\n"));
    }

    return commandError(`/${command.name} is not implemented for SDK child sessions.`);
  } catch (error) {
    return commandError(error instanceof Error ? error.message : String(error));
  }
}

export function getFinalAssistantResult(messages: readonly unknown[]): SdkAssistantResult {
  let finalAssistant: Record<string, unknown> | undefined;
  for (const candidate of messages) {
    if (!candidate || typeof candidate !== "object") continue;
    const message = candidate as Record<string, unknown>;
    if (message.role === "assistant") finalAssistant = message;
  }

  if (!finalAssistant) {
    return { error: "SDK subagent completed without an assistant message." };
  }

  const stopReason = finalAssistant.stopReason;
  const errorMessage = finalAssistant.errorMessage;
  const content = finalAssistant.content;
  const output = extractAssistantText(content);
  if (
    typeof stopReason === "string" &&
    !["stop", "endTurn", "length", "error", "aborted"].includes(stopReason)
  ) {
    return { error: "SDK subagent has not reached a terminal result." };
  }
  if (stopReason === "error") {
    return {
      error:
        typeof errorMessage === "string" && errorMessage.trim()
          ? errorMessage.trim()
          : output || "SDK subagent failed before producing a result.",
    };
  }
  if (stopReason === "aborted") {
    return {
      error:
        typeof errorMessage === "string" && errorMessage.trim()
          ? errorMessage.trim()
          : "SDK subagent was aborted.",
    };
  }
  if (!output.trim()) {
    return { error: "SDK subagent completed without assistant text." };
  }
  return { output: output.trim() };
}

function extractAssistantText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: unknown) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join("\n");
}

const MAX_TIMER_MS = 2_147_483_647; // above this Node coerces the delay to 1 ms

/** Delay for the run's timeout timer, or undefined when no timer must be
 * armed: `undefined` means the caller configured no limit and `Infinity`
 * means the limit is disabled (issue #28). Values past the setTimeout range
 * are clamped — Node coerces those to 1 ms, which would abort the run
 * immediately instead of waiting for the requested ceiling.
 */
export function armableTimeoutMs(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return undefined;
  return Math.min(timeoutMs, MAX_TIMER_MS);
}

export async function runSdkSubagent(options: RunSdkSubagentOptions): Promise<{
  output: string;
  sessionId?: string;
  sessionPath?: string;
}> {
  const { createAgentSession, DefaultResourceLoader, getAgentDir, SettingsManager } =
    await import("@earendil-works/pi-coding-agent");
  if (activeSdkRuns === 0) {
    outerDisabledSnapshot = process.env.PI_TASK_TOOL_DISABLED;
  }
  activeSdkRuns += 1;
  process.env.PI_TASK_TOOL_DISABLED = "1";

  /**
   * One fresh AgentSession attempt. Failover always starts a new session: the
   * SDK cannot reopen a failed one, and a clean restart is only attempted
   * before any assistant output exists.
   */
  const runAttempt = async (
    model: Awaited<ReturnType<typeof resolveSdkModel>>,
    thinkingLevel: string | undefined,
    deadline: number | undefined,
    state: { hadAssistantOutput: boolean; explicitModelChange: boolean },
  ): Promise<{ output: string; sessionId?: string; sessionPath?: string }> => {
    const agentDir = getAgentDir();
    const modelRuntime = await createSdkChildModelRuntime(options.ctx, agentDir);
    const settingsManager = SettingsManager.create(options.cwd, agentDir, {
      projectTrusted: isChildProjectTrusted({
        cwd: options.cwd,
        parentCwd: options.ctx.cwd,
        parentProjectTrusted: options.ctx.isProjectTrusted(),
        agentDir,
      }),
    });
    const resourceLoader = new DefaultResourceLoader(
      buildSdkResourceLoaderOptions({
        cwd: options.cwd,
        agentDir,
        settingsManager,
        systemPrompt: options.systemPrompt,
        skillPaths: options.skillPaths,
        promptTemplatePaths: options.promptTemplatePaths,
        fast: options.fast,
      }) as any,
    );

    await resourceLoader.reload();

    let session: AgentSession | undefined;
    let unsubSession: (() => void) | undefined;
    try {
      ({ session } = await createAgentSession({
        cwd: options.cwd,
        agentDir,
        modelRuntime: modelRuntime ?? undefined,
        model,
        thinkingLevel: thinkingLevel as any,
        tools: options.tools,
        excludeTools: options.excludeTools,
        resourceLoader,
      }));
      const childSession = session;
      if (!childSession) throw new Error("SDK child session was not created.");
      if (options.sessionName) childSession.setSessionName(options.sessionName);

      // Subscribe to tool execution events before prompt()
      if (options.onSession) {
        unsubSession = options.onSession(childSession);
      }

      let interruption: SdkSubagentInterruptedError | undefined;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const interrupt = (kind: "cancelled" | "timeout") => {
        interruption ??= new SdkSubagentInterruptedError(kind);
        try {
          void Promise.resolve(childSession.abort()).catch(() => {
            // The prompt promise still resolves/rejects through the SDK lifecycle.
          });
        } catch {
          // The prompt promise still resolves/rejects through the SDK lifecycle.
        }
      };
      const onAbort = () => interrupt("cancelled");
      if (options.signal?.aborted) onAbort();
      else options.signal?.addEventListener("abort", onAbort, { once: true });
      const remainingMs = deadline === undefined
        ? undefined
        : Math.max(0, deadline - Date.now());
      const armedTimeoutMs = armableTimeoutMs(remainingMs);
      if (armedTimeoutMs !== undefined) {
        timeoutHandle = setTimeout(() => interrupt("timeout"), armedTimeoutMs);
      }
      try {
        if (interruption) throw interruption;
        await childSession.prompt(options.prompt);
        if (interruption) throw interruption;
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        options.signal?.removeEventListener("abort", onAbort);
      }

      const sessionId = childSession.sessionId;
      const sessionPath = childSession.sessionFile;
      const result = getFinalAssistantResult(childSession.messages);
      if ("error" in result) throw new Error(result.error);
      return { output: result.output, sessionId, sessionPath };
    } catch (error) {
      state.hadAssistantOutput = assistantOutputProduced(session?.messages ?? []);
      const current = session?.model;
      state.explicitModelChange = current !== undefined && model !== undefined &&
        (current.provider !== model.provider || current.id !== model.id);
      throw error;
    } finally {
      unsubSession?.();
      session?.dispose?.();
    }
  };

  try {
    const chain = planModelChain(options.modelChain);
    const attempts: AgentModelSpec[] = chain.length > 0
      ? chain
      : [{ model: options.model ?? options.agent.model ?? "" }];
    // The timeout covers the whole chain, not each retry.
    const deadline = options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs)
      ? Date.now() + Math.max(0, options.timeoutMs)
      : undefined;
    let firstError: Error | undefined;
    const trail: string[] = [];
    for (let index = 0; index < attempts.length; index++) {
      const spec = attempts[index]!;
      const requestedModel = spec.model;
      const model = await resolveSdkModel(options.ctx, requestedModel);
      if (!model) {
        const failure = new Error(
          requestedModel
            ? `Model "${requestedModel}" is not available in the model registry`
            : "No model available for SDK subagent execution",
        );
        firstError ??= failure;
        trail.push(`${requestedModel ?? "(default)"}: ${failure.message}`);
        if (index + 1 < attempts.length) continue;
        if (trail.length > 1 && firstError) throw failoverExhaustedError(firstError, trail);
        throw failure;
      }

      const state = { hadAssistantOutput: false, explicitModelChange: false };
      try {
        return await runAttempt(
          model,
          spec.thinking ?? options.thinkingLevel,
          deadline,
          state,
        );
      } catch (error) {
        if (error instanceof SdkSubagentInterruptedError) throw error;
        const failure = error instanceof Error ? error : new Error(errorMessageOf(error));
        firstError ??= failure;
        trail.push(`${requestedModel}: ${failure.message}`);
        if (
          shouldRetrySdkWithNextModel({
            error,
            hadAssistantOutput: state.hadAssistantOutput,
            explicitModelChange: state.explicitModelChange,
            remaining: attempts.length - index - 1,
          })
        ) {
          continue;
        }
        if (trail.length > 1 && firstError) throw failoverExhaustedError(firstError, trail);
        throw error;
      }
    }
    throw firstError ?? new Error("No model available for SDK subagent execution");
  } finally {
    activeSdkRuns -= 1;
    if (activeSdkRuns <= 0) {
      activeSdkRuns = 0;
      if (outerDisabledSnapshot === undefined) {
        delete process.env.PI_TASK_TOOL_DISABLED;
      } else {
        process.env.PI_TASK_TOOL_DISABLED = outerDisabledSnapshot;
      }
      outerDisabledSnapshot = undefined;
    }
  }
}
