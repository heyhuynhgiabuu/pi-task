const FORWARDING_PREFIX_PATTERN = /^[A-Z][A-Z0-9_]*_$/u;
const FORWARDING_TARGET_PATTERN = /^[A-Z_][A-Z0-9_]*$/u;

export const DEFAULT_SUBAGENT_FORWARD_PREFIX = "PI_SUBAGENT_FORWARD_";
export const SUBAGENT_FORWARD_PREFIXES_ENV = "PI_TASK_SUBAGENT_FORWARD_PREFIXES";

export type ForwardingDiagnosticKind =
  | "duplicate-prefix"
  | "ambiguous-prefix"
  | "invalid-target"
  | "duplicate-target"
  | "base-collision";

export interface ForwardingDiagnostic {
  readonly kind: ForwardingDiagnosticKind;
  readonly message: string;
}

export type SubagentEnvironmentResolution =
  | {
      readonly ok: true;
      readonly environment: Record<string, string>;
      readonly diagnostics: readonly ForwardingDiagnostic[];
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

type PrefixResolution =
  | {
      readonly ok: true;
      readonly prefixes: readonly string[];
      readonly diagnostics: readonly ForwardingDiagnostic[];
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

interface ForwardingCandidate {
  readonly sourceName: string;
  readonly targetName: string;
  readonly value: string;
  readonly prefix: string;
  readonly prefixIndex: number;
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function diagnosticName(value: string): string {
  return JSON.stringify(value);
}

function configuredPrefixes(parentEnvironment: NodeJS.ProcessEnv): PrefixResolution {
  const raw = parentEnvironment[SUBAGENT_FORWARD_PREFIXES_ENV];
  if (raw === undefined || raw.trim() === "") {
    return {
      ok: true,
      prefixes: [DEFAULT_SUBAGENT_FORWARD_PREFIX],
      diagnostics: [],
    };
  }

  const prefixes: string[] = [];
  const diagnostics: ForwardingDiagnostic[] = [];
  const seen = new Set<string>();
  for (const segment of raw.split(",")) {
    const prefix = segment.trim();
    if (!prefix) continue;
    if (!FORWARDING_PREFIX_PATTERN.test(prefix)) {
      return {
        ok: false,
        error: `${SUBAGENT_FORWARD_PREFIXES_ENV} contains invalid prefix ${diagnosticName(prefix)}. Prefixes must match [A-Z][A-Z0-9_]*_.`,
      };
    }
    if (seen.has(prefix)) {
      diagnostics.push({
        kind: "duplicate-prefix",
        message: `Duplicate subagent forwarding prefix ${prefix} was ignored.`,
      });
      continue;
    }
    seen.add(prefix);
    prefixes.push(prefix);
  }

  return {
    ok: true,
    prefixes: prefixes.length > 0 ? prefixes : [DEFAULT_SUBAGENT_FORWARD_PREFIX],
    diagnostics,
  };
}

function candidatePriority(
  left: ForwardingCandidate,
  right: ForwardingCandidate,
): number {
  const prefixLength = right.prefix.length - left.prefix.length;
  if (prefixLength !== 0) return prefixLength;
  if (left.prefixIndex !== right.prefixIndex) return left.prefixIndex - right.prefixIndex;
  return compareNames(left.sourceName, right.sourceName);
}

function diagnosticForDuplicateTarget(
  first: ForwardingCandidate,
  second: ForwardingCandidate,
): ForwardingDiagnostic {
  const sources = [first.sourceName, second.sourceName].sort(compareNames);
  const winner = candidatePriority(first, second) <= 0 ? first : second;
  return {
    kind: "duplicate-target",
    message: `Forwarded environment target ${diagnosticName(first.targetName)} has conflicting sources ${sources.map(diagnosticName).join(", ")}; ${diagnosticName(winner.sourceName)} wins.`,
  };
}

/** Resolve the opt-in environment contract without mutating the parent process. */
export function resolveSubagentEnvironment(
  parentEnvironment: NodeJS.ProcessEnv = process.env,
  baseEnvironment: Readonly<Record<string, string>> = {},
): SubagentEnvironmentResolution {
  const prefixResult = configuredPrefixes(parentEnvironment);
  if (!prefixResult.ok) return prefixResult;

  const diagnostics: ForwardingDiagnostic[] = [...prefixResult.diagnostics];
  const selected = new Map<string, ForwardingCandidate>();
  const entries = Object.entries(parentEnvironment).sort(([left], [right]) =>
    compareNames(left, right),
  );

  for (const [sourceName, value] of entries) {
    if (typeof value !== "string") continue;
    const matches = prefixResult.prefixes
      .map((prefix, prefixIndex) => ({ prefix, prefixIndex }))
      .filter(({ prefix }) => sourceName.startsWith(prefix))
      .sort((left, right) =>
        right.prefix.length - left.prefix.length
        || left.prefixIndex - right.prefixIndex,
      );
    const match = matches[0];
    if (!match) continue;

    const targetName = sourceName.slice(match.prefix.length);
    if (matches.length > 1) {
      diagnostics.push({
        kind: "ambiguous-prefix",
        message: `Forwarded environment source ${diagnosticName(sourceName)} matched multiple prefixes (${matches.map(({ prefix }) => diagnosticName(prefix)).join(", ")}); ${diagnosticName(match.prefix)} was selected.`,
      });
    }
    if (!FORWARDING_TARGET_PATTERN.test(targetName)) {
      diagnostics.push({
        kind: "invalid-target",
        message: `Forwarded environment source ${diagnosticName(sourceName)} has invalid target ${diagnosticName(targetName || "<empty>")}; it was ignored.`,
      });
      continue;
    }

    const candidate: ForwardingCandidate = {
      sourceName,
      targetName,
      value,
      prefix: match.prefix,
      prefixIndex: match.prefixIndex,
    };
    const previous = selected.get(targetName);
    if (previous) {
      diagnostics.push(diagnosticForDuplicateTarget(previous, candidate));
      if (candidatePriority(candidate, previous) < 0) selected.set(targetName, candidate);
    } else {
      selected.set(targetName, candidate);
    }
  }

  const environment: Record<string, string> = {};
  for (const [targetName, candidate] of [...selected.entries()].sort(([left], [right]) =>
    compareNames(left, right),
  )) {
    environment[targetName] = candidate.value;
    if (Object.prototype.hasOwnProperty.call(baseEnvironment, targetName)) {
      diagnostics.push({
        kind: "base-collision",
        message: `Forwarded environment target ${diagnosticName(targetName)} conflicts with required launch environment; the required value wins.`,
      });
    }
  }

  return {
    ok: true,
    environment: { ...environment, ...baseEnvironment },
    diagnostics,
  };
}
