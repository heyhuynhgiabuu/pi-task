/**
 * Shared agent tool allowlist resolution for task subagents.
 */


import { parseMergedDisallowedTools } from "./policy.js";

/** Pi built-in tools exposed to task subagents when present in the parent session. */
const BUILTIN_TOOL_NAMES = [
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
const TASK_DEFAULT_EXTENSION_TOOLS = [
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
  /** Name registered by pi-task in the parent session. */
  taskToolName?: string;
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
  const taskToolName = input.taskToolName ?? "task";

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
  const withoutTask = allowed.filter((t) => t !== taskToolName);

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
  const taskToolName = input.taskToolName ?? "task";
  return {
    tools: resolveAgentToolAllowlist(input),
    excludeTools: [taskToolName],
  };
}

// ── Claude Code tool policy translation ─────────────────────────────────────

/** Pi tool name → Claude Code built-in tool name. */
const CLAUDE_TOOL_MAP: Record<string, string> = {
  read: "Read",
  grep: "Grep",
  find: "Glob",
  ls: "Glob",
  bash: "Bash",
  write: "Write",
  edit: "Edit",
  apply_patch: "Edit",
  websearch: "WebSearch",
  web_fetch: "WebFetch",
};

/** Claude built-ins that can mutate the workspace or run shell commands. */
const CLAUDE_MUTATING_TOOLS = new Set(["Bash", "Write", "Edit", "NotebookEdit"]);

/** Read-only Claude built-ins allowed to a `readonly: true` Claude agent. */
const CLAUDE_READONLY_BASE_TOOLS: string[] = ["Read", "Grep", "Glob"];

function formatList(names: Iterable<string>): string {
  return [...names].map((n) => `"${n}"`).join(", ");
}

export interface ClaudeToolPolicy {
  /** Value for claude `--tools` ("default" keeps the built-in surface). */
  tools: string;
  /** Value for claude `--disallowedTools`; undefined = no deny list. */
  disallowedTools?: string;
}

/**
 * Translate pi agent tool policy into Claude Code CLI flags (one translator,
 * runtime-specific; pi runtime policy semantics are untouched).
 *
 * - Explicit `tools:` maps supported pi names to Claude names and REJECTS any
 *   unmappable name rather than silently dropping it.
 * - Explicit `disallowed_tools:` maps likewise; unmappable names are rejected.
 * - `readonly: true` enforces an actual read-only surface (`--tools`
 *   Read,Grep,Glob + read-only web tools) regardless of permission mode, so
 *   bypassPermissions grants no shell/write escape.
 * - No explicit restriction keeps Claude's default tool surface.
 */
export function resolveClaudeToolPolicy(
  input: ResolveAgentToolsInput & { readonly?: boolean },
): ClaudeToolPolicy {
  const translate = (names: string[], source: "tools" | "disallowedTools") => {
    const out: string[] = [];
    const unmappable: string[] = [];
    for (const name of names) {
      const mapped = CLAUDE_TOOL_MAP[name.toLowerCase()];
      if (mapped) {
        if (!out.includes(mapped)) out.push(mapped);
      } else {
        unmappable.push(name);
      }
    }
    if (unmappable.length > 0) {
      throw new Error(
        `Agent ${source} contains tools that cannot be mapped to Claude Code built-in tools: ${formatList(unmappable)}. ` +
          `Supported pi names: ${formatList(Object.keys(CLAUDE_TOOL_MAP))}. ` +
          "Remove them from the agent frontmatter or switch the agent to the pi runtime.",
      );
    }
    return out;
  };

  const explicitTools = input.tools !== undefined && input.tools !== null && input.tools !== ""
    ? parseToolList(input.tools)
    : undefined;
  const explicitDisallowed = parseToolList(input.disallowedTools);

  // readonly: true — explicit allowlist wins, else the read-only base surface.
  // The allowlist itself is the containment: Bash/Write/Edit/NotebookEdit are
  // never named, so bypassPermissions cannot elevate the child.
  if (input.readonly) {
    const denyReadonly = translate(explicitDisallowed, "disallowedTools");
    const readonlySurface = [...CLAUDE_READONLY_BASE_TOOLS];
    if (explicitTools !== undefined) {
      for (const mapped of translate(explicitTools, "tools")) {
        if (CLAUDE_MUTATING_TOOLS.has(mapped)) {
          throw new Error(
            `Agent has readonly: true but tools: requests the mutating Claude Code tool "${mapped}". ` +
              "Remove readonly: or drop the mutating tool from tools:.",
          );
        }
        if (!readonlySurface.includes(mapped)) readonlySurface.push(mapped);
      }
    } else {
      // Web tools are read-only in Claude Code and safe to expose here.
      for (const name of ["websearch", "web_fetch"]) {
        const mapped = CLAUDE_TOOL_MAP[name]!;
        if (
          !explicitDisallowed.some((d) => CLAUDE_TOOL_MAP[d.toLowerCase()] === mapped)
        ) {
          readonlySurface.push(mapped);
        }
      }
    }
    return {
      tools: readonlySurface.join(","),
      ...(denyReadonly.length > 0
        ? { disallowedTools: denyReadonly.join(",") }
        : {}),
    };
  }

  if (explicitTools !== undefined) {
    return { tools: translate(explicitTools, "tools").join(",") };
  }

  if (explicitDisallowed.length > 0) {
    return {
      tools: "default",
      disallowedTools: translate(explicitDisallowed, "disallowedTools").join(","),
    };
  }

  // No explicit restrictions: keep Claude's normal tool surface.
  return { tools: "default" };
}
