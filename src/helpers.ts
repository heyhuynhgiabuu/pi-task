/**
 * Task Extension — Pure helper functions.
 *
 * No side effects, no ExtensionAPI dependency. All functions here are
 * unit-testable with node:assert/strict.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { parseToolList } from "./agent-tools.js";
import { parseMergedDisallowedTools } from "./policy.js";
import { buildPiArgv } from "./subagent/buildArgv.js";


export function parseMarkdownFrontmatter(content: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  if (!content.startsWith("---\n")) {
    return { frontmatter: {}, body: content };
  }

  const end = content.indexOf("\n---", 4);
  if (end === -1) return { frontmatter: {}, body: content };

  const raw = content.slice(4, end).trim();
  const body = content.slice(end + "\n---".length).replace(/^\n/, "");
  const frontmatter: Record<string, string> = {};

  for (const line of raw.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) frontmatter[key] = value;
  }

  return { frontmatter, body };
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AgentConfig {
  name: string;
  description: string;
  model?: string;
  thinking?: string;
  /** Explicit allowlist from frontmatter `tools:` */
  tools?: string | string[];
  disallowedTools?: string[];
  body: string;
  source: "project" | "user" | "bundled";
  path: string;
}

export interface ParsedResult {
  status: string;
  summary: string;
  findings: string;
  evidence: string;
  confidence: string;
  raw: string;
}

/** A single tool call extracted from a subagent session JSONL. */
export interface ToolCallRecord {
  /** Tool name (e.g. "websearch", "read", "bash") */
  name: string;
  /** Short, human-readable summary of the call's primary argument */
  detail: string;
  /** "done" if a matching toolResult was seen, "error" if isError, "in_progress" otherwise */
  status: "done" | "error" | "in_progress";
  /** Entry id of the toolCall block (used for stable sorting/debug) */
  id: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const TASK_BACKGROUND_DEFAULT = true;

export const TASK_RESULT_XML_INSTRUCTIONS = `<status>success|failure|blocked|partial</status>
<summary>One sentence: what was accomplished</summary>
<findings>Key findings with file:line references</findings>
<evidence>Verification evidence, commands run, output snippets</evidence>
<confidence>high|medium|low (optional — how certain the findings are)</confidence>
<files>Comma-separated absolute paths of files read/created (optional)</files>

Prefer writing this block to RESULT.md when done. If you cannot write the file, your final assistant message MUST include the same XML block.`;

export const OUTPUT_FORMAT_GUIDE = TASK_RESULT_XML_INSTRUCTIONS;

export const TASK_TOOL_DESCRIPTION = `Launch a new agent to handle complex, multistep tasks autonomously.

Include relevant context from your current work in the prompt parameter —
this becomes the subagent's instructions. The subagent knows nothing about what you've been doing except what you put in the prompt.

When NOT to use:
- To read a specific file path, use Read or Grep instead
- To search for a class definition like 'class Foo', use Grep instead
- To search code within 2-3 files, use Read instead
- If no available agent fits the task, use other tools directly

Usage notes:
1. Provide complete context in the prompt — the subagent starts with a fresh context
2. Launch multiple agents concurrently when possible (use a single message with multiple tool calls)
3. Once you delegate work, do NOT duplicate it. Continue with non-overlapping tasks, or wait for the result
4. Background is the default. Use background:false only when you need the caller to wait inline for the tmux task result
5. Do not trust delegated output blindly. Read changed files, review the diff, verify scope, and run the relevant checks before claiming completion
6. Clearly tell the agent whether to write code or just research, since it doesn't know the user's intent
7. The result returned by the agent is not visible to the user. Send a concise summary back to the user
8. Pass task_id to resume a previous subagent session (continues with its prior context)

Background mode (background: true):
- Launches the subagent asynchronously and returns immediately
- You will be notified automatically when it finishes
- DO NOT sleep, poll, ask the task for status, or duplicate its work while it runs in background
- Avoid working with the same files or topics the background task is using
- Work on non-overlapping tasks, or briefly tell the user what you launched and end your response`;

/** @deprecated Import from ./agent-tools.js */
export { ALL_TOOL_NAMES, BUILTIN_TOOL_NAMES } from "./agent-tools.js";

// Cached regex patterns for XML result parsing
const STATUS_RE = /<status>([\s\S]*?)<\/status>/i;
const SUMMARY_RE = /<summary>([\s\S]*?)<\/summary>/i;
const FINDINGS_RE = /<findings>([\s\S]*?)<\/findings>/i;
const EVIDENCE_RE = /<evidence>([\s\S]*?)<\/evidence>/i;
const CONFIDENCE_RE = /<confidence>([\s\S]*?)<\/confidence>/i;

// ─── Result Parsing ──────────────────────────────────────────────────────────

export function extractTag(raw: string, re: RegExp): string {
  const m = raw.match(re);
  return m ? m[1].trim() : "";
}

export function parseResultXml(raw: string): ParsedResult {
  const status = extractTag(raw, STATUS_RE);

  if (
    !status &&
    !extractTag(raw, SUMMARY_RE) &&
    !extractTag(raw, FINDINGS_RE) &&
    !extractTag(raw, EVIDENCE_RE)
  ) {
    return {
      status: "unknown",
      summary: raw.slice(0, 500),
      findings: "",
      evidence: "",
      confidence: "",
      raw,
    };
  }

  const confidence = extractTag(raw, CONFIDENCE_RE);

  return {
    status: status || "unknown",
    summary: extractTag(raw, SUMMARY_RE) || "",
    findings: extractTag(raw, FINDINGS_RE) || "",
    evidence: extractTag(raw, EVIDENCE_RE) || "",
    confidence: confidence || "",
    raw,
  };
}

// ─── Formatting ──────────────────────────────────────────────────────────────

export function formatMs(ms: number): string {
  if (ms >= 60_000)
    return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1_000)}s`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${ms}ms`;
}

