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
import { mkdir, writeFile } from "node:fs/promises";
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
  buildPiArgs,
  buildTaskToolDescription,
      countToolUses,
      discoverAgents,
      subscribeToolEvents,
  resolveTaskAgentPreflight,
  assessTaskResult,
  buildTaskEnvelope,
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
import { createDefaultHerdrTerminalBackend, createSyncHerdrControl } from "./subagent/herdr.js";
import { selectTerminalBackend } from "./subagent/terminalBackend.js";
import { steerRunningBackgroundTask } from "./subagent/steer.js";
import {
  checkTaskCompletion,
  waitForTaskCompletion as waitForSessionTaskCompletion,
} from "./subagent/waitCompletion.js";
import {
  hasTmux,
  killAgentPane,
  killAgentPaneStrict,
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
  startForegroundProgressPolling,
  taskParametersSchema,
} from "./tool/index.js";
import type {
  BackgroundTask,
  RegistryEntry,
  TerminalHandle,
} from "./types.js";
import { ignoreStaleExtensionCtx } from "./stale-ctx.js";
import { resolveTaskCwd } from "./task-cwd.js";
import { serializeTaskAdmission } from "./task-admission.js";
import { handleTaskControl } from "./task-control-api.js";
import { parseTaskControlRequest, parseTaskStartRequest } from "./task-control.js";

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

  const taskToolName = process.env.PI_TASK_TOOL_NAME?.trim() || "task";
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(taskToolName)) {
    throw new Error(`Invalid PI_TASK_TOOL_NAME: ${taskToolName}`);
  }
  // ── Background task tracker ────────────────────────────────────────────
      const { piDir } = discoverAgents(process.cwd(), BUNDLED_AGENT_DIR);
      const backgroundTasks = new Map<string, BackgroundTask>();
      const foregroundTasks = new Map<string, BackgroundTask>();
  const taskWidget = createTaskWidgetController(foregroundTasks, backgroundTasks);
  const { ensureTaskWidget, clearTaskWidgetIfIdle } = taskWidget;

  // ── Restore active tasks from registry on load ──────────────────────────

  const syncHerdr = createSyncHerdrControl();
  const registryEntryAlive = (entry: RegistryEntry): boolean => {
    if (entry.handle?.backend === "herdr") return syncHerdr.exists(entry.handle);
    const paneId = entry.handle?.backend === "tmux"
      ? entry.handle.resourceId
      : entry.paneId;
    return Boolean(paneId && paneExists(paneId));
  };
  const registryEntryStatus = (entry: RegistryEntry): "alive" | "missing" | "unavailable" => {
    try {
      return registryEntryAlive(entry) ? "alive" : "missing";
    } catch (error) {
      if (error instanceof Error && error.name === "HerdrUnavailableError") return "unavailable";
      throw error;
    }
  };
  const registryEntryCancellationStatus = (entry: RegistryEntry): "alive" | "missing" | "unavailable" => {
    if (
      entry.handle?.backend === "herdr" &&
      entry.handle.foregroundProcessGroupId === undefined
    ) {
      return "unavailable";
    }
    return registryEntryStatus(entry);
  };
  restoreActiveBackgroundTasks(
    piDir,
    backgroundTasks,
    registryEntryAlive,
    (entry) => {
      if (entry.handle?.backend === "herdr") {
        if (
          entry.handle.foregroundProcessGroupId === undefined
        ) {
          throw new Error("HerdR restore cleanup requires persisted agent identity");
        }
        syncHerdr.close(entry.handle);
      } else {
        const paneId = entry.handle?.backend === "tmux"
          ? entry.handle.resourceId
          : entry.paneId;
        if (paneId) killAgentPaneStrict(paneId, null);
      }
    },
  );


  // ── Widget / timer setup ───────────────────────────────────────────────

  const countInterval = startToolStatsPolling(
    foregroundTasks,
    backgroundTasks,
    COUNT_POLL_MS,
        taskWidget.requestRender,
  );

  // ── Polling loop (background task completion, pane death, timeout) ──────

  const stopBackgroundPolling = startBackgroundPolling(
    {
      backgroundTasks,
      checkTaskCompletion,
      resourceExists: (task) => task.handle?.backend === "herdr"
        ? createDefaultHerdrTerminalBackend().isAlive(task.handle)
        : task.paneId
          ? paneExists(task.paneId)
          : false,
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

  const controlTask = (request: Parameters<typeof handleTaskControl>[0]) =>
    handleTaskControl(request, {
      pi,
      piDir,
      backgroundTasks,
      registryEntryStatus: registryEntryCancellationStatus,
      clearTaskWidgetIfIdle,
    });

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
    name: taskToolName,
    label: taskToolName,
    description: buildTaskToolDescription(discoverAgents(process.cwd(), BUNDLED_AGENT_DIR).agents),
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
      "For repo-local work outside the caller checkout, set cwd to an absolute existing directory; use a parent-created Git worktree for writer isolation",
        ],
        parameters: taskParametersSchema(),

        async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const controlRequest = parseTaskControlRequest(params);
      if (controlRequest) return controlTask(controlRequest);
      const parsedTaskParams = parseTaskStartRequest(params);
      if (!parsedTaskParams) {
        return {
          content: [{ type: "text" as const, text: "Invalid task request: expected a start/resume request." }],
          details: { phase: "failed" as const, error: "invalid_task_request" },
          isError: true,
        };
      }

      let taskParams = parsedTaskParams;

      const { agents, piDir } = discoverAgents(ctx.cwd, BUNDLED_AGENT_DIR);
      const parentToolNames = pi
        .getAllTools()
        .map((tool) => tool.name)
        .filter(Boolean);
      const preflight = resolveTaskAgentPreflight(agents, taskParams.agent_type);
      if (!preflight.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: preflight.result.text,
            },
          ],
          details: {
            phase: "failed" as const,
            error: preflight.result.error,
          },
          isError: true,
        };
      }
      const agent = preflight.agent;
      if (taskParams.cwd !== undefined) {
        const requestedTaskCwd = resolveTaskCwd(ctx.cwd, taskParams.cwd);
        if (requestedTaskCwd.kind === "invalid") {
          return {
            content: [{ type: "text" as const, text: requestedTaskCwd.message }],
            details: { phase: "failed" as const, error: "invalid cwd" },
            isError: true,
          };
        }
      }
      let persistedTaskCwd: string | undefined;

      // ── Resolve task identity: new, task resume, or conversation resume ──
      const conversationId = normalizeConversationId(taskParams.conversation_id);
      const taskId = normalizeConversationId(taskParams.task_id);
      const admissionKey = conversationId
        ? `${piDir}\u0000conversation:${conversationId}`
        : taskId
          ? `${piDir}\u0000task:${taskId}`
          : undefined;
      return serializeTaskAdmission(admissionKey, async () => {
      const taskSessionsRegistry = conversationId
        ? readTaskSessionsRegistry(piDir)
        : {};
      const registeredTaskId = conversationId
        ? taskSessionsRegistry[conversationId]?.task_id
        : undefined;

      if (
        taskParams.task_id &&
        registeredTaskId &&
        taskParams.task_id !== registeredTaskId
      ) {
        return {
          content: [
            {
              type: "text" as const,
              text: `conversation_id "${conversationId}" maps to ${registeredTaskId}, not ${taskParams.task_id}. Omit task_id or use the mapped task id.`,
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
    
          const artifactsDir = join(piDir, "artifacts", "tasks");
    
          if (registeredTaskId) {
            id = registeredTaskId;
            sessionName = conversationId ?? `task-${id}`;
            const previous = findTaskSessionHistory(piDir, id);
            persistedTaskCwd = previous?.cwd;
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
        persistedTaskCwd = entry?.cwd ?? persistedTaskCwd;
        if (entry?.cleanupPending) {
          return {
            content: [{ type: "text" as const, text: `Conversation "${conversationId}" is cancelled but backend cleanup is still pending; retry after the resource is cleaned up.` }],
            details: { phase: "failed" as const, error: "cleanup_pending", task_id: id },
            isError: true,
          };
        }
        const entryStatus = entry ? registryEntryStatus(entry) : "missing";
        if (entryStatus === "unavailable") {
          return {
            content: [{ type: "text" as const, text: "The HerdR session for this conversation is temporarily unavailable. The durable task record was preserved; retry when HerdR reconnects." }],
            details: { phase: "failed" as const, error: "HerdR temporarily unavailable" },
            isError: true,
          };
        }
        if (entry && entryStatus === "alive") {
          if (taskParams.background === false) {
            return {
              content: [{ type: "text" as const, text: `Conversation "${conversationId}" is already running in the background and cannot be relaunched as foreground.` }],
              details: { phase: "failed" as const, error: "active task cannot run foreground", task_id: id },
              isError: true,
            };
          }
          const bgtask: BackgroundTask = {
            dir: artifactsDir,
            cwd: entry.cwd,
            agentType: entry.agentType,
            sessionName,
            paneId: entry.handle?.resourceId ?? entry.paneId,
            handle: entry.handle,
            backend: entry.handle?.backend ?? "tmux",
            originalPane: null,
            description: taskParams.description || entry.description,
            startedAt: entry.startedAt,
            toolUses: 0,
            turns: 0,
            conversationId,
            recentCalls: [],
          };
                    backgroundTasks.set(id, bgtask);
          const steerResult = steerRunningBackgroundTask(bgtask.paneId, taskParams.prompt, bgtask.handle);
          if (!steerResult.ok) {
            return {
              content: [{ type: "text" as const, text: `Conversation "${conversationId}" was restored, but the follow-up prompt could not be delivered (${steerResult.reason}).` }],
              details: { phase: "failed" as const, error: `resume steering failed: ${steerResult.reason}` },
              isError: true,
            };
          }

          return {
            content: [
              {
                type: "text" as const,
                text: `Resumed conversation "${conversationId}" via ${sessionName} and delivered the follow-up prompt. The subagent is running in background and will notify on completion.`,
              },
            ],
            details: {
              task_id: id,
              agent_type: agent.name,
              description: taskParams.description,
              conversation_id: conversationId,
              tmux_session: sessionName,
              background: true,
            },
          };
        }
      } else if (taskParams.task_id) {
        // Look up active tasks first, then durable completed-session history.
        const entries = readRegistry(piDir);
        let entry =
          entries.find(
            (e) => e.id === taskParams.task_id || e.sessionName === taskParams.task_id,
          ) ??
          findTaskSessionHistory(piDir, taskParams.task_id) ??
          findJsonlSessionByName(piDir, taskParams.task_id, agent.name);

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
          taskParams = { ...taskParams, task_id: undefined };
          id = `${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`;
          sessionName = conversationId ?? `task-${id}`;
        } else {
        persistedTaskCwd = entry.cwd;
        if (entry.cleanupPending) {
          return {
            content: [{ type: "text" as const, text: `Task "${taskParams.task_id}" is cancelled but backend cleanup is still pending; retry after the resource is cleaned up.` }],
            details: { phase: "failed" as const, error: "cleanup_pending", task_id: entry.id },
            isError: true,
          };
        }
        if (!existsSync(entry.dir)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Task "${taskParams.task_id}" artifact directory no longer exists: ${entry.dir}`,
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

        // If background and the terminal resource is still alive, reattach to the tracker.
        const entryStatus = registryEntryStatus(entry);
        if (entryStatus === "unavailable") {
          return {
            content: [{ type: "text" as const, text: "The HerdR session for this task is temporarily unavailable. The durable task record was preserved; retry when HerdR reconnects." }],
            details: { phase: "failed" as const, error: "HerdR temporarily unavailable" },
            isError: true,
          };
        }
        if (entryStatus === "alive") {
          if (taskParams.background === false) {
            return {
              content: [{ type: "text" as const, text: `Task "${taskParams.task_id}" is already running in the background and cannot be relaunched as foreground.` }],
              details: { phase: "failed" as const, error: "active task cannot run foreground", task_id: id },
              isError: true,
            };
          }
          const bgtask: BackgroundTask = {
            dir: artifactsDir,
            cwd: entry.cwd,
            agentType: entry.agentType,
            sessionName,
            paneId: entry.handle?.resourceId ?? entry.paneId,
            handle: entry.handle,
            backend: entry.handle?.backend ?? "tmux",
            originalPane: null,
            description: taskParams.description || entry.description,
            startedAt: entry.startedAt,
            toolUses: 0,
            turns: 0,
            conversationId: entry.conversationId,
            recentCalls: [],
          };
          backgroundTasks.set(id, bgtask);
          const steerResult = steerRunningBackgroundTask(bgtask.paneId, taskParams.prompt, bgtask.handle);
          if (!steerResult.ok) {
            return {
              content: [{ type: "text" as const, text: `Task "${taskParams.task_id}" was restored, but the follow-up prompt could not be delivered (${steerResult.reason}).` }],
              details: { phase: "failed" as const, error: `resume steering failed: ${steerResult.reason}` },
              isError: true,
            };
          }

          return {
            content: [
              {
                type: "text" as const,
                text: `Resumed task "${taskParams.task_id}" and delivered the follow-up prompt. The subagent is still running in background; avoid relaunching overlapping work. Use /task-sessions to inspect it, and it will notify on completion.`,
              },
            ],
            details: {
              task_id: id,
              agent_type: entry.agentType,
              description: taskParams.description || entry.description,
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
                text: `Task "${taskParams.task_id}" was found, but its session JSONL file could not be resolved. Cannot resume without a --session file path.`,
              },
            ],
            details: {
              phase: "failed" as const,
              error: "Task session file missing",
            },
            isError: true,
          };
        }
        }
       } else {
         id = `${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`;
         sessionName = conversationId ?? `task-${id}`;
       }

      const taskCwdResolution = resolveTaskCwd(ctx.cwd, taskParams.cwd, persistedTaskCwd);
      if (taskCwdResolution.kind === "invalid") {
        return {
          content: [{ type: "text" as const, text: taskCwdResolution.message }],
          details: { phase: "failed" as const, error: "invalid cwd" },
          isError: true,
        };
      }
      const taskCwd = taskCwdResolution.cwd;

      const durableBackendPreference = (process.env.PI_TASK_BACKEND ?? "auto").trim().toLowerCase();
      const herdrContextAvailable = process.env.HERDR_ENV === "1"
        && Boolean(process.env.HERDR_PANE_ID)
        && Boolean(process.env.HERDR_SOCKET_PATH);
      if (conversationId && (durableBackendPreference === "sdk" || (!hasTmux() && !herdrContextAvailable))) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Durable conversations require an active HerdR or tmux terminal backend so Pi can save and reopen the subagent session. Start Pi inside HerdR, start tmux, or omit conversation_id for a one-shot SDK task.",
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

      const descText = taskParams.description || "";
      const isBackground = taskParams.background ?? TASK_BACKGROUND_DEFAULT;
      // default true

          // ── Build the prompt (instructions are inlined; no CONTEXT.md file) ─
          const promptContent = buildTaskPrompt({
            description: descText,
            agentName: agent.name,
            agentSource: agent.source,
            prompt: taskParams.prompt,
            cwd: taskCwd,
          });

          const sessionDir = join(artifactsDir, "sessions", id);
          await mkdir(sessionDir, { recursive: true });

      // ─── Build and run the sub-agent pi process ──────────────────────────
      const legacyRequestedBackend = process.env.PI_TASK_USE_TMUX_BACKEND === "1"
        ? "tmux"
        : process.env.PI_TASK_USE_SDK_BACKEND === "1"
          ? "sdk"
          : undefined;
      const requestedBackend = (legacyRequestedBackend ?? process.env.PI_TASK_BACKEND ?? "auto").trim().toLowerCase();
      if (!["auto", "sdk", "tmux", "herdr"].includes(requestedBackend)) {
        return {
          content: [{ type: "text", text: `Invalid PI_TASK_BACKEND=${requestedBackend}. Expected auto, sdk, tmux, or herdr.` }],
          details: { phase: "failed" as const, error: "invalid backend" },
        };
      }
      const herdrBackend = createDefaultHerdrTerminalBackend();
      const hasHerdr = requestedBackend === "auto" || requestedBackend === "herdr"
        ? await herdrBackend.available()
        : false;
      const selectedBackend = selectTerminalBackend({
        requested: requestedBackend as "auto" | "sdk" | "tmux" | "herdr",
        hasHerdr,
        hasTmux: hasTmux(),
      });
      if (!selectedBackend) {
        const error = requestedBackend === "herdr"
          ? "HerdR backend requires Pi to run inside an active HerdR pane with HERDR_SOCKET_PATH set. Start Pi from HerdR; `herdr integration install pi` is optional."
          : `Requested ${requestedBackend} backend is unavailable.`;
        return {
          content: [{ type: "text", text: error }],
          details: { phase: "failed" as const, error },
        };
      }
      let promptLaunch:
        | { systemPromptPath: string; deferTaskPrompt: boolean }
        | undefined;
      if (selectedBackend === "herdr") {
        promptLaunch = {
          systemPromptPath: join(sessionDir, "agent-system-prompt.md"),
          deferTaskPrompt: true,
        };
        await writeFile(promptLaunch.systemPromptPath, agent.body, "utf8");
      }
      const piArgs = buildPiArgs(
        agent,
        sessionName,
        sessionDir,
        promptContent,
        resume,
        parentToolNames,
        taskToolName,
        resumeSessionRef,
        promptLaunch,
      );
      const useSdkBackend = selectedBackend === "sdk";

          const toolSelection = buildAgentToolSelection({
            tools: agent.tools,
            disallowedTools: agent.disallowedTools,
            parentToolNames,
            taskToolName,
          });
          const runSdkFallback = async (
            foregroundTask?: BackgroundTask,
            onSession?: (session: any) => () => void,
          ) =>
            runSdkSubagent({
              onSession: foregroundTask
                ? (session) => subscribeToolEvents(session, foregroundTask, 10, taskWidget.requestRender)
                : onSession,
              prompt: promptContent,
              agent,
              cwd: taskCwd,
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
            cwd: taskCwd,
            agentType: agent.name,
            sessionName,
                    backend: selectedBackend,
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

              const backgroundTask: BackgroundTask = {
                dir: artifactsDir,
                cwd: taskCwd,
                agentType: agent.name,
                sessionName,
                backend: "sdk",
                originalPane: null,
                description: descText,
                startedAt: Date.now(),
                toolUses: 0,
                turns: 0,
                conversationId,
                recentCalls: [],
              };
              backgroundTasks.set(id, backgroundTask);
              ignoreStaleExtensionCtx(() => ensureTaskWidget(ctx));
              const bgOnSession = (session: any) =>
                subscribeToolEvents(session, backgroundTask, 10, taskWidget.requestRender);

              startSdkBackgroundTask({
                id,
                agentType: agent.name,
                description: descText,
                sessionName,
                startedAt: backgroundTask.startedAt,
                piDir,
                artifactsDir,
                cwd: taskCwd,
                conversationId,
                run: async () => runSdkFallback(undefined, bgOnSession),
                onComplete: (result) => {
                  const parsed = parseResultXml(result.output);
                  const assessment = assessTaskResult(parsed);
                  const summary = parsed.summary || "SDK subagent completed without assistant text.";
                  ignoreStaleExtensionCtx(() =>
                    pi.sendMessage(
                      {
                        customType: "task-complete",
                        content: `Background task ${id} (${agent.name}) done.\n\n${summary}`,
                        display: true,
                        details: {
                          task_id: id,
                          agent_type: agent.name,
                          description: descText,
                          phase: "done",
                          execution_phase: "done",
                          status: assessment.reportedStatus,
                          reported_status: assessment.reportedStatus,
                          result_valid: assessment.valid,
                          result: result.output,
                          summary: parsed.summary,
                          findings: parsed.findings,
                          evidence: parsed.evidence,
                          files: parsed.files,
                          caveats: parsed.caveats,
                          next_steps: parsed.next_steps,
                          confidence: parsed.confidence,
                          duration_ms: Date.now() - backgroundTask.startedAt,
                          tool_uses: backgroundTask.toolUses,
                          turn_count: backgroundTask.turns,
                          background: true,
                          structured_result: assessment.valid,
                          full_output: parsed.raw.trim() || result.output.trim(),
                        },
                      },
                      { triggerTurn: true, deliverAs: "followUp" },
                    ),
                  );
                },
                onFailed: (error) => {
                  const message = error instanceof Error ? error.message : String(error);
                  ignoreStaleExtensionCtx(() =>
                    pi.sendMessage(
                      {
                        customType: "task-complete",
                        content: `Background task ${id} (${agent.name}) failed.\n\n${message}`,
                        display: true,
                        details: {
                          task_id: id,
                          agent_type: agent.name,
                          description: descText,
                          phase: "failed",
                          execution_phase: "failed",
                          status: "unknown",
                          reported_status: "unknown",
                          result_valid: false,
                          summary: message,
                          duration_ms: Date.now() - backgroundTask.startedAt,
                          tool_uses: backgroundTask.toolUses,
                          turn_count: backgroundTask.turns,
                          background: true,
                        },
                      },
                      { triggerTurn: true, deliverAs: "followUp" },
                    ),
                  );
                },
                onSettled: () => {
                  backgroundTasks.delete(id);
                  ignoreStaleExtensionCtx(() => clearTaskWidgetIfIdle());
                },
              });

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
              const { output, sessionPath } = await runSdkFallback(foregroundTask);

          const finalOutput = output || "SDK subagent completed without assistant text.";
              const parsed = parseResultXml(finalOutput);
              const assessment = assessTaskResult(parsed);
              const envelope = buildTaskEnvelope(parsed, {
                agent_type: agent.name,
                description: descText,
                tool_uses: foregroundTask!.toolUses,
                duration_ms: Date.now() - foregroundTask!.startedAt,
                background: false,
              });
              return {
                content: envelope.content,
                details: {
                  ...envelope.details,
                  phase: "done" as const,
                  execution_phase: "done" as const,
                  reported_status: assessment.reportedStatus,
                  result_valid: assessment.valid,
                  backend: "sdk" as const,
                  session_path: sessionPath,
                  conversation_id: conversationId,
                  full_output: parsed.raw.trim() || finalOutput,
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
              execution_phase: "failed" as const,
              status: "unknown",
              reported_status: "unknown",
              result_valid: false,
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

      let paneId: string;
      let originalPane: string | null;
      let handle: TerminalHandle;
      try {
        if (selectedBackend === "herdr") {
          handle = await herdrBackend.launch({
            agentArgs: piArgs,
            initialPrompt: promptContent,
            cwd: taskCwd,
            env: { PI_TASK_TOOL_DISABLED: "1" },
            label: `${agent.name}-${id.slice(0, 8)}`,
            workspaceGroup: taskParams.workspace_group,
          });
          paneId = handle.resourceId;
          originalPane = process.env.HERDR_PANE_ID ?? null;
        } else {
          const shellCommand = `PI_TASK_TOOL_DISABLED=1 pi ${piArgs.map((a) => shellQuote(a)).join(" ")}`;
          const sessionFile = join(sessionDir, sessionName + ".jsonl");
          const childCommand = `cd ${shellQuote(taskCwd)} && ${shellCommand}`;
          const terminalCommand = wrapWithPaneExitWatcher(sessionFile, childCommand);
          const splitResult = splitWindowPane(taskCwd, terminalCommand);
          paneId = splitResult.paneId;
          originalPane = splitResult.originalPane;
          handle = { backend: "tmux", resourceId: paneId };
          setPaneRemainOnExit(paneId, Boolean(foregroundTask));
        }
        if (foregroundTask) {
          foregroundTask.backend = selectedBackend;
          foregroundTask.paneId = paneId;
          foregroundTask.handle = handle;
          foregroundTask.originalPane = originalPane;
        } else if (selectedBackend === "tmux") {
          setPaneSelfDestruct(paneId, true);
        }
      } catch {
        foregroundTasks.delete(id);
        clearTaskWidgetIfIdle();
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to create ${selectedBackend} execution pane for the agent.`,
            },
          ],
          details: { phase: "failed" as const, error: `${selectedBackend} launch failed` },
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
          handle,
          piDir,
          dir: artifactsDir,
          cwd: taskCwd,
          conversationId,
          status: "running",
          background: false,
        });

                        const stopProgress = startForegroundProgressPolling({
                              taskId: id,
                              sessionDir,
                              sessionName,
                              agentType: agent.name,
                              description: descText,
                              startedAt,
                              onUpdate: onUpdate ?? (() => {}),
                            });

                        const onAbort = () => stopProgress();
                        signal?.addEventListener("abort", onAbort, { once: true });

            const completion = await waitForSessionTaskCompletion({
              sessionDir,
              sessionName,
              paneId,
              signal,
              timeoutMs: TASK_TIMEOUT_MS,
              pollMs: 1000,
              sinceMs: startedAt,
              resourceExists: selectedBackend === "herdr"
                ? () => herdrBackend.isAlive(handle as Extract<TerminalHandle, { backend: "herdr" }>)
                : undefined,
            });
        stopProgress();
        signal?.removeEventListener("abort", onAbort);
        const content = completion.content;
        const parsed = parseResultXml(content);
        const assessment = assessTaskResult(parsed);
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
          handle,
          piDir,
          dir: artifactsDir,
          cwd: taskCwd,
          conversationId,
          sessionRef: completedSessionRef,
          status: phase,
          reportedStatus: assessment.reportedStatus,
          resultValid: assessment.valid,
          completedAt: Date.now(),
          background: false,
        });
        if (phase === "done") {
          if (handle.backend === "herdr") await herdrBackend.close(handle);
          else killAgentPane(paneId, originalPane);
        } else {
          // The subagent pane is still alive after a cancel/failed/timeout
          // (we never reached the done branch). Without this, a user-initiated
          // session replacement while the foreground wait was in flight would
          // abort the wait → return cancelled → leave the pane orphaned. Always
          // tear down the pane on any terminal status so the user never ends up
          // with a dangling tmux split. Best-effort: ignore failures (pane may
          // already be gone).
          try {
            if (handle.backend === "herdr") await herdrBackend.close(handle);
            else killAgentPane(paneId, originalPane);
          } catch {
            // ignore
          }
        }
        foregroundTasks.delete(id);
        clearTaskWidgetIfIdle();
        const durationMs = Date.now() - startedAt;
        const { toolUses, turns } = countToolUses(sessionDir, sessionName);
        const envelope = buildTaskEnvelope(parsed, {
          agent_type: agent.name,
          description: descText,
          tool_uses: toolUses,
          duration_ms: durationMs,
          background: false,
        });
        return {
          ...envelope,
          details: {
            ...envelope.details,
            task_id: id,
            phase,
            execution_phase: phase,
            reported_status: assessment.reportedStatus,
            result_valid: assessment.valid,
            confidence: parsed.confidence || "",
            turn_count: turns,
            conversation_id: conversationId,
            full_output: parsed.raw.trim() || content.trim(),
          },
        };
          }

      // ── BACKGROUND MODE (default): add to tracker, return immediately ─────

      const bgtask: BackgroundTask = {
        dir: artifactsDir,
        cwd: taskCwd,
        agentType: agent.name,
        sessionName,
        paneId,
        handle,
        originalPane,
        description: descText,
        startedAt: Date.now(),
        toolUses: 0,
        turns: 0,
        conversationId,
        recentCalls: [],
        backend: selectedBackend,
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
        handle,
        piDir,
        dir: artifactsDir,
        cwd: taskCwd,
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
                  sessionPath: join(sessionDir, `${sessionName}.jsonl`),
                  backend: selectedBackend,
                  backendReason: requestedBackend === "auto" && selectedBackend !== "herdr"
                    ? "HerdR unavailable"
                    : undefined,
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
      });
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
