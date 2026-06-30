/**
 * Task Tool — Delegate complex work to specialist agents.
 *
 * Spawns pi CLI in a tmux split pane (foreground) or background.
 * Completion is detected from the subagent's final assistant message
 * in the persistent session JSONL (stopReason gating). The final message
 * is the authoritative result; no RESULT.md is used.
 *
 * Three agent sources:
 *   - .pi/agents/*.md        project-local agents
 *   - ~/.pi/agent/agents/*.md user-global agents (fallback)
 *
 * P0: Persistent task registry (appendEntry + JSON), --session resume,
 *     sendMessage completion notification, Ctrl+O expand/collapse.
 * P1: Foreground mode (background:false), pane death detection, timeout.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { buildAgentToolSelection } from "./agent-tools.js";
import {
  BACKGROUND_CHECK_MS,
  COUNT_POLL_MS,
  MAX_POLL_ERRORS,
  TASK_TIMEOUT_MS,
} from "./constants.js";
import {
  findJsonlSessionByName,
  normalizeConversationId,
  findTaskSessionHistory,
  readRegistry,
  readTaskSessionsRegistry,
  upsertTaskSessionHistory,
  writeRegistry,
  writeTaskSessionsRegistry,
} from "./conversation.js";
import {
  TASK_BACKGROUND_DEFAULT,
  TASK_TOOL_DESCRIPTION,
  buildPiArgs,
  countToolUses,
  discoverAgents,
  formatAgentList,
  formatBackgroundReceipt,
  parseResultXml,
  shellQuote,
} from "./helpers.js";
import {
  completeTask,
  createTaskWidgetController,
  restoreActiveBackgroundTasks,
  startBackgroundPolling,
  startToolStatsPolling,
} from "./lifecycle/index.js";
import { formatSdkBackgroundReceipt, startSdkBackgroundTask } from "./subagent/sdkBackground.js";
import { runSdkSubagent } from "./subagent/runSdk.js";
import {
  checkTaskCompletion,
  waitForTaskCompletion as waitForSessionTaskCompletion,
} from "./subagent/waitCompletion.js";
import {
  hasTmux,
  killAgentPane,
  paneExists,
  setPaneRemainOnExit,
  setPaneSelfDestruct,
  splitWindowPane,
  wrapWithPaneExitWatcher,
} from "./subagent/tmux.js";
import {
  buildTaskPrompt,
  createTaskCompleteRenderer,
  renderCall,
  renderResult,
  taskParametersSchema,
} from "./tool/index.js";
import type {
  BackgroundTask,
  RegistryEntry,
} from "./types.js";
import { ignoreStaleExtensionCtx } from "./stale-ctx.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const BUNDLED_AGENT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "agents",
);
// Conversation helpers live in ./conversation.js.

// ─── Extension Entry Point ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Prevent recursive loading
  if (process.env.PI_TASK_TOOL_DISABLED === "1") return;

  // ── Background task tracker ────────────────────────────────────────────
      const { piDir } = discoverAgents(process.cwd(), BUNDLED_AGENT_DIR);
      const backgroundTasks = new Map<string, BackgroundTask>();
      const foregroundTasks = new Map<string, BackgroundTask>();
  const taskWidget = createTaskWidgetController(foregroundTasks, backgroundTasks);
  const { ensureTaskWidget, clearTaskWidgetIfIdle } = taskWidget;

  // ── Restore active tasks from registry on load ──────────────────────────

  restoreActiveBackgroundTasks(piDir, backgroundTasks);


  // ── Widget / timer setup ───────────────────────────────────────────────

  const countInterval = startToolStatsPolling(
    foregroundTasks,
    backgroundTasks,
    COUNT_POLL_MS,
  );

  // ── Polling loop (background task completion, pane death, timeout) ──────

  const stopBackgroundPolling = startBackgroundPolling(
    {
      backgroundTasks,
      checkTaskCompletion,
      killAgentPane: (paneId, originalPane) => {
        if (paneId) killAgentPane(paneId, originalPane);
      },
      clearTaskWidgetIfIdle,
      completeTask,
      TASK_TIMEOUT_MS,
      MAX_POLL_ERRORS,
      piDir,
      pi,
    },
    BACKGROUND_CHECK_MS,
  );

  // ── Cleanup on shutdown ────────────────────────────────────────────────

  pi.on("session_shutdown", () => {
    stopBackgroundPolling();
    clearInterval(countInterval);
    taskWidget.dispose();
  });

      // ── Custom notification renderer ───────────────────────────────────────
      pi.registerMessageRenderer?.("task-complete", createTaskCompleteRenderer());

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
        parameters: taskParametersSchema(),

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
          let resume = false;
          let resumeSessionRef: string | undefined;
    
          const artifactsDir = join(piDir, "artifacts");
    
          if (registeredTaskId) {
            id = registeredTaskId;
            sessionName = conversationId ?? `task-${id}`;
            const previous = findTaskSessionHistory(piDir, id);
            const metadataAgent = previous?.agentType;
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
              updated_at: new Date().toISOString(),
            };
        writeTaskSessionsRegistry(piDir, taskSessionsRegistry);
      }

      const descText = params.description || "";
      const isBackground = params.background ?? TASK_BACKGROUND_DEFAULT;
      // default true

          // ── Build the prompt (instructions are inlined; no CONTEXT.md file) ─
          const promptContent = buildTaskPrompt({
            description: descText,
            agentName: agent.name,
            agentSource: agent.source,
            prompt: params.prompt,
            cwd: ctx.cwd,
          });

          const sessionDir = join(artifactsDir, "sessions", id);
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
      const forceTmuxBackend =
        process.env.PI_TASK_BACKEND === "tmux" ||
        process.env.PI_TASK_USE_TMUX_BACKEND === "1";
      const forceSdkBackend =
        process.env.PI_TASK_BACKEND === "sdk" ||
        process.env.PI_TASK_USE_SDK_BACKEND === "1";
      const tmuxAvailable = hasTmux();
      const useSdkBackend =
        forceSdkBackend || (!forceTmuxBackend && !tmuxAvailable);

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
        ignoreStaleExtensionCtx(() => ensureTaskWidget(ctx));
      }

      // Prefer tmux when the parent Pi is running inside tmux so users can watch
      // the subagent's interactive Pi TUI. Fall back to the SDK only when tmux is
      // unavailable, or when explicitly forced with PI_TASK_BACKEND=sdk.
      if (useSdkBackend) {
        if (isBackground) {
          foregroundTasks.delete(id);
          startSdkBackgroundTask({
            id,
            agentType: agent.name,
            description: descText,
            sessionName,
            startedAt: Date.now(),
            piDir,
            artifactsDir,
            conversationId,
            run: runSdkFallback,
          });
          clearTaskWidgetIfIdle();
          return {
            content: [{ type: "text" as const, text: formatSdkBackgroundReceipt(id) }],
            details: {
              phase: "running" as const,
              backend: "sdk" as const,
              background: true,
              task_id: id,
              agent_type: agent.name,
              description: descText,
              conversation_id: conversationId,
            },
          };
        }

        try {
          const { output, sessionPath } = await runSdkFallback();
          const finalOutput = output || "SDK subagent completed without assistant text.";
          return {
            content: [{ type: "text" as const, text: finalOutput }],
            details: {
              phase: "done" as const,
              backend: "sdk" as const,
              session_path: sessionPath,
              conversation_id: conversationId,
            },
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
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
          const sessionFile = join(sessionDir, sessionName + ".jsonl");
          const tmuxCommand = wrapWithPaneExitWatcher(
            sessionFile,
        `cd ${shellQuote(ctx.cwd)} && ${shellCommand}`,
      );

      let paneId: string;
      let originalPane: string | null;
      try {
        const splitResult = splitWindowPane(ctx.cwd, tmuxCommand);
        paneId = splitResult.paneId;
        originalPane = splitResult.originalPane;
        setPaneRemainOnExit(paneId, Boolean(foregroundTask));
        if (foregroundTask) {
          foregroundTask.paneId = paneId;
          foregroundTask.originalPane = originalPane;
        } else {
          setPaneSelfDestruct(paneId, true);
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

        // Poll tool-call progress while waiting for completion
        let lastToolCalls = -1;
        const onAbort = () => clearInterval(toolProgressInterval);
        const toolProgressInterval = setInterval(() => {
          try {
            const stats = countToolUses(sessionDir, sessionName);
            if (stats.toolUses > 0 && stats.toolUses !== lastToolCalls) {
              lastToolCalls = stats.toolUses;
              _onUpdate?.({
                content: [
                  {
                    type: "text",
                    text: `${stats.toolUses} tool call${stats.toolUses !== 1 ? "s" : ""}`,
                  },
                ],
                details: { toolCalls: stats.toolUses },
              });
            }
          } catch {
            // session file may not exist yet
          }
        }, COUNT_POLL_MS);
        signal?.addEventListener("abort", onAbort, { once: true });

        const completion = await waitForSessionTaskCompletion({
          sessionDir,
          sessionName,
          paneId,
          signal,
          timeoutMs: TASK_TIMEOUT_MS,
          pollMs: 1000,
          sinceMs: startedAt,
        });
        clearInterval(toolProgressInterval);
        signal?.removeEventListener("abort", onAbort);
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
        if (phase === "done") {
          killAgentPane(paneId, originalPane);
        } else {
          // The subagent pane is still alive after a cancel/failed/timeout
          // (we never reached the done branch). Without this, a user-initiated
          // session replacement while the foreground wait was in flight would
          // abort the wait → return cancelled → leave the pane orphaned. Always
          // tear down the pane on any terminal status so the user never ends up
          // with a dangling tmux split. Best-effort: ignore failures (pane may
          // already be gone).
          try {
            killAgentPane(paneId, originalPane);
          } catch {
            // ignore
          }
        }
        foregroundTasks.delete(id);
        clearTaskWidgetIfIdle();
            const parsed = parseResultXml(content);
        const durationMs = Date.now() - startedAt;
        const { toolUses, turns } = countToolUses(sessionDir, sessionName);

            return {
              content: [
                {
                  type: "text" as const,
                  text: parsed.summary || content.trim(),
                },
              ],
              details: {
                task_id: id,
                agent_type: agent.name,
                description: descText,
                phase,
                status: "done",
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
      // Also persist to session store via appendEntry (audit trail). This is
      // best-effort because OpenPi can replace sessions while an older pi-task
      // closure is still unwinding, making captured extension APIs stale. The
      // JSON registry/history above are the durable source of truth.
      ignoreStaleExtensionCtx(() => pi.appendEntry("task-registry", entry));

      // Do not kill a background subagent when the parent session aborts or is
      // replaced. Background tasks are intentionally detached; the registry and
      // polling loop own their lifecycle after the pane is spawned.

      // ── Sticky widget ──────────────────────────────────────────────────
      ignoreStaleExtensionCtx(() => ensureTaskWidget(ctx));

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

        renderCall,
        renderResult,
  });

  pi.registerCommand("task-sessions", {
    description: "List durable pi-task conversations",
    handler: async (_args, ctx) => {
      const cwd = ctx.sessionManager?.getCwd?.() ?? process.cwd();
      const { piDir } = discoverAgents(cwd);
      const registry = readTaskSessionsRegistry(piDir);
      const rows = Object.entries(registry)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([conversationId, entry]) => `- ${conversationId} -> ${entry.task_id}`);
      ctx.ui.notify(
        rows.length > 0
          ? `Durable pi-task conversations:\n${rows.join("\n")}`
          : "No durable pi-task conversations found.",
        "info",
      );
    },
  });
}
