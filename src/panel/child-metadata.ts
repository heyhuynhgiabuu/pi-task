/** Child-owned usage data shown in the transcript overlay (never parent session stats). */
export interface ChildUsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface ChildContextUsage {
  /** Null means no trustworthy post-compaction/reset measurement exists yet. */
  tokens: number | null;
  /** Child model's catalog context window; absent when that exact model is unknown. */
  contextWindow?: number;
}

export interface ChildUsageMetadata {
  /** Exact child model reference, when the child actually selected one. */
  model?: string;
  usageTotals: ChildUsageTotals;
  /** Cache-hit percent from the latest assistant response, not lifetime totals. */
  latestCacheHitRate?: number;
  /** Latest measured child run: assistant output / (wall time including tools minus UI prompt waits). */
  latestTokensPerSecond?: number;
  contextUsage?: ChildContextUsage;
  /** Proven only by the child runtime/provider. */
  usingSubscription?: boolean;
  /** Proven only by the child runtime; unknown is not treated as enabled. */
  autoCompactionEnabled?: boolean;
}

export interface FormattedChildMetadata {
  usage: string[];
  context: string;
  contextColor?: "warning" | "error";
}

export const CHILD_RUN_TPS_ENTRY_TYPE = "pi-task.run-tps";

/** Match the main TPS extension: count only model output, including partial output on abort. */
export function sumAssistantOutputTokens(messages: readonly unknown[]): number {
  let output = 0;
  for (const message of messages) {
    if (typeof message !== "object" || message === null || !("role" in message) || message.role !== "assistant" ||
      !("usage" in message) || typeof message.usage !== "object" || message.usage === null || !("output" in message.usage)) continue;
    const tokens = message.usage.output;
    if (typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0) output += tokens;
  }
  return output;
}

/** Whole-run TPS; never reconstruct run time from individual response/tool durations. */
export function childRunTokensPerSecond(measurement: {
  output?: unknown;
  elapsedMs?: unknown;
  waitMs?: unknown;
}): number | undefined {
  const { output, elapsedMs, waitMs } = measurement;
  if (typeof output !== "number" || !Number.isFinite(output) || output <= 0 ||
    typeof elapsedMs !== "number" || !Number.isFinite(elapsedMs) || elapsedMs <= 0 ||
    typeof waitMs !== "number" || !Number.isFinite(waitMs) || waitMs < 0) return undefined;
  const activeMs = elapsedMs - waitMs;
  const rate = output / ((activeMs > 0 ? activeMs : elapsedMs) / 1_000);
  return Number.isFinite(rate) ? rate : undefined;
}

/** Per-run wall clock with the same union-of-prompt-spans accounting as the main TPS extension. */
export function createChildTpsRun() {
  let startMs: number | null = null;
  let promptOpenAtMs: number | null = null;
  let promptDepth = 0;
  let waitMs = 0;
  return {
    start(now: number) {
      startMs = now;
      waitMs = 0;
      promptOpenAtMs = null;
      promptDepth = 0;
    },
    promptStart(now: number) {
      if (startMs === null) return;
      if (promptDepth === 0) promptOpenAtMs = now;
      promptDepth++;
    },
    promptEnd(now: number) {
      if (promptDepth === 0) return;
      promptDepth--;
      if (promptDepth === 0 && promptOpenAtMs !== null) {
        waitMs += Math.max(0, now - promptOpenAtMs);
        promptOpenAtMs = null;
      }
    },
    end(now: number): { elapsedMs: number; waitMs: number } | null {
      if (startMs === null) return null;
      if (promptOpenAtMs !== null) waitMs += Math.max(0, now - promptOpenAtMs);
      const elapsedMs = Math.max(0, now - startMs);
      startMs = null;
      promptOpenAtMs = null;
      promptDepth = 0;
      return { elapsedMs, waitMs };
    },
  };
}

/** Pi's compact footer token boundaries. */
export function formatChildTokens(count: number): string {
  if (count < 1_000) return count.toString();
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

/** Build a compact child-only footer stats line. */
export function formatChildMetadata(metadata: ChildUsageMetadata): FormattedChildMetadata {
  const { usageTotals } = metadata;
  const usage: string[] = [];
  if (usageTotals.input) usage.push(`↑${formatChildTokens(usageTotals.input)}`);
  if (usageTotals.output) usage.push(`↓${formatChildTokens(usageTotals.output)}`);
  if (usageTotals.cacheRead) usage.push(`R${formatChildTokens(usageTotals.cacheRead)}`);
  if (usageTotals.cacheWrite) usage.push(`W${formatChildTokens(usageTotals.cacheWrite)}`);
  if (
    (usageTotals.cacheRead > 0 || usageTotals.cacheWrite > 0) &&
    metadata.latestCacheHitRate !== undefined
  ) {
    usage.push(`CH${metadata.latestCacheHitRate.toFixed(1)}%`);
  }
  if (usageTotals.cost || metadata.usingSubscription === true) {
    usage.push(`$${usageTotals.cost.toFixed(3)}${metadata.usingSubscription === true ? " (sub)" : ""}`);
  }

  if (metadata.latestTokensPerSecond !== undefined) {
    usage.push(`TPS ${metadata.latestTokensPerSecond.toFixed(1)}`);
  }

  const contextUsage = metadata.contextUsage;
  const contextWindow = contextUsage?.contextWindow;
  const tokens = contextUsage?.tokens ?? null;
  const validWindow = typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
    ? contextWindow
    : undefined;
  let context: string;
  let contextPercent: number | undefined;
  if (tokens === null) {
    context = `?/${validWindow === undefined ? "?" : formatChildTokens(validWindow)}`;
  } else if (validWindow === undefined) {
    context = `${formatChildTokens(tokens)}/?`;
  } else {
    contextPercent = (tokens / validWindow) * 100;
    context = `${contextPercent.toFixed(1)}%/${formatChildTokens(validWindow)}`;
  }
  if (metadata.autoCompactionEnabled === true) context += " (auto)";

  return {
    usage,
    context,
    ...(contextPercent !== undefined && contextPercent > 90
      ? { contextColor: "error" as const }
      : contextPercent !== undefined && contextPercent > 70
        ? { contextColor: "warning" as const }
        : {}),
  };
}
