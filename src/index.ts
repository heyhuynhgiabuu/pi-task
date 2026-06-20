/**
 * Task Tool — Delegate complex work to specialist agents.
 *
 * Spawns pi CLI in a tmux split pane (so you can watch it live) and
 * detects completion via RESULT.md polling. On completion, tool call
 * count and duration are reported as a notification.
 *
 * Three agent sources:
 *   - .pi/agents/*.md        project-local agents
 *   - ~/.pi/agent/agents/*.md user-global agents (fallback)
 *
 * P0: Persistent task registry (appendEntry + JSON), --session resume,
 *     sendMessage completion notification.
 * P1: Foreground mode (background:false, inline subprocess), pane death
 *     detection, 30-minute timeout.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@sinclair/typebox";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import {
  type ToolCallRecord,
  TASK_BACKGROUND_DEFAULT,
  TASK_RESULT_XML_INSTRUCTIONS,
  TASK_TOOL_DESCRIPTION,
  buildTmuxSendKeysArgs,
  formatBackgroundReceipt,
  buildPiArgs,
  parseResultXml,
  formatMs,
  shellQuote,
  discoverAgents,
  formatAgentList,
  countToolUses,
  readRecentToolCalls,
} from "./helpers.js";
import { runSdkSubagent } from "./subagent/runSdk.js";
import {
  checkTaskCompletion,
  waitForTaskCompletion as waitForSessionTaskCompletion,
} from "./subagent/waitCompletion.js";
import { buildAgentToolSelection } from "./agent-tools.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const BUNDLED_AGENT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "agents",
);
const BACKGROUND_CHECK_MS = 10_000; // poll every 10 sec
const COUNT_POLL_MS = 3_000; // update toolcall counts every 3 sec
const TASK_TIMEOUT_MS = 30 * 60 * 1_000; // 30 minutes

// ─── Types ────────────────────────────────────────────────────────────────────

interface BackgroundTask {
  dir: string;
  agentType: string;
  sessionName: string;
  paneId?: string;
  originalPane: string | null;
  description: string;
  startedAt: number;
  toolUses: number;
  turns: number;
  /** Most recent tool calls (capped), updated every COUNT_POLL_MS. */
  recentCalls: ToolCallRecord[];
}

/** Serializable subset for registry persistence. */
interface RegistryEntry {
  id: string;
  agentType: string;
  description: string;
  sessionName: string;
  startedAt: number;
  paneId?: string;
  piDir: string;
  dir: string;
}

/** Details attached to tool result for rendering. */
interface TaskDetails {
  task_id: string;
  agent_type: string;
  description: string;
  phase: "done" | "timeout" | "aborted" | "failed";
  // Completed phase
  status?: string;
  summary?: string;
  findings?: string;
  evidence?: string;
  confidence?: string;
  duration_ms?: number;
  turn_count?: number;
  tool_uses?: number;
  // Background
  background?: boolean;
  tmux_session?: string;
}

// ─── Registry helpers (durable JSON) ─────────────────────────────────────────

function readRegistry(piDir: string): RegistryEntry[] {
  const path = join(piDir, "task-registry.json");
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return [];
  }
}

function writeRegistry(piDir: string, entries: RegistryEntry[]): void {
  const path = join(piDir, "task-registry.json");
  writeFileSync(path, JSON.stringify(entries, null, 2), "utf-8");
}

// ─── Tmux Helpers ────────────────────────────────────────────────────────────

