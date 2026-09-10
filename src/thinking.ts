export const PI_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

const PI_THINKING_LEVEL_SET = new Set<string>(PI_THINKING_LEVELS);

export function normalizePiThinkingLevel(
  value: unknown,
): PiThinkingLevel | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return PI_THINKING_LEVEL_SET.has(normalized)
    ? (normalized as PiThinkingLevel)
    : undefined;
}
