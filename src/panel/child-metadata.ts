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