export function parseIdTimestamp(id: string): number {
  try {
    const ts36 = id.split("-")[0];
    if (ts36) return parseInt(ts36, 36);
  } catch {
    /* fall through */
  }
  return Date.now();
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export type TmuxSplitDirection = "-h" | "-v";

export function chooseTmuxSplitDirection(
  paneWidth: number,
  paneHeight: number,
): TmuxSplitDirection {
  const minSideBySideWidth = 160;
  const minStackedHeight = 24;

  if (Number.isFinite(paneWidth) && paneWidth >= minSideBySideWidth) {
    return "-h";
  }
  if (Number.isFinite(paneHeight) && paneHeight >= minStackedHeight) {
    return "-v";
  }
  return "-h";
}

export function buildTmuxSplitWindowArgs(
  cwd: string,
  command: string,
  direction: TmuxSplitDirection = "-h",
  targetPane?: string | null,
): string[] {
  const args = [
    "split-window",
    direction,
    "-P",
    "-F",
    "#{pane_id}",
  ];
  if (targetPane) args.push("-t", targetPane);
  args.push("-c", cwd, command);
  return args;
}

export interface BackgroundReceiptInput {
  taskId: string;
  agentType: string;
  tmuxSession: string;
  artifactDir: string;
}

export function formatBackgroundReceipt(input: BackgroundReceiptInput): string {
  return [
    `Started task ${input.taskId} with ${input.agentType}.`,
    `Tmux session: ${input.tmuxSession}.`,
    `Artifact directory: ${input.artifactDir}.`,
    "A completion notification will arrive automatically; do not poll or duplicate this work.",
  ].join("\n");
}

// ─── Agent Discovery ─────────────────────────────────────────────────────────

export function findPiDir(cwd: string): string | null {
  let current = resolve(cwd);
  while (true) {
    if (basename(current) === ".pi") {
      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
      continue;
    }
    if (existsSync(join(current, ".pi"))) return join(current, ".pi");
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function getGlobalAgentDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return join(home, ".pi", "agent", "agents");
}

export function loadAgentsFromDir(
  dir: string,
  source: "project" | "user" | "bundled",
): AgentConfig[] {
  const agents: AgentConfig[] = [];
  if (!existsSync(dir)) return agents;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = join(dir, entry.name);
    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const { frontmatter, body } = parseMarkdownFrontmatter(content);
    if (!frontmatter.description) continue;

    const name = basename(entry.name, ".md");
    const disallowedRaw = frontmatter.disallowed_tools as
      | string
      | string[]
      | undefined;
    const merged = parseMergedDisallowedTools(
      parseToolList(disallowedRaw).join(","),
    );
    const disallowedTools = merged.length > 0 ? merged : undefined;
    const tools = parseToolList(
      frontmatter.tools as string | string[] | undefined,
    );

    agents.push({
      name,
      description: frontmatter.description,
      model: frontmatter.model,
      thinking: frontmatter.thinking,
      tools: tools.length > 0 ? tools : undefined,
      disallowedTools,
      body,
      source,
      path: filePath,
    });
  }
  return agents;
}

export function discoverAgents(
  cwd: string,
  bundledAgentDir?: string,
): {
  agents: AgentConfig[];
  piDir: string;
} {
  const piDir = findPiDir(cwd) || join(cwd, ".pi");
  const projectDir = join(piDir, "agents");
  const userDir = getGlobalAgentDir();

  const bundledAgents = bundledAgentDir
    ? loadAgentsFromDir(bundledAgentDir, "bundled")
    : [];
  const userAgents = loadAgentsFromDir(userDir, "user");
  const projectAgents = loadAgentsFromDir(projectDir, "project");

  // Override order: bundled < user < project.
  const agentMap = new Map<string, AgentConfig>();
  for (const a of bundledAgents) agentMap.set(a.name, a);
  for (const a of userAgents) agentMap.set(a.name, a);
  for (const a of projectAgents) agentMap.set(a.name, a);

  return {
    agents: Array.from(agentMap.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
    piDir,
  };
}

export function formatAgentList(agents: AgentConfig[]): string {
  if (agents.length === 0) return "none available";
  return agents
    .map((a) => `${a.name} (${a.source}): ${a.description}`)
    .join("\n");
}

// ─── Sub-agent CLI args ─────────────────────────────────────────────────────

/**
 * Build pi CLI arguments for spawning or resuming a sub-agent session.
 *
 * - Fresh spawn: omit `resume` or pass falsy — `--session` is not included.
 * - Resume: pass `resume=true` — `--session <name>` is included so pi
 *   continues the existing session file in --session-dir.
 */
export function buildPiArgs(
  agent: AgentConfig,
  sessionName: string,
  sessionDir: string,
  promptContent: string,
  resume?: boolean,
  parentToolNames?: string[],
): string[] {
  return buildPiArgv({
    agent,
    sessionName,
    sessionDir,
    promptContent,
    resume,
    parentToolNames,
  });
}

    // ─── JSONL Session Helpers ───────────────────────────────────────────────────

    function matchesJsonlSessionName(content: string, sessionName?: string): boolean {
      if (!sessionName) return true;

      for (const rawLine of content.split("\n")) {
        const line = rawLine.trim();
        if (!line) continue;

        try {
          const entry = JSON.parse(line) as {
            type?: string;
            name?: string;
            session_info?: { name?: string };
          };
          if (entry.type === "session_info") {
            return (entry.name ?? entry.session_info?.name) === sessionName;
          }
        } catch {
          // Skip malformed lines
        }
      }

      return false;
    }
    
    /** Count tool uses and turns from pi JSONL session files. */
    export function countToolUses(
      sessionDir: string,
      sessionName?: string,
    ): {
      toolUses: number;
      turns: number;
    } {
      let toolUses = 0;
      let turns = 0;
    
      try {
        if (!existsSync(sessionDir)) return { toolUses, turns };
    
        const files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
        for (const file of files) {
          const content = readFileSync(join(sessionDir, file), "utf-8");
          if (!matchesJsonlSessionName(content, sessionName)) continue;

          for (const rawLine of content.split("\n")) {
            const line = rawLine.trim();
            if (!line) continue;
    
            try {
              const entry = JSON.parse(line);
              if (
                entry.type === "message" &&
                entry.message?.role === "assistant" &&
                Array.isArray(entry.message.content)
              ) {
                turns++;
                for (const block of entry.message.content) {
                  if (block.type === "toolCall") toolUses++;
                }
              }
            } catch {
              // Skip malformed lines
            }
          }
        }
      } catch {
        // Session dir might not exist or be inaccessible
      }
    
      return { toolUses, turns };
    }

// ─── JSONL Session Helpers — streaming ───────────────────────────────────────

/**
 * Extract a short, human-readable summary of a tool call's primary argument.
 * Falls back to the first string-valued property for unknown tools.
 */
export function summarizeArgs(toolName: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const v = a[k];
      if (typeof v === "string" && v.length > 0) return v;
    }
    return "";
  };
  switch (toolName) {
    case "read":
    case "write":
    case "edit":
    case "ls":
      return pick("path", "file_path");
    case "bash":
      return pick("command", "cmd");
    case "grep":
    case "codesearch":
    case "websearch":
      return pick("query", "pattern", "search_term", "glob");
    case "web_fetch":
    case "webclaw_scrape":
    case "lightpanda_markdown":
    case "lightpanda_links":
    case "lightpanda_structuredData":
      return pick("url");
    case "webclaw_batch":
      return Array.isArray(a.urls) ? `${a.urls.length} urls` : pick("urls");
    case "context7":
      return pick("libraryId", "topic", "libraryName");
    case "deepwiki":
      return pick("question", "repo");
    case "find":
      return pick("pattern", "glob");
    default: {
      // Fallback: first non-empty string property
      for (const v of Object.values(a)) {
        if (typeof v === "string" && v.length > 0) return v;
      }
      return "";
    }
  }
}

