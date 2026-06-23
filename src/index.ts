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

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { buildAgentToolSelection } from "./agent-tools.js";
import {
  normalizeConversationId,
  parseMetadataFromBody,
  readTaskBlock,
  readTaskSessionsRegistry,
  renderConversationSessions,
  writeConversationArtifacts,
  writeTaskSessionsRegistry,
} from "./conversation.js";
import {
  type ToolCallRecord,
  TASK_BACKGROUND_DEFAULT,
  TASK_RESULT_XML_INSTRUCTIONS,
  TASK_TOOL_DESCRIPTION,
  buildTmuxSplitWindowArgs,
  chooseTmuxSplitDirection,
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
  type TaskCompletionSnapshot,
  checkTaskCompletion,
  waitForTaskCompletion as waitForSessionTaskCompletion,
} from "./subagent/waitCompletion.js";
import {
  renderTaskWidget,
  TASK_WIDGET_RENDER_MS,
  type ThemeLike,
} from "./task-widget.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const BUNDLED_AGENT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "agents",
);
const BACKGROUND_CHECK_MS = 10_000; // poll every 10 sec
const COUNT_POLL_MS = 3_000; // update toolcall counts every 3 sec
const TASK_TIMEOUT_MS = 30 * 60 * 1_000; // 30 minutes
const MAX_POLL_ERRORS = 3; // consecutive poll failures before giving up on a task

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
  conversationId?: string;
  /** Most recent tool calls (capped), updated every COUNT_POLL_MS. */
  recentCalls: ToolCallRecord[];
  /** Consecutive completion-poll failures; reset to 0 on a successful poll. */
  pollErrors?: number;
}

/** Serializable subset for active task registry persistence. */
interface RegistryEntry {
  id: string;
  agentType: string;
  description: string;
  sessionName: string;
  startedAt: number;
  paneId?: string;
  piDir: string;
  dir: string;
  conversationId?: string;
  sessionRef?: string;
}

/** Durable task→session mapping used for resume after task completion. */
interface TaskSessionHistoryEntry extends RegistryEntry {
  status: "running" | "done" | "cancelled" | "aborted" | "failed" | "timeout";
  completedAt?: number;
  background: boolean;
}

export /** Details attached to tool result for rendering. */
interface TaskDetails {
  task_id: string;
  agent_type: string;
  description: string;
  conversation_id?: string;
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

// Conversation helpers live in ./conversation.js.

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

function readTaskSessionHistory(piDir: string): TaskSessionHistoryEntry[] {
  const path = join(piDir, "task-session-history.json");
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return [];
  }
}

function writeTaskSessionHistory(
  piDir: string,
  entries: TaskSessionHistoryEntry[],
): void {
  const path = join(piDir, "task-session-history.json");
  writeFileSync(path, JSON.stringify(entries, null, 2), "utf-8");
}

function upsertTaskSessionHistory(
  piDir: string,
  entry: TaskSessionHistoryEntry,
): void {
  const entries = readTaskSessionHistory(piDir);
  const index = entries.findIndex((existing) => existing.id === entry.id);
  if (index >= 0) {
    entries[index] = { ...entries[index], ...entry };
  } else {
    entries.push(entry);
  }
  writeTaskSessionHistory(piDir, entries);
}

function findTaskSessionHistory(
  piDir: string,
  idOrSessionName: string,
): TaskSessionHistoryEntry | undefined {
  return readTaskSessionHistory(piDir).find(
    (entry) =>
      entry.id === idOrSessionName || entry.sessionName === idOrSessionName,
  );
}

