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
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  buildPiArgv,
  type PiPromptLaunchOptions,
} from "./subagent/buildArgv.js";


function parseMarkdownFrontmatter(content: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  // Git checkouts on Windows may provide CRLF agent files; parse the same
  // frontmatter contract regardless of checkout line endings.
  const normalizedContent = content.replace(/\r\n/g, "\n");
  if (!normalizedContent.startsWith("---\n")) {
    return { frontmatter: {}, body: content };
  }

  const end = normalizedContent.indexOf("\n---", 4);
  if (end === -1) return { frontmatter: {}, body: content };

  const raw = normalizedContent.slice(4, end).trim();
  const body = normalizedContent.slice(end + "\n---".length).replace(/^\n/, "");
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
  /** Optional Fast Mode default from frontmatter `fast:`. */
  fast?: boolean;
  /** Skill names from frontmatter `skills:`; resolved to paths before launch. */
  skills?: string[];
  /** Explicit allowlist from frontmatter `tools:` */
  tools?: string | string[];
  disallowedTools?: string[];
  hidden?: boolean;
  proactive?: boolean;
  readonly?: boolean;
  body: string;
  source: "project" | "user" | "bundled";
  path: string;
}

export interface ParsedResult {
  status: string;
  summary: string;
  findings: string;
  evidence: string;
  files: string;
  caveats: string;
  next_steps: string;
  confidence: string;
  raw: string;
}

export type TaskReportedStatus =
  | "success"
  | "failure"
  | "blocked"
  | "partial"
  | "unknown";

export interface TaskResultAssessment {
  reportedStatus: TaskReportedStatus;
  /** The child's literal status word ("stalled", "done", ...) before normalization. */
  rawStatus: string;
  valid: boolean;
}

export function assessTaskResult(result: ParsedResult): TaskResultAssessment {
  const reportedStatus = isTaskReportedStatus(result.status)
    ? result.status
    : "unknown";
  return {
    reportedStatus,
    rawStatus: result.status || "unknown",
    valid: reportedStatus !== "unknown" && result.summary.length > 0,
  };
}

/** Warning line shown to the parent when the child used a status word outside
 * the canonical vocabulary; empty when nothing was misreported. */
export function unrecognizedStatusWarning(assessment: TaskResultAssessment): string {
  if (assessment.reportedStatus !== "unknown" || assessment.rawStatus === "unknown") {
    return "";
  }
  return `Child reported status "${assessment.rawStatus}" (expected success | failure | blocked | partial); result treated as unstructured.`;
}

/** Model-visible result text: the parsed summary, prefixed with the
 * unrecognized-status warning so the child's own words reach the parent. */
export function taskResultContentText(
  parsed: ParsedResult,
  assessment: TaskResultAssessment,
): string {
  const warning = unrecognizedStatusWarning(assessment);
  return warning ? `${warning}\n\n${parsed.summary}` : parsed.summary;
}

/** Structured envelope summary for tool-result details. */
export function structuredResultPayload(assessment: TaskResultAssessment): {
  status: TaskReportedStatus;
  raw_status: string;
  valid: boolean;
} {
  return {
    status: assessment.reportedStatus,
    raw_status: assessment.rawStatus,
    valid: assessment.valid,
  };
}