/**
 * Read the most recent tool calls from a pi JSONL session directory,
 * with each call's status (done / error / in_progress) determined by
 * whether a matching toolResult has been written.
 *
 * Returns total counts plus the last `limit` records in chronological order.
 * Safe against malformed lines and missing fields.
 */
    export function readRecentToolCalls(
      sessionDir: string,
      limit = 12,
      sessionName?: string,
    ): {
      toolUses: number;
      turns: number;
      recent: ToolCallRecord[];
    } {
  let toolUses = 0;
  let turns = 0;
  const calls: Array<{
    name: string;
    detail: string;
    id: string;
    ts: number;
  }> = [];
  const resultsById = new Map<string, { isError: boolean; ts: number }>();

  try {
    if (!existsSync(sessionDir)) return { toolUses, turns, recent: [] };

        const files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
        for (const file of files) {
          const content = readFileSync(join(sessionDir, file), "utf-8");
          if (!matchesJsonlSessionName(content, sessionName)) continue;

          for (const rawLine of content.split("\n")) {
        const line = rawLine.trim();
        if (!line) continue;

        let entry: any;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }

        const msg = entry?.message;
        if (!msg || typeof msg !== "object") continue;

        // Collect tool results first so we can match them to tool calls
        if (msg.role === "toolResult") {
          const ts =
            typeof msg.timestamp === "number"
              ? msg.timestamp
              : Date.parse(entry?.timestamp ?? "") || 0;
          if (typeof msg.toolCallId === "string") {
            resultsById.set(msg.toolCallId, {
              isError: Boolean(msg.isError),
              ts,
            });
          }
          continue;
        }

        if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

        turns++;
        for (const block of msg.content) {
          if (!block || block.type !== "toolCall") continue;
          toolUses++;
          const id = typeof block.id === "string" ? block.id : "";
          if (!id) continue; // can't match results without an id
          calls.push({
            name: typeof block.name === "string" ? block.name : "tool",
            detail: summarizeArgs(
              typeof block.name === "string" ? block.name : "",
              block.arguments,
            ),
            id,
            ts:
              typeof msg.timestamp === "number"
                ? msg.timestamp
                : Date.parse(entry?.timestamp ?? "") || 0,
          });
        }
      }
    }
  } catch {
    return { toolUses, turns, recent: [] };
  }

  // Determine status for each call, then take the last `limit` in order
  const ordered = calls.slice().sort((a, b) => a.ts - b.ts);
  const all: ToolCallRecord[] = ordered.map((c) => {
    const r = resultsById.get(c.id);
    if (!r)
      return {
        name: c.name,
        detail: c.detail,
        id: c.id,
        status: "in_progress",
      };
    return {
      name: c.name,
      detail: c.detail,
      id: c.id,
      status: r.isError ? "error" : "done",
    };
  });

  const recent = all.slice(Math.max(0, all.length - limit));
  return { toolUses, turns, recent };
}
