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
import { writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { buildAgentToolSelection } from "./agent-tools.js";
import {
  BACKGROUND_CHECK_MS,
  COUNT_POLL_MS,
  MAX_POLL_ERRORS,
  TASK_TIMEOUT_MS,
} from "./constants.js";
import { registerTaskFastModeBridge } from "./fast-mode.js";
export { createTaskFastModeStream, registerTaskFastModeBridge } from "./fast-mode.js";
export type { TaskToolParameters } from "./tool/schema.js";
import {
  DurableStateError,
  normalizeConversationId,
  markComparisonGroupDelivered,
  markComparisonGroupPartiallyDelivered,
  readRegistry,
  readTaskSessionHistory,
  readTaskSessionsRegistry,
} from "./conversation.js";
import {
  buildPiArgs,
  buildTaskToolDescription,
      discoverAgents,
  resolveTaskAgentPreflight,
  resolveTaskFastMode,
  isTaskCompareAllowed,
  resolveCompareModels,
} from "./helpers.js";
import { ComparisonCoordinator } from "./comparison.js";
import { restoreComparisonGroups } from "./comparison-restore.js";
export { restoreComparisonGroups } from "./comparison-restore.js";
export type {
  ComparisonRestoreDeferReason,
  ComparisonRestoreDiagnostic,
  ComparisonRestoreObserver,
} from "./comparison-restore.js";
import {
  completeTask,
  createCompletionDeliveryQueue,
  createTaskWidgetController,
  executeTerminalTask,
  restoreActiveBackgroundTasks,
  startBackgroundPolling,
  startToolStatsPolling,
  durableParentOf,
  restoreBackgroundTaskDeliveryGuards,
  createRegistryEntryStatus,
  executeSdkTask,
  executeComparisonTask,
  materializeTaskExecution,
  prepareTaskExecution,
  resolveConversationResume,
  resolveTaskResume,
  createComparisonSettledHandler,
} from "./lifecycle/index.js";
import { DeliveryGuard, sessionViewOf } from "./panel/delivery.js";
import { reconcileStaleSdkBackgroundTasks } from "./subagent/sdkBackground.js";
import {
  createDefaultHerdrTerminalBackend,
  createSyncHerdrControl,
  resolveHerdrPiIntegrationExtension,
} from "./subagent/herdr.js";
import { resolveTaskBackend } from "./subagent/selectBackend.js";
import { buildClaudeArgs } from "./subagent/buildArgv.js";
import { claudeSessionFilePath } from "./subagent/claudeSession.js";
import {
  steerRunningBackgroundTask,
  steerRunningBackgroundTaskAsync,
} from "./subagent/steer.js";
import {
  checkTaskCompletion,
} from "./subagent/waitCompletion.js";
import {
  killAgentPaneStrictAsync,
  probePaneAsync,
} from "./subagent/tmux.js";
import {
  createTaskCompleteRenderer,
  renderCall,
  renderResult,
  taskParametersSchema,
} from "./tool/index.js";
import type { BackgroundTask } from "./types.js";
import { ignoreStaleExtensionCtx } from "./stale-ctx.js";
import { resolveTaskCwd } from "./task-cwd.js";
import { serializeTaskAdmission } from "./task-admission.js";
import { handleTaskControl } from "./task-control-api.js";
import {
  parseTaskControlRequest,
  parseTaskStartRequest,
  taskStartRequestError,
} from "./task-control.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const TASK_EXTENSION_PATH = fileURLToPath(import.meta.url);
const BUNDLED_AGENT_DIR = join(
  dirname(TASK_EXTENSION_PATH),
  "..",
  "agents",
);
// ─── Extension Entry Point ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Registered in both branches: the parent reads it to decide whether its
  // children run fast, and a child launched with `--fast` reads it to install
  // its isolated provider bridge. A manual `pi -e pi-task --fast` in a normal
  // session is therefore accepted instead of dying as "Unknown option".
  pi.registerFlag("fast", {
    description: "Use the priority service tier for this session's delegated children",
    type: "boolean",
    default: false,
  });
  // Recursive children never register task. An explicitly fast terminal child
  // loads this same extension path only to install its isolated provider bridge.
  if (process.env.PI_TASK_TOOL_DISABLED === "1") {
    let fastModeBridgeInstalled = false;
    pi.on("session_start", () => {
      if (fastModeBridgeInstalled || pi.getFlag("fast") !== true) return;
      fastModeBridgeInstalled = true;
      registerTaskFastModeBridge(pi);
    });
    return;
  }

  const taskToolName = process.env.PI_TASK_TOOL_NAME?.trim() || "task";
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(taskToolName)) {
    throw new Error(`Invalid PI_TASK_TOOL_NAME: ${taskToolName}`);
  }
  // ── Background task tracker ────────────────────────────────────────────
  const { piDir } = discoverAgents(process.cwd(), BUNDLED_AGENT_DIR);
  const extensionPiDir = piDir;
  const backgroundTasks = new Map<string, BackgroundTask>();
  const foregroundTasks = new Map<string, BackgroundTask>();
  const asyncHerdr = createDefaultHerdrTerminalBackend();
  const taskWidget = createTaskWidgetController(foregroundTasks, backgroundTasks, {
    steerTask: (task, text) => {
      const result = steerRunningBackgroundTask(task.paneId, text, task.handle);
      return result.ok ? null : result.reason;
    },
    stopTask: async (task) => {
      if (task.backend === "sdk") {
        return "SDK tasks cannot be stopped from the panel yet.";
      }
      try {
        if (task.handle?.backend === "herdr") {
          if (task.handle.foregroundProcessGroupId === undefined) {
            return "HerdR cleanup requires persisted agent identity";
          }
          await asyncHerdr.close(task.handle);
        } else if (task.paneId) {
          await killAgentPaneStrictAsync(task.paneId, task.originalPane);
        }
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
  });
  const { ensureTaskWidget, clearTaskWidgetIfIdle } = taskWidget;
  // Records which conversation spawned each background task so a result is
  // never delivered into a different conversation or branch.
  const deliveryGuard = new DeliveryGuard();
  const completionDeliveryQueue = createCompletionDeliveryQueue();
  const completeTaskWithDelivery: typeof completeTask = (options) =>
    completeTask({
      ...options,
      deliveryQueue: completionDeliveryQueue,
    });

  // ── Restore active tasks from registry on load ──────────────────────────

  const syncHerdr = createSyncHerdrControl();
  const {
    registryEntryStatus,
    registryEntryAliveAsync,
    registryEntryCancellationStatus,
  } = createRegistryEntryStatus(syncHerdr, asyncHerdr);

  // ── Widget / timer setup ───────────────────────────────────────────────

  const countInterval = startToolStatsPolling(
    foregroundTasks,
    backgroundTasks,
    COUNT_POLL_MS,
        taskWidget.requestRender,
  );

  // ── Polling loop (background task completion, pane death, timeout) ──────

  const comparisonCoordinator = new ComparisonCoordinator();

  const comparisonSettledHandler = createComparisonSettledHandler({
    piDir,
    pi,
    comparisonCoordinator,
    taskWidget,
    deliveryGuard,
  });

  // Durable-task restore and comparison replay wait for the first
  // session_start (issue #20): the owning session id only exists once a
  // session context does, and restore decisions depend on it. Until then the
  // maps stay empty; polling picks restored tasks up on its next tick.
  let restoredLifecycleOnce = false;
  pi.on("session_start", async (_event, ctx) => {
    if (restoredLifecycleOnce) return;
    restoredLifecycleOnce = true;
    const sessionId = sessionViewOf(ctx).getSessionId();
    try {
      reconcileStaleSdkBackgroundTasks(piDir);
      await restoreActiveBackgroundTasks(
        piDir,
        backgroundTasks,
        registryEntryAliveAsync,
        async (entry) => {
          if (entry.handle?.backend === "herdr") {
            if (
              entry.handle.foregroundProcessGroupId === undefined
            ) {
              throw new Error("HerdR restore cleanup requires persisted agent identity");
            }
            await asyncHerdr.close(entry.handle);
          } else {
            const paneId = entry.handle?.backend === "tmux"
              ? entry.handle.resourceId
              : entry.paneId;
            if (paneId) await killAgentPaneStrictAsync(paneId, null);
          }
        },
        sessionId ? { sessionId } : undefined,
      );
    } catch (error) {
      // Restore must never abort the session; durable records stay on disk
      // and the next session_start retries them.
      console.error(
        `[pi-task] background task restore failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const currentSession = sessionViewOf(ctx);
    if (currentSession.getSessionId()) {
      restoreBackgroundTaskDeliveryGuards(
        backgroundTasks,
        sessionId,
        deliveryGuard,
      );
    }

    let durableHistory: ReturnType<typeof readTaskSessionHistory>;
    try {
      durableHistory = readTaskSessionHistory(piDir);
    } catch (error) {
      // Corrupt history is not an empty history: keep the file intact and
      // defer delivery/replay until a later startup can read it safely.
      console.error(
        `[pi-task] durable history restore skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    if (currentSession.getSessionId()) {
      for (const history of durableHistory) {
        // Registry-adopted tasks are authoritative when a transfer left the
        // two durable records temporarily out of sync.
        if (history.ownerSessionId === undefined || backgroundTasks.has(history.id)) continue;
        deliveryGuard.restore(history.id, {
          sessionId: history.ownerSessionId,
          leafId: history.ownerLeafId ?? null,
        });
      }
    }

    let restoredComparisonRuns: ReturnType<typeof restoreComparisonGroups>;
    try {
      restoredComparisonRuns = restoreComparisonGroups(
        piDir,
        backgroundTasks,
        comparisonCoordinator,
        sessionId,
        ({ groupId, taskIds, reason }) => {
          console.warn(
            `[pi-task] deferred comparison group ${groupId} (${reason}); ` +
              `ownership is not atomic for ${taskIds.join(", ")}`,
          );
        },
      );
    } catch (error) {
      console.error(
        `[pi-task] comparison replay skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    for (const run of restoredComparisonRuns) {
      const allowed = deliveryGuard.allows(currentSession, run.taskId);
      // Replay is best-effort: a non-stale send failure must not abort the
      // session. The delivered marker stays unset, so the group is recovered
      // and retried on the next extension load.
      try {
        comparisonCoordinator.recordTaskSettled(
          run.taskId,
          run,
          pi,
          allowed,
          (taskIds) => markComparisonGroupDelivered(piDir, taskIds),
          (taskId) => deliveryGuard.allows(currentSession, taskId),
          (taskIds) => markComparisonGroupPartiallyDelivered(piDir, taskIds),
        );
      } catch {
        // Retry on next restart via durable history.
      }
    }
  });

  const stopBackgroundPolling = startBackgroundPolling(
    {
      backgroundTasks,
      checkTaskCompletion,
      resourceExists: (task) => task.handle?.backend === "herdr"
        ? createDefaultHerdrTerminalBackend().isAlive(task.handle)
        : task.paneId
          ? probePaneAsync(task.paneId).then((probe) => probe.state)
          : false,
      clearTaskWidgetIfIdle,
      completeTask: completeTaskWithDelivery,
      onComparisonSettled: comparisonSettledHandler,
      onTaskFinished: (id, task) => taskWidget.noteTaskFinished(id, task),
      deliveryGuard: (id) => {
        const ctx = taskWidget.getContext();
        return ctx ? deliveryGuard.allows(sessionViewOf(ctx), id) : true;
      },
      TASK_TIMEOUT_MS,
      MAX_POLL_ERRORS,
      piDir,
      pi,
      steerTask: (task, prompt) =>
        steerRunningBackgroundTaskAsync(task.paneId, prompt, task.handle)
          .then((result) => result.ok),
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
      completeTask: completeTaskWithDelivery,
      onComparisonSettled: comparisonSettledHandler,
      noteTaskFinished: (id, task) => taskWidget.noteTaskFinished(id, task),
    });

  // ── Panel ready at session start ───────────────────────────────────────

  pi.on("session_start", (_event, ctx) => {
    ignoreStaleExtensionCtx(() => taskWidget.ensurePanelEditor(ctx));
  });

  // ── Cleanup on shutdown ────────────────────────────────────────────────

  pi.on("session_shutdown", () => {
    stopBackgroundPolling();
    clearInterval(countInterval);
    taskWidget.dispose();
    completionDeliveryQueue.dispose();
  });

      // ── Custom notification renderer ───────────────────────────────────────
      pi.registerMessageRenderer?.("task-complete", createTaskCompleteRenderer());

  // ── Tool Registration ──────────────────────────────────────────────────

  pi.registerTool({
    name: taskToolName,
    label: taskToolName,
    description: buildTaskToolDescription(discoverAgents(process.cwd(), BUNDLED_AGENT_DIR).agents),
    promptSnippet: "Delegate work to a specialist agent",
        parameters: taskParametersSchema(),

        async execute(_toolCallId, params, signal, onUpdate, ctx) {
      try {
      // Control requests (status/cancel) are a user action and live on the
      // `/task` command, so every tool call here starts or resumes work.
      const parsedTaskParams = parseTaskStartRequest(params);
      if (!parsedTaskParams) {
        const reason = taskStartRequestError(params) ?? "expected a start/resume request";
        return {
          content: [{ type: "text" as const, text: `Invalid task request: ${reason}.` }],
          details: { phase: "failed" as const, error: "invalid_task_request", reason },
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

      if (taskParams.compare) {
        if (taskId || conversationId) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Comparison mode (compare: true) does not support task_id or conversation_id resume in V1.",
              },
            ],
            details: {
              phase: "failed" as const,
              error: "resume_unsupported_for_compare",
            },
            isError: true,
          };
        }
        const compareEffectiveTools = buildAgentToolSelection({
          tools: agent.tools,
          disallowedTools: agent.disallowedTools,
          parentToolNames,
          taskToolName,
        }).tools;
        const compareAllowed = isTaskCompareAllowed(agent, compareEffectiveTools);
        if (!compareAllowed.allowed) {
          return {
            content: [{ type: "text" as const, text: compareAllowed.reason }],
            details: {
              phase: "failed" as const,
              error: "compare_disallowed_for_agent",
              reason: compareAllowed.reason,
            },
            isError: true,
          };
        }
        const modelResolution = resolveCompareModels(agent);
        if (!modelResolution.ok) {
          return {
            content: [{ type: "text" as const, text: modelResolution.reason }],
            details: {
              phase: "failed" as const,
              error: "insufficient_models_for_compare",
              reason: modelResolution.reason,
            },
            isError: true,
          };
        }
      }

      const claudeRuntime = agent.runtime === "claude";
      if (claudeRuntime) {
        if (conversationId || taskId) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Agent "${agent.name}" uses the Claude Code runtime, which does not support conversation_id or task_id resume. Omit both for a one-shot claude task.`,
              },
            ],
            details: {
              phase: "failed" as const,
              error: "resume_unsupported_for_claude_runtime",
            },
            isError: true,
          };
        }
        if (taskParams.compare) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Comparison mode is not supported for the Claude Code runtime (agent "${agent.name}"). Pi-runtime agents are required for compare.`,
              },
            ],
            details: {
              phase: "failed" as const,
              error: "compare_unsupported_for_claude_runtime",
            },
            isError: true,
          };
        }
        const requestedBackendRaw = (process.env.PI_TASK_BACKEND ?? "auto").trim().toLowerCase();
        if (requestedBackendRaw === "sdk") {
          return {
            content: [
              {
                type: "text" as const,
                text: `Agent "${agent.name}" uses the Claude Code runtime, which requires the herdr or tmux backend. PI_TASK_BACKEND=sdk is not supported for claude tasks.`,
              },
            ],
            details: {
              phase: "failed" as const,
              error: "sdk_unsupported_for_claude_runtime",
            },
            isError: true,
          };
        }
      }

      const admissionKey = conversationId
        ? `${piDir}\u0000conversation:${conversationId}`
        : taskId
          ? `${piDir}\u0000task:${taskId}`
          : undefined;
      return await serializeTaskAdmission(admissionKey, async () => {
        const taskSessionsRegistry = conversationId
          ? readTaskSessionsRegistry(piDir)
          : {};
        // Validate every durable source before resolving/resuming or launching
        // a child. Missing files remain valid empty state; unreadable files
        // fail before any backend resource can be created.
        readRegistry(piDir);
        readTaskSessionHistory(piDir);
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
        const resumeResolution = resolveConversationResume({
          conversationId: conversationId!,
          registeredTaskId,
          taskParams,
          agentName: agent.name,
          piDir,
          artifactsDir,
          extensionPiDir,
          ctx,
          backgroundTasks,
          deliveryGuard,
          registryEntryStatus,
        });
        if (resumeResolution.kind === "handled") return resumeResolution.result;
        id = resumeResolution.id;
        sessionName = resumeResolution.sessionName;
        resume = true;
        resumeSessionRef = resumeResolution.resumeSessionRef;
        persistedTaskCwd = resumeResolution.persistedTaskCwd;
      } else if (taskParams.task_id) {
        const taskResumeResolution = resolveTaskResume({
          requestedTaskId: taskParams.task_id!,
          taskParams,
          agentName: agent.name,
          piDir,
          artifactsDir,
          conversationId,
          extensionPiDir,
          ctx,
          backgroundTasks,
          deliveryGuard,
          registryEntryStatus,
        });
        if (taskResumeResolution.kind === "handled") return taskResumeResolution.result;
        taskParams = taskResumeResolution.taskParams;
        id = taskResumeResolution.id;
        sessionName = taskResumeResolution.sessionName;
        resume = taskResumeResolution.resume;
        resumeSessionRef = taskResumeResolution.resumeSessionRef;
        persistedTaskCwd = taskResumeResolution.persistedTaskCwd;

       } else {
         id = `${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`;
         sessionName = conversationId ?? `task-${id}`;
       }

      const taskPreparation = await prepareTaskExecution({
        taskParams,
        agent,
        ctx,
        artifactsDir,
        id,
        conversationId,
        persistedTaskCwd,
      });
      if (taskPreparation.kind === "handled") return taskPreparation.result;
      const {
        taskCwd,
        skillPaths,
        descText,
        isBackground,
        promptContent,
        sessionDir,
      } = taskPreparation;

      // ── Claude Code runtime setup: pinned session id + transcript path ──
      // The UUID is the durable identity: it is persisted on every task/
      // registry/history record so post-restart polling can rebuild the
      // transcript path from cwd + claudeSessionId (sessionName stays the
      // ordinary task-<id> name).
      const claudeSessionId = claudeRuntime ? randomUUID() : undefined;
      const claudeSessionFile = claudeRuntime && claudeSessionId
        ? claudeSessionFilePath(taskCwd, claudeSessionId)
        : undefined;
      const claudeTaskRuntime = claudeRuntime ? ("claude" as const) : undefined;
      // Claude Code has no --append-system-prompt: the agent body is
      // prepended to the task prompt itself.
      const claudePrompt = claudeRuntime
        ? agent.body
          ? `${agent.body}\n\n---\n\n${promptContent}`
          : promptContent
        : undefined;

      // ─── Build and run the sub-agent pi process ──────────────────────────
      const backendResolution = await resolveTaskBackend();
      if (!backendResolution.ok) {
        return {
          content: [{ type: "text", text: backendResolution.error }],
          details: {
            phase: "failed" as const,
            error: backendResolution.kind === "invalid"
              ? "invalid backend"
              : backendResolution.error,
          },
        };
      }
      const {
        requestedBackend,
        selectedBackend,
        herdrBackend,
      } = backendResolution;
      if (claudeRuntime && selectedBackend === "sdk") {
        return {
          content: [
            {
              type: "text" as const,
              text: `Agent "${agent.name}" uses the Claude Code runtime, which requires an active HerdR or tmux terminal backend. Start Pi inside HerdR or tmux, or set PI_TASK_BACKEND=herdr|tmux.`,
            },
          ],
          details: {
            phase: "failed" as const,
            error: "sdk_unsupported_for_claude_runtime",
          },
          isError: true,
        };
      }
      if (conversationId && selectedBackend === "sdk") {
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
      await materializeTaskExecution({
        piDir,
        artifactsDir,
        id,
        sessionDir,
        conversationId,
      });
      const effectiveFast = resolveTaskFastMode(agent.fast, pi.getFlag("fast") === true);

      if (taskParams.compare) {
        return executeComparisonTask({
          agent,
          description: descText,
          prompt: promptContent,
          cwd: taskCwd,
          artifactsDir,
          piDir,
          ctx,
          pi,
          parentToolNames,
          taskToolName,
          skillPaths,
          fast: effectiveFast,
          selectedBackend,
          terminalBackend: herdrBackend,
          taskExtensionPath: TASK_EXTENSION_PATH,
          workspaceGroup: taskParams.workspace_group,
          signal,
          onUpdate,
          isBackground,
          foregroundTasks,
          backgroundTasks,
          deliveryGuard,
          comparisonCoordinator,
          taskWidget,
          clearTaskWidgetIfIdle,
          ensureTaskWidget: () =>
            ignoreStaleExtensionCtx(() => ensureTaskWidget(ctx)),
          markComparisonGroupPartiallyDelivered: (taskIds) =>
            markComparisonGroupPartiallyDelivered(piDir, taskIds),
        });
      }
      let promptLaunch:
        | { systemPromptPath: string; deferTaskPrompt: boolean }
        | undefined;
      if (selectedBackend === "herdr" && !claudeRuntime) {
        promptLaunch = {
          systemPromptPath: join(sessionDir, "agent-system-prompt.md"),
          deferTaskPrompt: true,
        };
        await writeFile(promptLaunch.systemPromptPath, agent.body, "utf8");
      }
      const herdrRequiredExtension =
        selectedBackend === "herdr" && !claudeRuntime
          ? resolveHerdrPiIntegrationExtension()
          : undefined;
      const piArgs = claudeRuntime && claudeSessionId
        ? buildClaudeArgs({
            agent,
            sessionId: claudeSessionId,
            promptContent: claudePrompt ?? promptContent,
            // The initial prompt is submitted via `herdr agent prompt` / the
            // tmux command line, never as a positional argv element.
            deferTaskPrompt: true,
          })
        : buildPiArgs(
        agent,
        sessionName,
        sessionDir,
        promptContent,
        resume,
        parentToolNames,
        taskToolName,
        resumeSessionRef,
        promptLaunch,
        skillPaths,
        effectiveFast,
        TASK_EXTENSION_PATH,
        herdrRequiredExtension ? [herdrRequiredExtension] : undefined,
      );
      const useSdkBackend = selectedBackend === "sdk";

          const toolSelection = buildAgentToolSelection({
            tools: agent.tools,
            disallowedTools: agent.disallowedTools,
            parentToolNames,
            taskToolName,
          });
      const foregroundTask: BackgroundTask | undefined = isBackground
        ? undefined
        : {
            dir: artifactsDir,
            cwd: taskCwd,
            agentType: agent.name,
            sessionName,
            backend: selectedBackend,
            runtime: claudeTaskRuntime,
            ...(claudeRuntime ? { claudeSessionId, claudeSessionFile } : {}),
            originalPane: null,
            description: descText,
            startedAt: Date.now(),
            toolUses: 0,
            turns: 0,
            conversationId,
            ...durableParentOf(sessionViewOf(ctx)),
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
            return executeSdkTask({
              id,
              agent,
              description: descText,
              sessionName,
              prompt: promptContent,
              cwd: taskCwd,
              ctx,
              pi,
              piDir,
              artifactsDir,
              conversationId,
              toolSelection,
              skillPaths,
              fast: effectiveFast,
              signal,
              isBackground,
              foregroundTask,
              backgroundTasks,
              foregroundTasks,
              deliveryGuard,
              taskWidget,
              ensureTaskWidget: () =>
                ignoreStaleExtensionCtx(() => ensureTaskWidget(ctx)),
              clearTaskWidgetIfIdle,
              enqueueDelivery: (delivery) => completionDeliveryQueue.enqueue(delivery),
            });
          }

      return executeTerminalTask({
        id,
        agentName: agent.name,
        description: descText,
        sessionName,
        sessionDir,
        artifactsDir,
        cwd: taskCwd,
        conversationId,
        piDir,
        prompt: claudePrompt ?? promptContent,
        runtime: claudeTaskRuntime,
        ...(claudeRuntime ? { claudeSessionId, claudeSessionFile } : {}),
        piArgs,
        selectedBackend,
        requestedBackend,
        terminalBackend: herdrBackend,
        workspaceGroup: taskParams.workspace_group,
        foregroundTask,
        agentMaxTurns: () => agent.maxTurns,
        signal,
        onUpdate,
        ctx,
        pi,
        backgroundTasks,
        foregroundTasks,
        deliveryGuard,
        clearTaskWidgetIfIdle,
        ensureTaskWidget: () =>
          ignoreStaleExtensionCtx(() => ensureTaskWidget(ctx)),
      });
      });
      } catch (error) {
        if (!(error instanceof DurableStateError)) throw error;
        return {
          content: [{
            type: "text" as const,
            text: `${error.message} Repair the durable file before retrying the task operation.`,
          }],
          details: {
            phase: "failed" as const,
            error: "durable_state_unreadable",
            file: basename(error.file),
            reason: error.reason,
          },
          isError: true,
        };
      }
    },

        renderCall,
        renderResult,
  });

  /** Durable conversation rows for a pi dir, or a reason they could not be read. */
  const taskSessionListing = (cwd: string): { text: string; level: "info" | "error" } => {
    try {
      const { piDir } = discoverAgents(cwd);
      const registry = readTaskSessionsRegistry(piDir);
      const rows = Object.entries(registry)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([conversationId, entry]) => `- ${conversationId} -> ${entry.task_id}`);
      return {
        text: rows.length > 0
          ? `Durable pi-task conversations:\n${rows.join("\n")}`
          : "No durable pi-task conversations found.",
        level: "info",
      };
    } catch (error) {
      return {
        text: error instanceof Error
          ? `${error.message} Repair the file before retrying.`
          : `Could not read durable pi-task conversations: ${String(error)}`,
        level: "error",
      };
    }
  };

  /**
   * Task control for the user.
   *
   * Status and cancel used to be tool operations, which cost the model a turn
   * to reach and every turn a schema entry to describe. They are a user action,
   * so they belong on a command.
   */
  pi.registerCommand("task", {
    description: "List tasks, or inspect or cancel one: /task [list | status <id> | cancel <id>]",
    handler: async (args, ctx) => {
      const [subcommand, id] = args.trim().split(/\s+/).filter(Boolean);
      if (subcommand !== "status" && subcommand !== "cancel") {
        const listing = taskSessionListing(ctx.sessionManager?.getCwd?.() ?? process.cwd());
        ctx.ui.notify(listing.text, listing.level);
        return;
      }
      const request = parseTaskControlRequest({ operation: subcommand, task_id: id });
      if (!request) {
        ctx.ui.notify(`/task ${subcommand} needs a task id. Run /task to list them.`, "error");
        return;
      }
      const result = await controlTask(request);
      ctx.ui.notify(result.content[0].text.trim(), result.isError ? "error" : "info");
    },
  });
}
