/**
 * Shared agent tool allowlist resolution for task + harness.
 *
 * Frontmatter:
 *   tools: comma list → explicit allowlist base
 *   (omit tools) → BUILTIN_TOOL_NAMES + TASK_DEFAULT_EXTENSION_TOOLS
 *   disallowed_tools: subtract (+ xai_* via parseMergedDisallowedTools)
 */

import { parseMergedDisallowedTools } from "./policy.js";

/** Pi built-in tools (matches harness). */
export const BUILTIN_TOOL_NAMES = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;

/**
 * Extension tools commonly granted to research / read-only subagents when
 * `tools:` is omitted. Parent may pass a wider list via parentToolNames.
 */
export const TASK_DEFAULT_EXTENSION_TOOLS = [
  "websearch",
  "codesearch",
  "web_fetch",
  "context7",
  "deepwiki",
  "webclaw_scrape",
  "webclaw_batch",
  "memory-search",
  "memory-admin",
  "observation",
  "vcc_recall",
  "diagnostics",
  "compress",
  "task",
  "harness",
] as const;

/** @deprecated Use BUILTIN_TOOL_NAMES + TASK_DEFAULT_EXTENSION_TOOLS */
export const ALL_TOOL_NAMES = [...BUILTIN_TOOL_NAMES];

export function parseToolList(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.map((t) => String(t).trim()).filter(Boolean);
  }
  return String(raw)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

export interface ResolveAgentToolsInput {
  /** Explicit `tools:` from frontmatter */
  tools?: string | string[];
  /** `disallowed_tools` from frontmatter */
  disallowedTools?: string | string[];
  /**
   * When set, used as base instead of default builtin+extension catalog
   * (intersection applied when agent also sets `tools:`).
   */
  parentToolNames?: string[];
}

/**
 * Effective allowlist for CLI `--tools` or SDK `tools:` option.
 * Throws if the result is empty.
 */
export function resolveAgentToolAllowlist(
  input: ResolveAgentToolsInput,
): string[] {
  const disallowed = new Set(
    parseMergedDisallowedTools(parseToolList(input.disallowedTools).join(",")),
  );

  let base: string[];
  if (input.tools !== undefined && input.tools !== null && input.tools !== "") {
    const explicit = parseToolList(input.tools);
    if (input.parentToolNames?.length) {
      const parentSet = new Set(input.parentToolNames);
      base = explicit.filter((t) => parentSet.has(t));
    } else {
      base = explicit;
    }
  } else if (input.parentToolNames?.length) {
    base = [...input.parentToolNames];
  } else {
    base = [...BUILTIN_TOOL_NAMES, ...TASK_DEFAULT_EXTENSION_TOOLS];
  }

  const allowed = base.filter((t) => !disallowed.has(t));
  // Never delegate nested task from subagent CLI (env also sets PI_TASK_TOOL_DISABLED).
  const withoutTask = allowed.filter((t) => t !== "task");

  if (withoutTask.length === 0) {
    throw new Error(
      "Agent tool allowlist is empty after applying tools/disallowed_tools. " +
        "Add tools: or relax disallowed_tools.",
    );
  }

  return withoutTask;
}

export function buildAgentToolSelection(input: ResolveAgentToolsInput): {
  tools: string[];
  excludeTools: string[];
} {
  return {
    tools: resolveAgentToolAllowlist(input),
    excludeTools: ["task"],
  };
}