function findJsonlSessionByName(
  piDir: string,
  sessionName: string,
  agentType: string,
): TaskSessionHistoryEntry | undefined {
  const artifactsDir = join(piDir, "artifacts");
  const sessionDir = join(artifactsDir, "sessions");
  try {
    if (!existsSync(sessionDir)) return undefined;
    const files = readdirSync(sessionDir)
      .filter((file) => file.endsWith(".jsonl"))
      .sort()
      .reverse();
    for (const file of files) {
      const content = readFileSync(join(sessionDir, file), "utf-8");
      let startedAt = Date.now();
      for (const rawLine of content.split("\n")) {
        const line = rawLine.trim();
        if (!line) continue;
        try {
          const entry = JSON.parse(line) as {
            type?: string;
            timestamp?: string;
            name?: string;
            session_info?: { name?: string };
          };
          if (entry.type === "session" && entry.timestamp) {
            const parsed = Date.parse(entry.timestamp);
            if (Number.isFinite(parsed)) startedAt = parsed;
          }
          if (entry.type === "session_info") {
            const name = entry.name ?? entry.session_info?.name;
            if (name === sessionName) {
              return {
                id: sessionName,
                agentType,
                description: `Resumed session ${sessionName}`,
                sessionName,
                sessionRef: join(sessionDir, file),
                startedAt,
                piDir,
                dir: artifactsDir,
                status: "done",
                background: false,
              };
            }
            break;
          }
        } catch {
          // Skip malformed lines
        }
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
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

function getCurrentPaneSize(
  targetPane?: string | null,
): { width: number; height: number } | null {
  try {
    const args = ["display-message", "-p", "#{pane_width} #{pane_height}"];
    if (targetPane) args.splice(1, 0, "-t", targetPane);
    const raw = tmuxCmd(args);
    const [widthRaw, heightRaw] = raw.trim().split(/\s+/, 2);
    const width = Number(widthRaw);
    const height = Number(heightRaw);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
    return { width, height };
  } catch {
    return null;
  }
}

function splitWindowPane(
  cwd: string,
  command: string,
): { paneId: string; originalPane: string | null } {
  const originalPane = getCurrentPaneId();
  const paneSize = getCurrentPaneSize(originalPane);
  const direction = chooseTmuxSplitDirection(
    paneSize?.width ?? 0,
    paneSize?.height ?? 0,
  );
  const paneId = tmuxCmd(
    buildTmuxSplitWindowArgs(cwd, command, direction, originalPane),
  );
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
  const completedSessionRef = findJsonlSessionByName(
    piDir,
    task.sessionName,
    task.agentType,
  )?.sessionRef;

  upsertTaskSessionHistory(piDir, {
    id,
    agentType: task.agentType,
    description: task.description,
    sessionName: task.sessionName,
    startedAt: task.startedAt,
    paneId: task.paneId,
    piDir,
    dir: task.dir,
    conversationId: task.conversationId,
    sessionRef: completedSessionRef,
    status: phase,
    completedAt: Date.now(),
    background: true,
  });

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
      conversationId: entry.conversationId,
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
      const { toolUses, turns, recent } = readRecentToolCalls(
        sessionDir,
        12,
        task.sessionName,
      );
      task.toolUses = toolUses;
      task.turns = turns;
      task.recentCalls = recent;
    }
  }, COUNT_POLL_MS);

  // Theme reference is captured at setWidget time so renderWidget can use it.
  let widgetTheme: ThemeLike | null = null;

  function renderWidget(width: number): string[] {
    // Defensive: never let a render exception kill the TUI. If anything
    // throws (theme lookup miss, malformed session JSONL, etc.), fall
    // back to a minimal single-line summary so the TUI stays alive.
    try {
      return renderTaskWidget({
        foregroundTasks: foregroundTasks.entries(),
        backgroundTasks: backgroundTasks.entries(),
        foregroundCount: foregroundTasks.size,
        backgroundCount: backgroundTasks.size,
        width,
        theme: widgetTheme,
      });
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
          Math.min(width, 120),
        ),
      ];
    }
  }

  function ensureTaskWidget(targetCtx: ExtensionContext): void {
    if (widgetCtx || targetCtx.mode !== "tui") return;
    widgetCtx = targetCtx;
    targetCtx.ui.setWidget("task", (tui, theme) => {
      widgetTheme = theme ?? null;
      widgetTimer = setInterval(
        () => tui.requestRender(),
        TASK_WIDGET_RENDER_MS,
      );
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

  // ── Polling loop (background task completion, pane death, timeout) ──────

  // setInterval does not wait for an async callback to settle, so a slow pass
  // (many tasks / slow fs) could overlap the next one and double-complete a
  // task. This guard makes ticks that fire mid-pass no-ops.
  let checkInFlight = false;

  const checkInterval = setInterval(async () => {
    if (checkInFlight) return;
    if (backgroundTasks.size === 0) {
      clearTaskWidgetIfIdle();
      return;
    }
    checkInFlight = true;

    try {
      const now = Date.now();
      const ids = Array.from(backgroundTasks.keys());

      for (const id of ids) {
        const task = backgroundTasks.get(id);
        if (!task) continue;

        // ── Check timeout ────────────────────────────────────────────
        if (now - task.startedAt > TASK_TIMEOUT_MS) {
          killAgentPane(task.paneId, task.originalPane);
          backgroundTasks.delete(id);
          clearTaskWidgetIfIdle();
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

        // A transient fs error here (RESULT.md mid-write, EACCES, dir briefly
        // missing) must NOT drop the task. Keep it tracked and retry on the
        // next tick; only give up after repeated failures (the timeout above
        // is the ultimate backstop).
        let snapshot: TaskCompletionSnapshot;
        try {
          snapshot = await checkTaskCompletion({
            resultPath: join(task.dir, "RESULT.md"),
            sessionDir: join(task.dir, "sessions"),
            sessionName: task.sessionName,
            paneId: task.paneId,
            sinceMs: task.startedAt,
          });
        } catch (err) {
          task.pollErrors = (task.pollErrors ?? 0) + 1;
          if (task.pollErrors >= MAX_POLL_ERRORS) {
            killAgentPane(task.paneId, task.originalPane);
            backgroundTasks.delete(id);
            clearTaskWidgetIfIdle();
            const message = err instanceof Error ? err.message : String(err);
            completeTask(
              pi,
              id,
              task,
              `Task ${id} polling failed ${task.pollErrors}x; last error: ${message}`,
              "failed",
              piDir,
            );
          }
          // Otherwise leave the task tracked and retry next tick.
          continue;
        }

        // Successful poll clears the error streak.
        task.pollErrors = 0;

        if (snapshot.status === "running") {
          continue;
        }

        const phase = snapshot.status === "completed" ? "done" : "failed";
        backgroundTasks.delete(id);
        clearTaskWidgetIfIdle();
        completeTask(pi, id, task, snapshot.content, phase, piDir);
      }
    } finally {
      checkInFlight = false;
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

      let line = " " + theme.fg("accent", agentType);
      if (desc) line += theme.fg("dim", ` - ${desc}`);

      const useStr = toolUses > 0 ? `${toolUses} toolcalls` : "";
      const durStr = durationMs >= 1000 ? formatMs(durationMs) : "";
      const statsParts = [useStr, durStr].filter(Boolean);
      const statsText = statsParts.join(" • ");
      const confStr = confidence ? confidence.toUpperCase() : "";
      const confColor =
        confidence === "high"
          ? "success"
          : confidence === "low"
            ? "error"
            : "accent";

      if (statsText || confStr) {
        line += "\n ";
        if (confStr) line += theme.fg(confColor as any, `[${confStr}]`);
        if (statsText)
          line += (confStr ? " " : "") + theme.fg("dim", statsText);
      }

      if (expanded) {
        if (summary) line += "\n " + theme.fg("muted", summary);
        if (findings) line += "\n " + theme.fg("dim", findings);
      }

      if (!line.trim()) return undefined;
      const subtleBg = (text: string) => `\x1b[48;2;30;28;44m${text}\x1b[0m`;
      return new Text(line, 0, 1, subtleBg);
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
            "Resume an existing background task by id instead of starting a new task.",
        }),
      ),
      conversation_id: Type.Optional(
        Type.String({
          description:
            "Durable specialist conversation id. Reuses .pi/artifacts/task-<id>/sessions when called again.",
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

      // ── Resolve task identity: new, task resume, or conversation resume ──
      const conversationId = normalizeConversationId(params.conversation_id);
      const taskSessionsRegistry = conversationId
        ? readTaskSessionsRegistry(piDir)
        : {};
      const registeredTaskId = conversationId
        ? taskSessionsRegistry[conversationId]?.task_id
        : undefined;

      if (
        params.task_id &&
        registeredTaskId &&
        params.task_id !== registeredTaskId
      ) {
        return {
          content: [
            {
              type: "text" as const,
              text: `conversation_id "${conversationId}" maps to ${registeredTaskId}, not ${params.task_id}. Omit task_id or use the mapped task id.`,
            },
          ],
          details: {
            phase: "failed" as const,
            error: "conversation_id/task_id mismatch",
          },
          isError: true,
        };
      }

      let id: string;
      let sessionName: string;
      let resultPath: string;
      let resume = false;
      let resumeSessionRef: string | undefined;

      const artifactsDir = join(piDir, "artifacts");

      if (registeredTaskId) {
        id = registeredTaskId;
        sessionName = conversationId ?? `task-${id}`;
        resultPath = join(artifactsDir, `RESULT-${id}.md`);
        if (!existsSync(resultPath)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `conversation_id "${conversationId}" has no prior result file at ${resultPath}. Cannot resume.`,
              },
            ],
            details: {
              phase: "failed" as const,
              error: "Conversation result missing",
              conversation_id: conversationId,
            },
            isError: true,
          };
        }
        const block = readTaskBlock(piDir, id);
        const previousMetadata = parseMetadataFromBody(block?.body);
        const metadataAgent = previousMetadata?.agent_type;
        if (metadataAgent && metadataAgent !== agent.name) {
          return {
            content: [
              {
                type: "text" as const,
                text: `conversation_id "${conversationId}" belongs to agent "${metadataAgent}", not "${agent.name}". Use the original agent_type or start a different conversation_id.`,
              },
            ],
            details: {
              phase: "failed" as const,
              error: "conversation_id agent_type mismatch",
              conversation_id: conversationId,
            },
            isError: true,
          };
        }
        resume = true;

        const entry = readRegistry(piDir).find(
          (candidate) => candidate.id === id,
        );
        if (
          params.background !== false &&
          entry?.paneId &&
          paneExists(entry.paneId)
        ) {
          const bgtask: BackgroundTask = {
            dir: artifactsDir,
            agentType: entry.agentType,
            sessionName,
            paneId: entry.paneId,
            originalPane: null,
            description: params.description || entry.description,
            startedAt: entry.startedAt,
            toolUses: 0,
            turns: 0,
            conversationId,
            recentCalls: [],
          };
          backgroundTasks.set(id, bgtask);

          return {
            content: [
              {
                type: "text" as const,
                text: `Resumed conversation "${conversationId}" via ${sessionName}. The subagent is running in background and will notify on completion.`,
              },
            ],
            details: {
              task_id: id,
              agent_type: agent.name,
              description: params.description,
              conversation_id: conversationId,
              tmux_session: sessionName,
              background: true,
            },
          };
        }
      } else if (params.task_id) {
        // Look up active tasks first, then durable completed-session history.
        const entries = readRegistry(piDir);
        let entry =
          entries.find(
            (e) => e.id === params.task_id || e.sessionName === params.task_id,
          ) ??
          findTaskSessionHistory(piDir, params.task_id) ??
          findJsonlSessionByName(piDir, params.task_id, agent.name);

        // Older history entries were written before we stored the
        // actual JSONL path needed by `pi --session`. Repair them by
        // resolving the display session name to a session file.
        if (entry && !entry.sessionRef) {
          const discovered = findJsonlSessionByName(
            piDir,
            entry.sessionName,
            entry.agentType,
          );
          if (discovered?.sessionRef) {
            entry = { ...entry, sessionRef: discovered.sessionRef };
            upsertTaskSessionHistory(piDir, {
              ...entry,
              status: "done",
              background: false,
            });
          }
        }
        if (!entry) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Unknown task_id: "${params.task_id}". No active or completed task session with that ID/session name was found.`,
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
        // Resume: reuse the existing session name; runtime files are
        // flat in artifactsDir, no per-task subdir.
        id = entry.id;
        sessionName = entry.sessionName;
        resultPath = join(artifactsDir, `RESULT-${id}.md`);
        resume = true;
        resumeSessionRef = entry.sessionRef;

        // If background and pane still alive, reattach to tracker
        if (
          params.background !== false &&
          entry.paneId &&
          paneExists(entry.paneId)
        ) {
          const bgtask: BackgroundTask = {
            dir: artifactsDir,
            agentType: entry.agentType,
            sessionName,
            paneId: entry.paneId,
            originalPane: null,
            description: params.description || entry.description,
            startedAt: entry.startedAt,
            toolUses: 0,
            turns: 0,
            conversationId: entry.conversationId,
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
              agent_type: entry.agentType,
              description: params.description || entry.description,
              conversation_id: entry.conversationId ?? conversationId,
              tmux_session: sessionName,
              background: true,
            },
          };
        }

        if (!resumeSessionRef) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Task "${params.task_id}" was found, but its session JSONL file could not be resolved. Cannot resume without a --session file path.`,
              },
            ],
            details: {
              phase: "failed" as const,
              error: "Task session file missing",
            },
            isError: true,
          };
        }
      } else {
        id = `${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`;
        sessionName = conversationId ?? `task-${id}`;
        resultPath = join(artifactsDir, `RESULT-${id}.md`);
      }

      if (conversationId && !hasTmux()) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Durable conversations require the tmux/CLI backend so Pi can save and reopen the subagent session. Install/start tmux or omit conversation_id for a one-shot SDK task.",
            },
          ],
          details: {
            phase: "failed" as const,
            error: "tmux required for durable conversation",
            conversation_id: conversationId,
          },
          isError: true,
        };
      }

      if (conversationId) {
        await mkdir(artifactsDir, { recursive: true });
        const taskSessionsRegistry = readTaskSessionsRegistry(piDir);
        taskSessionsRegistry[conversationId] = {
          task_id: id,
          session_file: `${artifactsDir}/${id}`,
        };
        writeTaskSessionsRegistry(piDir, taskSessionsRegistry);
      }

      const descText = params.description || "";
      const isBackground = params.background ?? TASK_BACKGROUND_DEFAULT;
      // default true

      // ── Build the prompt (instructions are inlined; no CONTEXT.md file) ─
      const promptContent = [
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
        "Your final assistant message is the result. End with a clear summary of what you did and any findings. No file write is required.",
        "",
        "Use this format for the summary:",
        "",
        "```",
        TASK_RESULT_XML_INSTRUCTIONS,
        "```",
      ].join("\n");

      const sessionDir = join(artifactsDir, "sessions");
      await mkdir(sessionDir, { recursive: true });

      // ─── Build and run the sub-agent pi process ──────────────────────────
      const piArgs = buildPiArgs(
        agent,
        sessionName,
        sessionDir,
        promptContent,
        resume,
        parentToolNames,
        resumeSessionRef,
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
            dir: artifactsDir,
            agentType: agent.name,
            sessionName,
            originalPane: null,
            description: descText,
            startedAt: Date.now(),
            toolUses: 0,
            turns: 0,
            conversationId,
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
            dir: artifactsDir,
            agentType: agent.name,
            sessionName,
            originalPane: null,
            description: descText,
            startedAt: Date.now(),
            toolUses: 0,
            turns: 0,
            conversationId,
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
            dir: artifactsDir,
            conversationId,
          };

          const entries = readRegistry(piDir);
          entries.push(entry);
          writeRegistry(piDir, entries);
          upsertTaskSessionHistory(piDir, {
            ...entry,
            status: "running",
            background: true,
          });
          pi.appendEntry("task-registry", entry);
          ensureTaskWidget(ctx);

          void runSdkFallback()
            .then(async ({ output }) => {
              const finalOutput =
                output || "SDK subagent completed without assistant text.";
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
              conversation_id: conversationId,
            },
          };
        }

        try {
          const { output, sessionPath } = await runSdkFallback();
          const finalOutput =
            output || "SDK subagent completed without assistant text.";
          if (conversationId) {
            writeConversationArtifacts({
              piDir,
              taskId: id,
              conversationId,
              agentType: agent.name,
              sessionFile: sessionPath ?? "unknown",
              prompt: params.prompt,
              result: finalOutput,
            });
          }
          return {
            content: [{ type: "text" as const, text: finalOutput }],
            details: {
              phase: "done" as const,
              backend: "sdk" as const,
              session_path: sessionPath,
              result_path: resultPath,
              conversation_id: conversationId,
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
        const startedAt = foregroundTask?.startedAt ?? Date.now();
        upsertTaskSessionHistory(piDir, {
          id,
          agentType: agent.name,
          description: descText,
          sessionName,
          startedAt,
          paneId,
          piDir,
          dir: artifactsDir,
          conversationId,
          status: "running",
          background: false,
        });

        const completion = await waitForSessionTaskCompletion({
          resultPath,
          sessionDir,
          sessionName,
          paneId,
          signal,
          timeoutMs: TASK_TIMEOUT_MS,
          pollMs: 1000,
          sinceMs: startedAt,
        });
        const content = completion.content;
        const phase =
          completion.status === "completed"
            ? "done"
            : completion.status === "cancelled"
              ? "cancelled"
              : "failed";
        const completedSessionRef = findJsonlSessionByName(
          piDir,
          sessionName,
          agent.name,
        )?.sessionRef;
        upsertTaskSessionHistory(piDir, {
          id,
          agentType: agent.name,
          description: descText,
          sessionName,
          startedAt,
          paneId,
          piDir,
          dir: artifactsDir,
          conversationId,
          sessionRef: completedSessionRef,
          status: phase,
          completedAt: Date.now(),
          background: false,
        });
        killAgentPane(paneId, originalPane);
        foregroundTasks.delete(id);
        clearTaskWidgetIfIdle();

        if (conversationId) {
          writeConversationArtifacts({
            piDir,
            taskId: id,
            conversationId,
            agentType: agent.name,
            sessionFile: `${sessionDir}/${sessionName}`,
            prompt: params.prompt,
            result: content,
          });
        }

        const parsed = parseResultXml(content);
        const durationMs = Date.now() - startedAt;
        const { toolUses, turns } = countToolUses(sessionDir, sessionName);

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `${parsed.status || "done"}: ${parsed.summary || content.slice(0, 300)}`,
                toolUses > 0 ? `\n${toolUses} toolcalls` : "",
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
            conversation_id: conversationId,
          },
        };
      }

      // ── BACKGROUND MODE (default): add to tracker, return immediately ─────

      const bgtask: BackgroundTask = {
        dir: artifactsDir,
        agentType: agent.name,
        sessionName,
        paneId,
        originalPane,
        description: descText,
        startedAt: Date.now(),
        toolUses: 0,
        turns: 0,
        conversationId,
        recentCalls: [],
      };

      backgroundTasks.set(id, bgtask);

      // ── P0: Persistent registry ────────────────────────────────────────
      const entry: RegistryEntry = {
        id,
        agentType: agent.name,
        description: descText,
        sessionName,
        startedAt: bgtask.startedAt,
        paneId,
        piDir,
        dir: artifactsDir,
        conversationId,
      };

      // Write to JSON registry for on-load restore
      const entries = readRegistry(piDir);
      entries.push(entry);
      writeRegistry(piDir, entries);
      upsertTaskSessionHistory(piDir, {
        ...entry,
        status: "running",
        background: true,
      });
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
              artifactDir: artifactsDir,
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
        const toolUses = d.tool_uses || 0;
        const durationMs = d.duration_ms || 0;
        const confidence = d.confidence || "";

        const useStr = toolUses > 0 ? `${toolUses} toolcalls` : "";
        const durStr = durationMs >= 1000 ? formatMs(durationMs) : "";
        const statsParts = [useStr, durStr].filter(Boolean);
        const statsText = statsParts.join(" \u2022 ");
        const confStr = confidence ? `[${confidence.toUpperCase()}]` : "";
        const statsLine = [confStr, statsText].filter(Boolean).join(" ");

        const subtleBg = (text: string) => `\x1b[48;2;30;28;44m${text}\x1b[0m`;
        return new Text(
          statsLine ? " " + theme.fg("dim", statsLine.trim()) : "",
          0,
          0,
          subtleBg,
        );
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

      const useStr = toolUses > 0 ? `${toolUses} toolcalls` : "";
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

  pi.registerCommand("task-sessions", {
    description: "List durable pi-task conversations",
    handler: async (_args, ctx) => {
      const cwd = ctx.sessionManager?.getCwd?.() ?? process.cwd();
      const { piDir } = discoverAgents(cwd);
      ctx.ui.notify(renderConversationSessions(piDir), "info");
    },
  });
}
