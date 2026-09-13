import type { ExtensionContext, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createTaskFastModeInlineExtension } from "../fast-mode.js";
import type { AgentConfig } from "../helpers.js";

export interface RunSdkSubagentOptions {
  prompt: string;
  agent: AgentConfig;
  cwd: string;
  ctx: ExtensionContext;
  model?: string;
  thinkingLevel?: string;
  tools?: string[];
  excludeTools?: string[];
  systemPrompt?: string;
  skillPaths?: string[];
  fast?: boolean;
  sessionName?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * Called with the AgentSession after creation but before prompt().
   * Return an unsubscribe function that will be called on cleanup.
   */
  onSession?: (session: any) => () => void;
}

export function buildSdkResourceLoaderOptions(options: {
  cwd: string;
  agentDir: string;
  settingsManager: SettingsManager;
  systemPrompt?: string;
  skillPaths?: string[];
  fast?: boolean;
}) {
  return {
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager: options.settingsManager,
    systemPromptOverride: () => options.systemPrompt,
    additionalSkillPaths: options.skillPaths,
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
  sessionPath?: string;
}> {
  const requestedModel = options.model ?? options.agent.model;
  const model = await resolveSdkModel(
    options.ctx,
    requestedModel,
  );
  if (!model) {
    throw new Error(
      requestedModel
        ? `Model "${requestedModel}" is not available in the model registry`
        : "No model available for SDK subagent execution",
    );
  }

  const { createAgentSession, DefaultResourceLoader, getAgentDir, SettingsManager } =
    await import("@earendil-works/pi-coding-agent");
  if (activeSdkRuns === 0) {
    outerDisabledSnapshot = process.env.PI_TASK_TOOL_DISABLED;
  }
  activeSdkRuns += 1;
  process.env.PI_TASK_TOOL_DISABLED = "1";
  let session: any;
  let unsubSession: (() => void) | undefined;
  try {
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(options.cwd, agentDir, {
      projectTrusted: options.ctx.isProjectTrusted(),
    });
    const resourceLoader = new DefaultResourceLoader(
      buildSdkResourceLoaderOptions({
        cwd: options.cwd,
        agentDir,
        settingsManager,
        systemPrompt: options.systemPrompt,
        skillPaths: options.skillPaths,
        fast: options.fast,
      }) as any,
    );

    await resourceLoader.reload();

    ({ session } = await createAgentSession({
      cwd: options.cwd,
      agentDir,
      model,
      thinkingLevel: options.thinkingLevel as any,
      tools: options.tools,
      excludeTools: options.excludeTools,
      resourceLoader,
    }));
    if (options.sessionName && typeof session.setSessionName === "function") {
      session.setSessionName(options.sessionName);
    }

    // Subscribe to tool execution events before prompt()
    if (options.onSession) {
      unsubSession = options.onSession(session);
    }

    let interruption: SdkSubagentInterruptedError | undefined;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const interrupt = (kind: "cancelled" | "timeout") => {
      interruption ??= new SdkSubagentInterruptedError(kind);
      try {
        void Promise.resolve(session.abort?.()).catch(() => {
          // The prompt promise still resolves/rejects through the SDK lifecycle.
        });
      } catch {
        // The prompt promise still resolves/rejects through the SDK lifecycle.
      }
    };
    const onAbort = () => interrupt("cancelled");
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    const armedTimeoutMs = armableTimeoutMs(options.timeoutMs);
    if (armedTimeoutMs !== undefined) {
      timeoutHandle = setTimeout(() => interrupt("timeout"), armedTimeoutMs);
    }
    try {
      if (interruption) throw interruption;
      await session.prompt(options.prompt);
      if (interruption) throw interruption;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      options.signal?.removeEventListener("abort", onAbort);
    }

    const sessionPath = session.sessionFile;
    const result = getFinalAssistantResult(session.messages);
    if ("error" in result) throw new Error(result.error);
    return { output: result.output, sessionPath };
  } finally {
    unsubSession?.();
    session?.dispose?.();
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