function tmuxCmd(args: string[]): string {
  return execFileSync("tmux", args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function hasTmux(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function paneExists(paneId: string): boolean {
  try {
    return tmuxCmd(["list-panes", "-a", "-F", "#{pane_id}"])
      .split("\n")
      .includes(paneId);
  } catch {
    return false;
  }
}

function getCurrentPaneId(): string | null {
  try {
    return tmuxCmd(["display-message", "-p", "#{pane_id}"]);
  } catch {
    return null;
  }
}

function splitWindowPane(
  cwd: string,
  command: string,
): { paneId: string; originalPane: string | null } {
  const originalPane = getCurrentPaneId();
  const paneId = tmuxCmd([
    "split-window",
    "-h",
    "-P",
    "-F",
    "#{pane_id}",
    "-c",
    cwd,
  ]);
  execFileSync("tmux", buildTmuxSendKeysArgs(paneId, command), {
    stdio: "ignore",
  });
  return { paneId, originalPane };
}

function killAgentPane(
  paneId: string | undefined,
  originalPane: string | null,
): void {
  if (paneId) {
    try {
      if (paneExists(paneId)) tmuxCmd(["kill-pane", "-t", paneId]);
    } catch {
      /* ignore */
    }
  }
  if (originalPane) {
    try {
      tmuxCmd(["select-pane", "-t", originalPane]);
    } catch {
      /* ignore */
    }
  }
}

// ─── Process a completed task (sendMessage + registry cleanup) ──────────────

function completeTask(
  pi: ExtensionAPI,
  id: string,
  task: BackgroundTask,
  content: string,
  phase: "done" | "timeout" | "failed",
  piDir: string,
): void {
  // Kill the tmux pane if still alive
  killAgentPane(task.paneId, task.originalPane);

  const parsed = parseResultXml(content);
  const durationMs = Date.now() - task.startedAt;

  // Send completion notification
  pi.sendMessage(
    {
      customType: "task-complete",
      content: `Background task ${id} (${task.agentType}) ${phase}.\n\nResult:\n${content}`,
      display: true,
      details: {
        task_id: id,
        agent_type: task.agentType,
        description: task.description,
        phase,
        status: phase,
        result: content,
        summary: parsed.summary,
        findings: parsed.findings,
        confidence: parsed.confidence,
        duration_ms: durationMs,
        tool_uses: task.toolUses,
        turn_count: task.turns,
      },
    },
    {
      triggerTurn: true,
      deliverAs: "followUp",
    },
  );

  // Remove from registry
  const entries = readRegistry(piDir).filter((e) => e.id !== id);
  writeRegistry(piDir, entries);
}

// ─── Extension Entry Point ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Prevent recursive loading
  if (process.env.PI_TASK_TOOL_DISABLED === "1") return;

  // ── Background task tracker ────────────────────────────────────────────
  const backgroundTasks = new Map<string, BackgroundTask>();
  const foregroundTasks = new Map<string, BackgroundTask>();
  let widgetCtx: ExtensionContext | null = null;

  // ── Restore active tasks from registry on load ──────────────────────────
  const { piDir } = discoverAgents(process.cwd());
  const registry = readRegistry(piDir);
  const staleIds: string[] = [];
  for (const entry of registry) {
    // Only restore if artifact dir still exists
    if (!existsSync(entry.dir)) {
      staleIds.push(entry.id);
      continue;
    }

    // Check if tmux pane is still alive
    const paneAlive = entry.paneId ? paneExists(entry.paneId) : false;
    if (!paneAlive) {
      staleIds.push(entry.id);
      continue;
    }

    const bgtask: BackgroundTask = {
      dir: entry.dir,
      agentType: entry.agentType,
      sessionName: entry.sessionName,
      paneId: entry.paneId,
      originalPane: null,
      description: entry.description,
      startedAt: entry.startedAt,
      toolUses: 0,
      turns: 0,
      recentCalls: [],
    };
    backgroundTasks.set(entry.id, bgtask);
  }
  if (staleIds.length) {
    writeRegistry(
      piDir,
      registry.filter((e) => !staleIds.includes(e.id)),
    );
  }

  // ── Widget / timer setup ───────────────────────────────────────────────

  let widgetTimer: ReturnType<typeof setInterval> | null = null;
  function stopWidget() {
    if (widgetTimer) {
      clearInterval(widgetTimer);
      widgetTimer = null;
    }
  }

  const countInterval = setInterval(() => {
    for (const task of [
      ...foregroundTasks.values(),
      ...backgroundTasks.values(),
    ]) {
      const sessionDir = join(task.dir, "sessions");
      // Single walk: counts + recent tool-call history with status
      const { toolUses, turns, recent } = readRecentToolCalls(sessionDir, 12);
      task.toolUses = toolUses;
      task.turns = turns;
      task.recentCalls = recent;
    }
  }, COUNT_POLL_MS);

  /**
   * Render a streaming view of one active subagent. Layout per task:
   *
   *   ⠋ Scout — SDK docs  • 1m 0s  11 toolcalls       (themed: accent + dim)
   *     ├─ ✓ websearch  Model Context Protocol 2026    (green/success)
   *     ├─ ✓ codesearch MCP reference server typescript
   *     ├─ ✗ bash  curl -sL "https://api.github.com..."  (red/error)
   *     └─ ⠹ read  /Users/.../scout.md                 (yellow/warning, animates)
   *
   * The header caret and in-progress tool marks share the same spinner
   * frame set (rotates every WIDGET_RENDER_MS based on wall-clock time,
   * so the animation cadence is stable regardless of TUI render rate).
   */
  // Theme reference is captured at setWidget time so renderWidget can use it.
  // We don't import the Theme type because it's not exported; structural typing
  // via `any` here is safe — the c() helper only calls `theme(color, text)`.
  let widgetTheme: any = null;
  // 8-frame Braille spinner. 80ms cadence = 12.5 FPS, which is the human
  // perception threshold for "smooth motion" (below ~10 FPS the brain
  // sees discrete steps; above ~12 FPS it reads as continuous rotation).
  // Full rotation: 8 × 80ms = 640ms. Used for both per-tool in-progress
  // marks AND the header caret (the "agent is active" indicator).
  const WIDGET_SPINNER_FRAMES = [
    "\u280B",
    "\u2819",
    "\u2838",
    "\u2834",
    "\u2826",
    "\u2827",
    "\u2807",
    "\u280F",
  ];
  const WIDGET_CARET_FRAMES = WIDGET_SPINNER_FRAMES;
  const WIDGET_RENDER_MS = 80;
  const WIDGET_MAX_TOOL_LINES = 12;
  const WIDGET_MAX_WIDTH = 120;
  const TREE_MIDDLE = "\u251C\u2500"; // ├─
  const TREE_LAST = "\u2514\u2500"; // └─

  function c(color: string, text: string): string {
    // widgetTheme is a Theme object with a .fg(color, text) method,
    // not a callable. Calling it as a function throws "widgetTheme is not
    // a function" which the outer try/catch in renderWidget swallows.
    return widgetTheme ? widgetTheme.fg(color, text) : text;
  }

  function renderWidget(width: number): string[] {
    // Defensive: never let a render exception kill the TUI. If anything
    // throws (theme lookup miss, malformed session JSONL, etc.), fall
    // back to a minimal single-line summary so the TUI stays alive.
    try {
      return renderWidgetInner(width);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const active = [
        ...Array.from(foregroundTasks.entries()),
        ...Array.from(backgroundTasks.entries()),
      ];
      if (active.length === 0) return [];
      const [, task] = active[0];
      return [
        truncateToWidth(
          `${task.agentType}  \u2022 ${formatMs(Date.now() - task.startedAt)}  (render error: ${msg})`,
          Math.min(width, WIDGET_MAX_WIDTH),
        ),
      ];
    }
  }

  function ensureTaskWidget(targetCtx: ExtensionContext): void {
    if (widgetCtx || targetCtx.mode !== "tui") return;
    widgetCtx = targetCtx;
    targetCtx.ui.setWidget("task", (tui, theme) => {
      widgetTheme = theme ?? null;
      widgetTimer = setInterval(() => tui.requestRender(), WIDGET_RENDER_MS);
      // Don't keep the process alive just for the widget refresh.
      widgetTimer.unref?.();
      return {
        render: (width: number) => renderWidget(width),
        invalidate: () => {},
        dispose: () => {
          widgetTheme = null;
          stopWidget();
        },
      };
    });
  }

  function clearTaskWidgetIfIdle(): void {
    if (foregroundTasks.size > 0 || backgroundTasks.size > 0) return;
    stopWidget();
    if (widgetCtx) {
      widgetCtx.ui.setWidget("task", undefined);
      widgetCtx = null;
    }
  }

  function renderWidgetInner(width: number): string[] {
    const active = [
      ...Array.from(foregroundTasks.entries()),
      ...Array.from(backgroundTasks.entries()),
    ];
    if (active.length === 0) return [];
    const now = Date.now();
    const maxWidth = Math.min(width, WIDGET_MAX_WIDTH);
    const tick = Math.floor(now / WIDGET_RENDER_MS);
    const spinner = WIDGET_SPINNER_FRAMES[tick % WIDGET_SPINNER_FRAMES.length];
    const caret = WIDGET_CARET_FRAMES[tick % WIDGET_CARET_FRAMES.length];
    const lines: string[] = [];

    for (const [, task] of active) {
      const agentName =
        task.agentType.charAt(0).toUpperCase() + task.agentType.slice(1);
      const elapsed = formatMs(now - task.startedAt);
      const total =
        task.toolUses > 0 ? `  ${task.turns || task.toolUses} toolcalls` : "";

      const description = task.description ? ` — ${task.description}` : "";

      // Header: ▼ <Agent> — <description>  • 1m 0s  11 toolcalls
      const header =
        c("accent", caret) +
        " " +
        c("toolTitle", agentName) +
        c("dim", `${description}  \u2022 ${elapsed}${total}`);
      lines.push(truncateToWidth(header, maxWidth));

      const recent = task.recentCalls ?? [];
      if (recent.length > 0) {
        const slice = recent.slice(-WIDGET_MAX_TOOL_LINES);
        slice.forEach((tc, idx) => {
          const isLast = idx === slice.length - 1;
          const connector = isLast ? TREE_LAST : TREE_MIDDLE;
          const isInProgress = tc.status === "in_progress";
          const markChar = isInProgress
            ? spinner
            : tc.status === "error"
              ? "\u2717"
              : "\u2713";
          const markColor = isInProgress
            ? "warning"
            : tc.status === "error"
              ? "error"
              : "success";
          const detailStr = tc.detail ? `  ${tc.detail}` : "";
          const line =
            "  " +
            c("dim", connector) +
            " " +
            c(markColor, markChar) +
            " " +
            c("text", tc.name) +
            c("dim", detailStr);
          lines.push(truncateToWidth(line, maxWidth));
        });
      }
      lines.push("");
    }
    return lines;
  }

  // ── Polling loop (background task completion, pane death, timeout) ──────

  const checkInterval = setInterval(async () => {
    if (backgroundTasks.size === 0) {
      clearTaskWidgetIfIdle();
      return;
    }

    const now = Date.now();
    const ids = Array.from(backgroundTasks.keys());

    for (const id of ids) {
      const task = backgroundTasks.get(id);
      if (!task) continue;
      backgroundTasks.delete(id); // Remove atomically

      // ── Check timeout ────────────────────────────────────────────
      if (now - task.startedAt > TASK_TIMEOUT_MS) {
        killAgentPane(task.paneId, task.originalPane);
        completeTask(
          pi,
          id,
          task,
          "Task timed out after 30 minutes",
          "timeout",
          piDir,
        );
        continue;
      }

      const snapshot = await checkTaskCompletion({
        resultPath: join(task.dir, "RESULT.md"),
        sessionDir: task.dir,
        sessionName: task.sessionName,
        paneId: task.paneId,
      });

      if (snapshot.status === "running") {
        backgroundTasks.set(id, task);
        continue;
      }

      const phase = snapshot.status === "completed" ? "done" : "failed";
      completeTask(pi, id, task, snapshot.content, phase, piDir);
    }
  }, BACKGROUND_CHECK_MS);

  // ── Cleanup on shutdown ────────────────────────────────────────────────

  pi.on("session_shutdown", () => {
    clearInterval(checkInterval);
    clearInterval(countInterval);
    stopWidget();
    if (widgetCtx) {
      widgetCtx.ui.setWidget("task", undefined);
      widgetCtx = null;
    }
  });

  // ── Custom notification renderer ───────────────────────────────────────

  pi.registerMessageRenderer?.(
    "task-complete",
    (message, { expanded }, theme) => {
      const d = message.details as Record<string, unknown> | undefined;
      if (!d) return undefined;

      const agentType = (d.agent_type as string) || "";
      const desc = (d.description as string) || "";
      const summary = (d.summary as string) || "";
      const findings = (d.findings as string) || "";
      const confidence = (d.confidence as string) || "";
      const durationMs = (d.duration_ms as number) || 0;
      const toolUses = (d.tool_uses as number) || 0;
      const turns = (d.turn_count as number) || 0;

      let line = theme.fg("accent", agentType);
      if (desc) line += theme.fg("dim", ` - ${desc}`);

      const useStr = toolUses > 0 ? `${turns || toolUses} toolcalls` : "";
      const durStr = durationMs >= 1000 ? formatMs(durationMs) : "";
      const statsParts = [useStr, durStr].filter(Boolean);
      if (statsParts.length) {
        line += "\n" + theme.fg("dim", statsParts.join(" • "));
      }

      const confStr = confidence ? confidence.toUpperCase() : "";
      if (confStr && (statsParts.length || expanded)) {
        const confColor =
          confidence === "high"
            ? "success"
            : confidence === "low"
              ? "error"
              : "accent";
        line += "\n" + theme.fg(confColor as any, `[${confStr}]`);
      }

      if (expanded) {
        if (summary) line += "\n" + theme.fg("muted", summary);
        if (findings) line += "\n" + theme.fg("dim", findings);
      }

      if (!line.trim()) return undefined;
      return new Text(line, 0, 0);
    },
  );

  // ── Tool Registration ──────────────────────────────────────────────────

  pi.registerTool({
    name: "task",
    label: "Task",
    description: TASK_TOOL_DESCRIPTION,
    promptSnippet: "Delegate work to a specialist agent via the task tool",
    promptGuidelines: [
      "Delegate complex multi-step work to a specialist agent when the work benefits from isolated context",
      "Launch multiple agents concurrently by making multiple tool calls in a single message",
      "Do NOT duplicate work you've delegated — wait for the result or work on non-overlapping tasks",
      "Use agent_type to route to the right specialist",
      "Tell the agent whether to write code or just research",
      "For background tasks: DO NOT sleep, poll, or check on progress. You'll be notified",
      "After delegated work completes, read changed files, review diff, verify scope, and run relevant checks",
      "Send the user a concise summary of the result since the agent's output is not user-visible",
    ],
    parameters: Type.Object({
      agent_type: Type.String({
        description: "The type of specialist agent to use for this task",
      }),
      prompt: Type.String({
        description:
          "The complete task for the agent to perform. Be detailed and self-contained.",
      }),
      description: Type.String({
        description: "A short (3-5 word) summary of the task",
      }),
      task_id: Type.Optional(
        Type.String({
          description:
            "Resume a previous task by ID (continues the same subagent session with its prior context instead of creating a fresh one)",
        }),
      ),
      background: Type.Optional(
        Type.Boolean({
          description:
            "Run in background (async). You will be notified when it completes. DO NOT sleep, poll, ask the task for status, or duplicate its work while it runs in background.",
          default: true,
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const { agents, piDir } = discoverAgents(ctx.cwd, BUNDLED_AGENT_DIR);
      const parentToolNames = pi
        .getAllTools()
        .map((tool) => tool.name)
        .filter(Boolean);
      const agent = agents.find((a) => a.name === params.agent_type);

      if (!agent) {
        const list = formatAgentList(agents);
        return {
          content: [
            {
              type: "text" as const,
              text: `Unknown agent: "${params.agent_type}".\nAvailable agents:\n${list}`,
            },
          ],
          details: {
            phase: "failed" as const,
            error: `Unknown agent: ${params.agent_type}`,
          },
          isError: true,
        };
      }

      // ── Resolve task identity: new or resume ───────────────────────────
      let id: string;
      let sessionName: string;
      let artifactDir: string;
      let resultPath: string;
      let resume = false;

      if (params.task_id) {
        // Look up the task in the persistent registry
        const entries = readRegistry(piDir);
        const entry = entries.find((e) => e.id === params.task_id);
        if (!entry) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Unknown task_id: "${params.task_id}". No task with that ID found in the registry.`,
              },
            ],
            details: {
              phase: "failed" as const,
              error: `Unknown task_id: ${params.task_id}`,
            },
            isError: true,
          };
        }
        if (!existsSync(entry.dir)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Task "${params.task_id}" artifact directory no longer exists: ${entry.dir}`,
              },
            ],
            details: {
              phase: "failed" as const,
              error: "Task artifact dir missing",
            },
            isError: true,
          };
        }
        // Resume: reuse existing artifact dir and session name
        id = entry.id;
        sessionName = entry.sessionName;
        artifactDir = entry.dir;
        resultPath = join(artifactDir, "RESULT.md");
        resume = true;

        // If background and pane still alive, reattach to tracker
        if (
          params.background !== false &&
          entry.paneId &&
          paneExists(entry.paneId)
        ) {
          const bgtask: BackgroundTask = {
            dir: artifactDir,
            agentType: agent.name,
            sessionName,
            paneId: entry.paneId,
            originalPane: null,
            description: params.description || entry.agentType,
            startedAt: entry.startedAt,
            toolUses: 0,
            turns: 0,
            recentCalls: [],
          };
          backgroundTasks.set(id, bgtask);

          return {
            content: [
              {
                type: "text" as const,
                text: `Resumed task "${params.task_id}". The subagent is running in background and will notify on completion.`,
              },
            ],
            details: {
              task_id: id,
              agent_type: agent.name,
              description: params.description,
              tmux_session: sessionName,
              background: true,
            },
          };
        }
      } else {
        id = `${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`;
        sessionName = `task-${id}`;
        artifactDir = join(piDir, "artifacts", sessionName);
        await mkdir(artifactDir, { recursive: true });
        resultPath = join(artifactDir, "RESULT.md");
      }

      const descText = params.description || "";
      const isBackground = params.background ?? TASK_BACKGROUND_DEFAULT;
      // default true

      // ── Write durable task context ──────────────────────────────────────
      const contextPath = join(artifactDir, "CONTEXT.md");
      const contextContent = [
        `# Task: ${descText}`,
        "",
        `## Agent`,
        `${agent.name} (${agent.source})`,
        "",
        `## Instructions`,
        params.prompt,
        "",
        `## Working Directory`,
        ctx.cwd,
        "",
        `## Output`,
        `Write your result to ${resultPath}`,
        "",
        "Use this format:",
        "",
        "```",
        TASK_RESULT_XML_INSTRUCTIONS,
        "```",
      ].join("\n");
      await writeFile(contextPath, contextContent, "utf-8");

      const promptContent = [
        `Read ${contextPath} for your task.`,
        `Write your findings/output to ${resultPath}`,
        "",
        "Format:",
        TASK_RESULT_XML_INSTRUCTIONS,
      ].join("\n");

      const sessionDir = join(artifactDir, "sessions");
      await mkdir(sessionDir, { recursive: true });

      // ─── Build and run the sub-agent pi process ──────────────────────────
      const piArgs = buildPiArgs(
        agent,
        sessionName,
        sessionDir,
        promptContent,
        resume,
        parentToolNames,
      );
      const envPrefix = `PI_TASK_TOOL_DISABLED=1`;
      const toolSelection = buildAgentToolSelection({
        tools: agent.tools,
        disallowedTools: agent.disallowedTools,
        parentToolNames,
      });
      const runSdkFallback = async () =>
        runSdkSubagent({
          prompt: promptContent,
          agent,
          cwd: ctx.cwd,
          ctx,
          model: agent.model,
          thinkingLevel: agent.thinking,
          tools: toolSelection.tools,
          excludeTools: toolSelection.excludeTools,
          systemPrompt: agent.body,
        });
      const foregroundTask: BackgroundTask | undefined = isBackground
        ? undefined
        : {
            dir: artifactDir,
            agentType: agent.name,
            sessionName,
            originalPane: null,
            description: descText,
            startedAt: Date.now(),
            toolUses: 0,
            turns: 0,
            recentCalls: [],
          };
      if (foregroundTask) {
        foregroundTasks.set(id, foregroundTask);
        ensureTaskWidget(ctx);
      }

      // Prefer tmux for observability, but fall back to the SDK in headless/CI/RPC.
      if (!hasTmux()) {
        if (isBackground) {
          const bgtask: BackgroundTask = {
            dir: artifactDir,
            agentType: agent.name,
            sessionName,
            originalPane: null,
            description: descText,
            startedAt: Date.now(),
            toolUses: 0,
            turns: 0,
            recentCalls: [],
          };
          backgroundTasks.set(id, bgtask);
          const entry: RegistryEntry = {
            id,
            agentType: agent.name,
            description: descText,
            sessionName,
            startedAt: bgtask.startedAt,
            piDir,
            dir: artifactDir,
          };
          const entries = readRegistry(piDir);
          entries.push(entry);
          writeRegistry(piDir, entries);
          pi.appendEntry("task-registry", entry);
          ensureTaskWidget(ctx);

          void runSdkFallback()
            .then(async ({ output }) => {
              const finalOutput =
                output || "SDK subagent completed without assistant text.";
              await writeFile(resultPath, finalOutput, "utf-8");
              backgroundTasks.delete(id);
              clearTaskWidgetIfIdle();
              completeTask(pi, id, bgtask, finalOutput, "done", piDir);
            })
            .catch((error) => {
              const message =
                error instanceof Error ? error.message : String(error);
              backgroundTasks.delete(id);
              clearTaskWidgetIfIdle();
              completeTask(
                pi,
                id,
                bgtask,
                `Task ${id} failed: ${message}`,
                "failed",
                piDir,
              );
            });

          return {
            content: [
              {
                type: "text" as const,
                text: `Task ${id} started with SDK backend (tmux unavailable).`,
              },
            ],
            details: {
              task_id: id,
              background: true,
              backend: "sdk" as const,
              result_path: resultPath,
            },
          };
        }

        try {
          const { output, sessionPath } = await runSdkFallback();
          const finalOutput =
            output || "SDK subagent completed without assistant text.";
          await writeFile(resultPath, finalOutput, "utf-8");
          return {
            content: [{ type: "text" as const, text: finalOutput }],
            details: {
              phase: "done" as const,
              backend: "sdk" as const,
              session_path: sessionPath,
              result_path: resultPath,
            },
          };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          return {
            content: [
              { type: "text" as const, text: `SDK task failed: ${message}` },
            ],
            details: {
              phase: "failed" as const,
              backend: "sdk" as const,
              error: message,
            },
            isError: true,
          };
        } finally {
          foregroundTasks.delete(id);
          clearTaskWidgetIfIdle();
        }
      }

      const shellCommand = `${envPrefix} pi ${piArgs.map((a) => shellQuote(a)).join(" ")}`;

      let paneId: string;
      let originalPane: string | null;
      try {
        const splitResult = splitWindowPane(
          ctx.cwd,
          `cd ${shellQuote(ctx.cwd)} && ${shellCommand}`,
        );
        paneId = splitResult.paneId;
        originalPane = splitResult.originalPane;
        if (foregroundTask) {
          foregroundTask.paneId = paneId;
          foregroundTask.originalPane = originalPane;
        }
      } catch {
        foregroundTasks.delete(id);
        clearTaskWidgetIfIdle();
        return {
          content: [
            {
              type: "text" as const,
              text: "Failed to create tmux split pane for the agent.",
            },
          ],
          details: { phase: "failed" as const, error: "tmux split failed" },
          isError: true,
        };
      }

      // ── FOREGROUND MODE: block until result, return directly ────────────
      if (!isBackground) {
        const startedAt = Date.now();
        const completion = await waitForSessionTaskCompletion({
          resultPath,
          sessionDir,
          sessionName,
          paneId,
          signal,
          timeoutMs: 30 * 60 * 1000,
        });
        const content = completion.content;
        const phase =
          completion.status === "completed"
            ? "done"
            : completion.status === "cancelled"
              ? "cancelled"
              : "failed";
        killAgentPane(paneId, originalPane);
        foregroundTasks.delete(id);
        clearTaskWidgetIfIdle();

        const parsed = parseResultXml(content);
        const durationMs = Date.now() - startedAt;
        const { toolUses, turns } = countToolUses(sessionDir);

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `${parsed.status || "done"}: ${parsed.summary || content.slice(0, 300)}`,
                toolUses > 0 ? `\n${turns || toolUses} toolcalls` : "",
                durationMs >= 1000 ? `\n${formatMs(durationMs)}` : "",
              ]
                .filter(Boolean)
                .join(""),
            },
          ],
          details: {
            task_id: id,
            agent_type: agent.name,
            description: descText,
            phase,
            status: phase === "done" ? parsed.status || "done" : phase,
            summary: parsed.summary || "",
            findings: parsed.findings || "",
            evidence: parsed.evidence || "",
            confidence: parsed.confidence || "",
            duration_ms: durationMs,
            tool_uses: toolUses,
            turn_count: turns,
            background: false,
          },
        };
      }

      // ── BACKGROUND MODE (default): add to tracker, return immediately ─────

      const bgtask: BackgroundTask = {
        dir: artifactDir,
        agentType: agent.name,
        sessionName,
        paneId,
        originalPane,
        description: descText,
        startedAt: Date.now(),
        toolUses: 0,
        turns: 0,
        recentCalls: [],
      };
      backgroundTasks.set(id, bgtask);

      // ── P0: Persistent registry ────────────────────────────────────────
      const entry: RegistryEntry = {
        id,
        agentType: agent.name,
        description: descText,
        sessionName,
        startedAt: Date.now(),
        paneId,
        piDir,
        dir: artifactDir,
      };
      // Write to JSON registry for on-load restore
      const entries = readRegistry(piDir);
      entries.push(entry);
      writeRegistry(piDir, entries);
      // Also persist to session store via appendEntry (audit trail)
      pi.appendEntry("task-registry", entry);

      // ── Abort signal handling ──────────────────────────────────────────
      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            killAgentPane(paneId, originalPane);
            backgroundTasks.delete(id);
            clearTaskWidgetIfIdle();
            // Clean registry
            const remaining = readRegistry(piDir).filter((e) => e.id !== id);
            writeRegistry(piDir, remaining);
            if (backgroundTasks.size === 0) {
              stopWidget();
              if (widgetCtx) {
                widgetCtx.ui.setWidget("task", undefined);
                widgetCtx = null;
              }
            }
          },
          { once: true },
        );
      }

      // ── Sticky widget ──────────────────────────────────────────────────
      ensureTaskWidget(ctx);

      return {
        content: [
          {
            type: "text" as const,
            text: formatBackgroundReceipt({
              taskId: id,
              agentType: agent.name,
              tmuxSession: sessionName,
              artifactDir,
            }),
          },
        ],
        details: {
          task_id: id,
          agent_type: agent.name,
          description: descText,
          tmux_session: sessionName,
          background: true,
        },
      };
    },

    renderCall(args, theme, _context) {
      const agentName =
        ((args as Record<string, unknown>).agent_type as string) || "...";
      const desc =
        ((args as Record<string, unknown>).description as string) || "";

      let text = theme.fg("toolTitle", "");
      text += theme.fg("accent", agentName);
      if (desc) text += theme.fg("dim", ` - ${desc}`);
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme, _context) {
      const d = result.details as TaskDetails | undefined;
      if (!d) return new Text("", 0, 0);

      if (d.background) {
        return new Text("", 0, 0);
      }

      if (
        d.phase === "timeout" ||
        d.phase === "aborted" ||
        d.phase === "failed"
      ) {
        const line =
          theme.fg("error", "x") + " " + theme.fg("dim", `[${d.phase}]`);
        return new Text(line, 0, 0);
      }

      const isError =
        d.status === "failure" ||
        d.status === "blocked" ||
        d.status === "unknown" ||
        d.status === "timeout" ||
        d.status === "failed";

      const durationMs = d.duration_ms || 0;
      const toolUses = d.tool_uses || 0;
      const turns = d.turn_count || 0;

      const useStr = toolUses > 0 ? `${turns || toolUses} toolcalls` : "";
      const durStr = durationMs >= 1000 ? formatMs(durationMs) : "";
      const statsParts = [useStr, durStr].filter(Boolean);
      const statsStr = statsParts.length
        ? " " + theme.fg("dim", statsParts.join(" • "))
        : "";

      const icon = isError ? theme.fg("error", "x") : theme.fg("success", "✓");
      const statusLabel = d.status && d.status !== "done" ? d.status : "done";
      let line =
        icon +
        " " +
        theme.fg(isError ? "error" : "success", statusLabel) +
        statsStr;

      if (expanded) {
        const s = d.summary || "";
        const f = d.findings || "";
        const e = d.evidence || "";
        if (s) line += "\n" + theme.fg("muted", s);
        if (f) line += "\n" + theme.fg("dim", f);
        if (e)
          line += "\n" + theme.fg("muted", "Evidence: ") + theme.fg("dim", e);
      } else {
        const preview = (d.summary || "").slice(0, 80);
        if (preview) line += "\n" + theme.fg("dim", `  ⎿  ${preview}`);
        else
          line +=
            "\n" +
            theme.fg("dim", `  ⎿  ${isError ? d.status || "error" : "Done"}`);
      }

      return new Text(line, 0, 0);
    },
  });
}
