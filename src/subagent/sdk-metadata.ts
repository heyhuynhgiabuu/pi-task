import type {
  AgentSession,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { ChildContextUsage, ChildUsageMetadata } from "../panel/child-metadata.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function usageValues(value: unknown): {
  input: number;
  cacheRead: number;
  cacheWrite: number;
} | undefined {
  if (!isRecord(value)) return undefined;
  const fields = [value.input, value.cacheRead, value.cacheWrite];
  if (!fields.every((field) => typeof field === "number" && Number.isFinite(field) && field >= 0)) {
    return undefined;
  }
  return {
    input: value.input as number,
    cacheRead: value.cacheRead as number,
    cacheWrite: value.cacheWrite as number,
  };
}

function promptTokens(value: unknown): number | undefined {
  const usage = usageValues(value);
  return usage ? usage.input + usage.cacheRead + usage.cacheWrite : undefined;
}

function cacheHitRate(value: unknown): number | undefined {
  const usage = usageValues(value);
  if (!usage) return undefined;
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
  return prompt > 0 ? (usage.cacheRead / prompt) * 100 : undefined;
}

/**
 * Subscribe to one SDK child's own session stats and compaction-aware context.
 * Full session scans happen at message/entry boundaries, never in the render path;
 * streamed partials update only the in-memory context/cache-rate snapshot.
 */
export function subscribeSdkChildMetadata(
  session: AgentSession,
  onUpdate: (metadata: ChildUsageMetadata) => void,
): () => void {
  let active = true;
  let latestCacheHitRate: number | undefined;
  let contextInvalidated = false;
  let streamedPromptTokens: number | undefined;
  let lastStats = session.getSessionStats();

  const publish = (refreshStats: boolean) => {
    if (!active) return;
    try {
      if (refreshStats) lastStats = session.getSessionStats();
      const nativeContext = session.getContextUsage();
      const model = session.model;
      const window = nativeContext?.contextWindow ?? model?.contextWindow;
      const contextUsage: ChildContextUsage = {
        tokens: contextInvalidated
          ? null
          : streamedPromptTokens ?? nativeContext?.tokens ?? null,
        ...(typeof window === "number" && Number.isFinite(window) && window > 0
          ? { contextWindow: window }
          : {}),
      };
      let usingSubscription: boolean | undefined;
      if (model) {
        try {
          // Query the child's own runtime; provider/model names alone never imply a subscription.
          usingSubscription = session.modelRuntime.isUsingSubscription(model.provider);
        } catch {
          // No reliable signal means no badge.
        }
      }
      onUpdate({
        ...(model ? { model: `${model.provider}/${model.id}` } : {}),
        usageTotals: {
          input: lastStats.tokens.input,
          output: lastStats.tokens.output,
          cacheRead: lastStats.tokens.cacheRead,
          cacheWrite: lastStats.tokens.cacheWrite,
          cost: lastStats.cost,
        },
        ...(latestCacheHitRate === undefined ? {} : { latestCacheHitRate }),
        contextUsage,
        ...(usingSubscription === undefined ? {} : { usingSubscription }),
        autoCompactionEnabled: session.autoCompactionEnabled,
      });
    } catch {
      // A disposed or partially initialized child degrades to its last metadata.
    }
  };

  publish(false);
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (!active) return;

    if (event.type === "compaction_start" || event.type === "compaction_end") {
      contextInvalidated = true;
      streamedPromptTokens = undefined;
      publish(false);
      return;
    }
    if (
      event.type === "entry_appended" &&
      (event.entry.type === "compaction" || event.entry.type === "context_edit")
    ) {
      contextInvalidated = true;
      streamedPromptTokens = undefined;
      publish(true);
      return;
    }

    if (event.type === "message_update" && event.message.role === "assistant") {
      if (session.isCompacting) return;
      latestCacheHitRate = cacheHitRate(event.message.usage);
      const measured = promptTokens(event.message.usage);
      if (measured !== undefined && measured > 0) {
        streamedPromptTokens = measured;
        contextInvalidated = false;
      }
      publish(false);
      return;
    }

    if (event.type === "message_end" && event.message.role === "assistant") {
      latestCacheHitRate = cacheHitRate(event.message.usage);
      const measured = promptTokens(event.message.usage);
      if (
        !session.isCompacting &&
        measured !== undefined &&
        measured > 0 &&
        event.message.stopReason !== "aborted" &&
        event.message.stopReason !== "error"
      ) {
        contextInvalidated = false;
        streamedPromptTokens = undefined;
      }
      publish(true);
      return;
    }

    if (event.type === "entry_appended") {
      publish(true);
      return;
    }
    if (event.type === "agent_end" || event.type === "turn_end") publish(true);
  });

  return () => {
    active = false;
    unsubscribe();
  };
}
