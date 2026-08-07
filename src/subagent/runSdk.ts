import type { ExtensionContext, SettingsManager } from "@earendil-works/pi-coding-agent";
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
}) {
  return {
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager: options.settingsManager,
    systemPromptOverride: () => options.systemPrompt,
    additionalSkillPaths: options.skillPaths,
    noExtensions: true,
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
  }
  return available[0];
}

export async function runSdkSubagent(options: RunSdkSubagentOptions): Promise<{
  output: string;
  sessionPath?: string;
}> {
  const model = await resolveSdkModel(
    options.ctx,
    options.model ?? options.agent.model,
  );
  if (!model) {
    throw new Error("No model available for SDK subagent execution");
  }

  const { createAgentSession, DefaultResourceLoader, getAgentDir, SettingsManager } =
    await import("@earendil-works/pi-coding-agent");
  const previousDisabled = process.env.PI_TASK_TOOL_DISABLED;
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

    // Subscribe to tool execution events before prompt()
    if (options.onSession) {
      unsubSession = options.onSession(session);
    }

    await session.prompt(options.prompt);

    const sessionPath = session.sessionFile;
    const output = getLastAssistantText(session.messages);
    return { output: output.trim(), sessionPath };
  } finally {
    unsubSession?.();
    session?.dispose?.();
    if (previousDisabled === undefined) {
      delete process.env.PI_TASK_TOOL_DISABLED;
    } else {
      process.env.PI_TASK_TOOL_DISABLED = previousDisabled;
    }
  }
}

function getLastAssistantText(messages: readonly any[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const content = message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === "string") return part;
          if (typeof part?.text === "string") return part.text;
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
  }
  return "";
}