function isTaskReportedStatus(status: string): status is TaskReportedStatus {
  return (
    status === "success" ||
    status === "failure" ||
    status === "blocked" ||
    status === "partial" ||
    status === "unknown"
  );
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

export const TASK_PROMPT_INSTRUCTIONS = `Your final assistant message IS the result the parent agent will read.

When you are done, end with the XML envelope described below (or the <result> block from your agent instructions). Do not write a RESULT.md file — the parent reads your final assistant message from the session JSONL, not from any file.`;

/**
 * XML envelope for the task result. The parent agent parses the child
 * subagent's final message with `parseResultXml`, which reads `<status>`,
 * `<summary>`, `<findings>`, `<evidence>`, and `<files>` tags. Append
 * this to the child prompt so the child knows to wrap its final result
 * in these tags (the parent then extracts them into the result section).
 */
export const TASK_RESULT_XML_INSTRUCTIONS = `When the task is complete, wrap the final result in this XML envelope (or the agent's <result> block with the same inner tags). Nothing after the closing tag:

<status>success | failure | blocked | partial</status>
<summary>One-line summary of the outcome.</summary>
<findings>Key findings. Plain text, multiple lines OK.</findings>
<evidence>Citations, URLs, command snippets. <sources> is accepted as an alias for evidence.</evidence>
<files>Files created or modified. Leave empty if none.</files>
<caveats>Risks, gaps, uncertainty. <blockers> is accepted as an alias.</caveats>
<next_steps>Follow-up actions. <checks> is accepted as an alias.</next_steps>
<confidence>high | medium | low</confidence>

<decisions> is merged into findings. The parent parses these tags for the task UI.`;


export const TASK_TOOL_DESCRIPTION = `Launch a subagent for a complex, multistep task that benefits from isolated context. The subagent starts with fresh context — everything it needs goes in the prompt: parent-synthesized facts, decisions, and proposed-change semantics (file paths alone are not a context handoff).

When NOT to use: file/symbol lookups (Read/Grep), 2-3 file edits (directly), or no suitable agent type (other tools).

Prompt contract (put these fields in the task request):
- Goal: the exact outcome wanted
- Parent context: facts, decisions, and constraints learned outside the referenced files
- Proposed changes: one item per change, including intended semantics and acceptance implications
- Scope and references: what to inspect, why each reference matters, and the base/diff to review; paths are evidence, not context handoff
- Non-goals: what to avoid or leave untouched
- Write/read policy: whether the agent may edit files or must stay read-only
- Acceptance criteria and stop condition: observable conditions that must be true before stopping
- Verification recipe: checks to run or evidence to gather

A reviewer request with missing parent_context or proposed_changes is rejected; if there are no design changes, pass an explicit "No proposed design changes" item. Generic tasks may omit these fields but must still copy parent reasoning into the prompt.

Usage:
1. Give complete context — the subagent's context is fresh
2. Launch independent agents concurrently; do NOT duplicate delegated work — wait or work on non-overlapping tasks
3. Background is the default (async; you'll be notified on completion); use background:false only to wait inline; never sleep/poll a background task
4. Do not trust delegated output blindly: read changed files, review the diff, verify scope, and run relevant checks before claiming completion
5. Tell the agent whether to write code or research; its result is not user-visible — send the user a concise summary
6. Pass task_id to resume a previous subagent session

Orchestration: fan-out and synthesize; adversarial verification; tournament/ranking; loop until done.

Task control:
- operation "status" + task_id: inspect a task without relaunching it
- operation "cancel" + task_id: cancel a live tmux or HerdR background task (cleanup failure → cleanup_pending + durable retry receipt; SDK cancel → unsupported)
- Omit operation for start/resume ("start"/"resume" explicit when the provider requires it); never combine "status"/"cancel" with start/resume fields`;

/** @deprecated Import from ./agent-tools.js */
export { ALL_TOOL_NAMES } from "./agent-tools.js";

// Cached regex patterns for XML result parsing
const STATUS_RE = /<status>([\s\S]*?)<\/status>/i;
const DEFAULT_DISALLOWED_TOOLS = ["xai_web_search", "xai_generate_text"];
const SUMMARY_RE = /<summary>([\s\S]*?)<\/summary>/i;
const FINDINGS_RE = /<findings>([\s\S]*?)<\/findings>/i;
const EVIDENCE_RE = /<evidence>([\s\S]*?)<\/evidence>/i;
const FILES_RE = /<files>([\s\S]*?)<\/files>/i;
const CAVEATS_RE = /<caveats>([\s\S]*?)<\/caveats>/i;
const NEXT_STEPS_RE = /<next_steps>([\s\S]*?)<\/next_steps>/i;
const CONFIDENCE_RE = /<confidence>([\s\S]*?)<\/confidence>/i;
const SOURCES_RE = /<sources>([\s\S]*?)<\/sources>/i;
const BLOCKERS_RE = /<blockers>([\s\S]*?)<\/blockers>/i;
const CHECKS_RE = /<checks>([\s\S]*?)<\/checks>/i;
const DECISIONS_RE = /<decisions>([\s\S]*?)<\/decisions>/i;
const PLAIN_SUMMARY_MAX_CHARS = 500;

// ─── Result Parsing ──────────────────────────────────────────────────────────

export function extractTag(raw: string, re: RegExp): string {
  const m = raw.match(re);
  return m ? m[1].trim() : "";
}

function joinParsedSections(...parts: string[]): string {
  return parts.map((p) => p.trim()).filter(Boolean).join("\n\n");
}

function hasStructuredResultTags(raw: string): boolean {
  const tags = [
    STATUS_RE,
    SUMMARY_RE,
    FINDINGS_RE,
    EVIDENCE_RE,
    FILES_RE,
    CAVEATS_RE,
    NEXT_STEPS_RE,
    SOURCES_RE,
    BLOCKERS_RE,
    CHECKS_RE,
    DECISIONS_RE,
  ];
  return tags.some((re) => extractTag(raw, re).length > 0);
}

export function parseResultXml(raw: string): ParsedResult {
  const status = extractTag(raw, STATUS_RE);

  if (!hasStructuredResultTags(raw)) {
    const trimmed = raw.trim();
    return {
      status: "unknown",
      summary:
        trimmed.length > PLAIN_SUMMARY_MAX_CHARS
          ? trimmed.slice(0, PLAIN_SUMMARY_MAX_CHARS)
          : trimmed,
      findings: "",
      evidence: "",
      files: "",
      caveats: "",
      next_steps: "",
      confidence: "",
      raw,
    };
  }

  const confidence = extractTag(raw, CONFIDENCE_RE);
  const findings = joinParsedSections(
    extractTag(raw, FINDINGS_RE),
    extractTag(raw, DECISIONS_RE),
  );
  const evidence = joinParsedSections(
    extractTag(raw, EVIDENCE_RE),
    extractTag(raw, SOURCES_RE),
  );
  const caveats = joinParsedSections(
    extractTag(raw, CAVEATS_RE),
    extractTag(raw, BLOCKERS_RE),
  );
  const next_steps = joinParsedSections(
    extractTag(raw, NEXT_STEPS_RE),
    extractTag(raw, CHECKS_RE),
  );

  return {
    status: status || "unknown",
    summary: extractTag(raw, SUMMARY_RE) || "",
    findings,
    evidence,
    files: extractTag(raw, FILES_RE) || "",
    caveats,
    next_steps,
    confidence: confidence || "",
    raw,
  };
}

export function buildTaskEnvelope(
  parsed: ParsedResult,
  meta: {
    agent_type: string;
    description: string;
    tool_uses: number;
    duration_ms: number;
    background: boolean;
  },
): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } {
  const assessment = assessTaskResult(parsed);
  return {
    content: [{ type: "text", text: taskResultContentText(parsed, assessment) }],
    details: {
      agent_type: meta.agent_type,
      description: meta.description,
      tool_uses: meta.tool_uses,
      duration_ms: meta.duration_ms,
      background: meta.background,
      status: assessment.reportedStatus,
      raw_status: assessment.rawStatus,
      result_valid: assessment.valid,
      summary: parsed.summary,
      findings: parsed.findings,
      evidence: parsed.evidence,
      files: parsed.files,
      caveats: parsed.caveats,
      next_steps: parsed.next_steps,
      structured_result: structuredResultPayload(assessment),
    },
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
  configuredMode?: string,
): TmuxSplitDirection {
  const mode = configuredMode?.trim().toLowerCase();
  if (mode === "horizontal") return "-h";
  if (mode === "vertical") return "-v";

  const hasGeometry =
    Number.isFinite(paneWidth) &&
    Number.isFinite(paneHeight) &&
    paneWidth > 0 &&
    paneHeight > 0;
  if (!hasGeometry) return "-v";
  return paneWidth >= 2 * paneHeight ? "-h" : "-v";
}

export type CompletionDelivery = "steer" | "followUp" | "nextTurn";

/**
 * Resolve how background task-completion results reach the parent (issue #15):
 * - `steer` (default, adaptive): while the parent is streaming, the result is
 *   injected into the current turn mid-work — no extra turn (a steer landing
 *   in the parent's final response still costs one assistant response, same
 *   as `followUp`); while idle, the trigger fires so autonomous runs react.
 *   Note: the completion reaches the model as a user-role message mid-turn,
 *   not at a natural stopping point.
 * - `followUp`: always forces a new model turn per completed task.
 * - `nextTurn`: queues the result and delivers it with the next user prompt.
 *   A queued result is held in memory only and is lost if the session ends
 *   before the next prompt; the durable task-session history retains its
 *   recovery pointer.
 * Unset, empty, or unrecognized values fall back to `steer`.
 */
export function resolveCompletionDelivery(
  configured?: string,
): CompletionDelivery {
  const mode = configured?.trim().toLowerCase();
  if (mode === "nextturn") return "nextTurn";
  if (mode === "followup") return "followUp";
  return "steer";
}

/**
 * Send options for background task-completion notifications. `triggerTurn`
 * stays true so an idle parent still gets a turn; while streaming, Pi routes
 * by `deliverAs` — `steer` folds into the current turn, `followUp` queues a
 * follow-up turn. Pi ignores `triggerTurn` for queued `nextTurn` delivery.
 */
export function completionDeliveryOptions(configured?: string): {
  triggerTurn: boolean;
  deliverAs: CompletionDelivery;
} {
  return { triggerTurn: true, deliverAs: resolveCompletionDelivery(configured) };
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
    "-d",
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
  sessionPath: string;
  backend?: "sdk" | "tmux" | "herdr";
  backendReason?: string;
}

export function formatBackgroundReceipt(input: BackgroundReceiptInput): string {
  return [
    `⎿ Started task ${input.taskId} with ${input.agentType}.`,
    ...(input.backend ? [`  Backend: ${input.backend}${input.backendReason ? ` (${input.backendReason})` : ""}`] : []),
    `  Subagent sessions: ${input.sessionPath}`,
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

function getGlobalAgentDir(): string {
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
    const hidden = parseBool(frontmatter.hidden);
    const proactive = parseBool(frontmatter.proactive);
    const readonly = parseBool(frontmatter.readonly);
    const fast = parseBool(frontmatter.fast);
    // Always-on xAI disallow list — these tools are never useful for
    // task subagents and risk leaking provider-specific behavior.
    const withDefaults = [
      ...parseToolList(disallowedRaw),
      ...DEFAULT_DISALLOWED_TOOLS,
      ...(readonly ? READONLY_TOOL_DENY : []),
    ];
    const merged = parseMergedDisallowedTools(withDefaults.join(","));
    const disallowedTools = merged.length > 0 ? merged : undefined;
    const tools = parseToolList(
      frontmatter.tools as string | string[] | undefined,
    );
    const skills = parseToolList(frontmatter.skills);

    agents.push({
      name,
      description: frontmatter.description,
      model: frontmatter.model,
      thinking: frontmatter.thinking,
      fast,
      skills: skills.length > 0 ? skills : undefined,
      tools: tools.length > 0 ? tools : undefined,
      disallowedTools,
      hidden,
      proactive,
      readonly,
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

/** Mutating tools denied when `readonly: true`. Bash is not denied — use explicit `tools:` or `disallowed_tools` to block shell. */
const READONLY_TOOL_DENY = [
  "write",
  "edit",
  "apply_patch",
] as const;

export function parseBool(value: unknown): boolean | undefined {
  if (value === true || value === "true" || value === "yes" || value === "1")
    return true;
  if (value === false || value === "false" || value === "no" || value === "0")
    return false;
  return undefined;
}

export function resolveTaskFastMode(
  taskFast: boolean | undefined,
  agentFast: boolean | undefined,
): boolean {
  return taskFast ?? agentFast ?? false;
}

function isAgentHidden(agent: AgentConfig): boolean {
  return agent.hidden === true;
}

function isAgentProactive(agent: AgentConfig): boolean {
  return agent.proactive === true;
}

function getTaskAgents(agents: AgentConfig[]): AgentConfig[] {
  return agents.filter((a) => !isAgentHidden(a));
}

export type TaskAgentPreflightError = {
  text: string;
  error: string;
};

export function resolveTaskAgentPreflight(
  agents: AgentConfig[],
  agentType: string,
): { ok: true; agent: AgentConfig } | { ok: false; result: TaskAgentPreflightError } {
  const agent = agents.find((a) => a.name === agentType);
  if (agent && isAgentHidden(agent)) {
    return {
      ok: false,
      result: {
        text: `Agent "${agentType}" is hidden and cannot be invoked via the task tool.`,
        error: `Hidden agent: ${agentType}`,
      },
    };
  }
  if (!agent) {
    const list = formatAgentList(getTaskAgents(agents));
    return {
      ok: false,
      result: {
        text: `Unknown agent: "${agentType}".\nAvailable agents:\n${list}`,
        error: `Unknown agent: ${agentType}`,
      },
    };
  }
  return { ok: true, agent };
}

export function buildTaskToolDescription(agents: AgentConfig[]): string {
  const visible = getTaskAgents(agents);
  const proactive = visible.filter(isAgentProactive);
  const proactiveBlock =
    proactive.length > 0
      ? [
          "",
          "PROACTIVE — delegate via task without user @mention when triggers match (see parent APPEND_SYSTEM.md):",
          ...proactive.map((a) => `- ${a.name}`),
        ].join("\n")
      : "";

  return [
    TASK_TOOL_DESCRIPTION,
    "",
    "Available agents:",
    formatAgentList(visible),
    proactiveBlock,
  ].join("\n");
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
     * - Resume: pass `resume=true` and optionally `resumeSessionRef` —
     *   `--session <ref>` is included so pi continues an existing session.
     */
    export function buildPiArgs(
      agent: AgentConfig,
      sessionName: string,
      sessionDir: string,
      promptContent: string,
      resume?: boolean,
      parentToolNames?: string[],
      taskToolName?: string,
      resumeSessionRef?: string,
      promptLaunch?: PiPromptLaunchOptions,
      skillPaths?: string[],
      fast?: boolean,
      fastExtensionPath?: string,
    ): string[] {
      return buildPiArgv({
        agent,
        sessionName,
        sessionDir,
        promptContent,
        resume,
        resumeSessionRef,
        parentToolNames,
        taskToolName,
        promptLaunch,
        skillPaths,
        fast,
        fastExtensionPath,
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

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r > 0 ? `${m}m ${r}s` : `${m}m`;
}

export function formatForegroundProgressText(
  progress: {
    taskId: string;
    sessionPath: string;
    agentType: string;
    toolUses: number;
    durationMs: number;
  },
  _theme: Theme,
): string {
  return [
    `⎿ Started task ${progress.taskId} with ${progress.agentType}.`,
    `  Subagent sessions: ${progress.sessionPath}`,
  ].join("\n");
}

export function formatToolCallsSummaryBlock(
  recent: ToolCallRecord[],
  maxLines = 5,
): string {
  if (recent.length === 0) return "";
  const visible = recent.slice(-maxLines);
  const hidden = recent.length - visible.length;
  const lines = visible.map((c) => `  ${c.name}`);
  if (hidden > 0) {
    lines.unshift(`  … +${hidden} earlier`);
  }
  return lines.join("\n");
}

/**
 * Subscribe to tool execution events from an AgentSession and update
 * a BackgroundTask's toolUses and recentCalls in real time.
 *
 * Returns an unsubscribe function. Call it to clean up the subscription
 * (e.g., when the session prompt completes or the task is cancelled).
 */
export function subscribeToolEvents(
  session: { subscribe(cb: (event: Record<string, unknown>) => void): () => void },
  task: { toolUses: number; recentCalls: ToolCallRecord[] },
  maxCalls = 10,
  onUpdate?: () => void,
): () => void {
  const pending = new Map<string, ToolCallRecord>();

  return session.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      const record: ToolCallRecord = {
        id: event.toolCallId as string,
        name: event.toolName as string,
        status: "in_progress",
        detail: JSON.stringify(event.args),
      };
      pending.set(record.id, record);
      task.toolUses++;
      task.recentCalls.push(record);
      if (task.recentCalls.length > maxCalls) task.recentCalls.splice(0, task.recentCalls.length - maxCalls);
      onUpdate?.();
    } else if (event.type === "tool_execution_end") {
      const existing = pending.get(event.toolCallId as string);
      if (existing) {
        existing.status = event.isError === true ? "error" : "done";
        pending.delete(existing.id);
        onUpdate?.();
      }
    }
  });
}
