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
import { registerTaskFastModeBridge } from "./fast-mode.js";
export { createTaskFastModeStream, registerTaskFastModeBridge } from "./fast-mode.js";
export type { TaskToolParameters } from "./tool/schema.js";
import {
  normalizeConversationId,
  markComparisonGroupDelivered,
  markComparisonGroupPartiallyDelivered,
  readTaskSessionHistory,
  readTaskSessionsRegistry,
  writeTaskSessionsRegistry,
} from "./conversation.js";
import {
  TASK_BACKGROUND_DEFAULT,
  buildPiArgs,
  buildTaskToolDescription,
      discoverAgents,
  resolveTaskAgentPreflight,
  resolveTaskFastMode,
  formatComparisonReport,
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
  executeComparisonTerminalForeground,
  executeTerminalTask,
  restoreActiveBackgroundTasks,
  startBackgroundPolling,
  startToolStatsPolling,
  durableParentOf,
  createRegistryEntryStatus,
  executeSdkTask,
  executeSdkComparison,
  executeComparisonTerminalBackground,
  launchComparisonTerminalTasks,
  resolveConversationResume,
  resolveTaskResume,
  createComparisonSettledHandler,
} from "./lifecycle/index.js";
import { DeliveryGuard, sessionViewOf } from "./panel/delivery.js";
import { reconcileStaleSdkBackgroundTasks } from "./subagent/sdkBackground.js";
import { resolveAgentSkillPaths } from "./subagent/skills.js";
import {
  createDefaultHerdrTerminalBackend,
  createSyncHerdrControl,
  resolveHerdrPiIntegrationExtension,
} from "./subagent/herdr.js";
import { resolveTaskBackend } from "./subagent/selectBackend.js";
import {
  steerRunningBackgroundTask,
  steerRunningBackgroundTaskAsync,
} from "./subagent/steer.js";
import {
  checkTaskCompletion,
} from "./subagent/waitCompletion.js";
import {
  hasTmux,
  killAgentPaneStrictAsync,
  probePaneAsync,
} from "./subagent/tmux.js";
import {
  buildTaskPrompt,
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
  taskControlRequestError,
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
  // Register in both branches so a manual `pi -e pi-task --fast` in a normal
  // session is accepted instead of dying as "Unknown option: --fast". The
  // bridge is only installed in the disabled recursive-child branch below.
  pi.registerFlag("fast", {
    description: "Use priority service tier for this delegated child",
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
  const completeTaskWithDelivery: typeof completeTask = (
    piArg,
    id,
    task,
    content,
    phase,
    taskPiDir,
    resourceCloser,
    deliveryGuardFn,
    onComparisonSettled,
  ) =>
    completeTask(
      piArg,
      id,
      task,
      content,
      phase,
      taskPiDir,
      resourceCloser,
      deliveryGuardFn,
      onComparisonSettled,
      undefined,
      completionDeliveryQueue,
    );

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
      for (const history of readTaskSessionHistory(piDir)) {
        if (history.ownerSessionId === undefined) continue;
        deliveryGuard.restore(history.id, {
          sessionId: history.ownerSessionId,
          leafId: history.ownerLeafId ?? null,
        });
      }
      for (const [id, task] of backgroundTasks) {
        if (task.ownerSessionId === undefined) continue;
        deliveryGuard.restore(id, {
          sessionId: task.ownerSessionId,
          leafId: task.ownerLeafId ?? null,
        });
      }
    }

    const restoredComparisonRuns = restoreComparisonGroups(
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
      const controlError = taskControlRequestError(params);
      if (controlError) {
        return {
          content: [{ type: "text" as const, text: controlError }],
          details: { phase: "failed" as const, error: "invalid_task_control_request" },
          isError: true,
        };
      }
      const controlRequest = parseTaskControlRequest(params);
      if (controlRequest) return controlTask(controlRequest);
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

      const taskCwdResolution = resolveTaskCwd(ctx.cwd, taskParams.cwd, persistedTaskCwd);
      if (taskCwdResolution.kind === "invalid") {
        return {
          content: [{ type: "text" as const, text: taskCwdResolution.message }],
          details: { phase: "failed" as const, error: "invalid cwd" },
          isError: true,
        };
      }
      const taskCwd = taskCwdResolution.cwd;
      let skillPaths: string[];
      try {
        skillPaths = await resolveAgentSkillPaths(
          agent.skills,
          taskCwd,
          ctx.isProjectTrusted(),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: message }],
          details: { phase: "failed" as const, error: "agent skills unavailable" },
          isError: true,
        };
      }

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
            parentContext: taskParams.parent_context,
            proposedChanges: taskParams.proposed_changes,
            cwd: taskCwd,
          });

          const sessionDir = join(artifactsDir, "sessions", id);
          await mkdir(sessionDir, { recursive: true });

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
      const effectiveFast = resolveTaskFastMode(taskParams.fast, agent.fast);

      if (taskParams.compare) {
        const compareModels = resolveCompareModels(agent);
        if (!compareModels.ok) {
          return {
            content: [{ type: "text" as const, text: compareModels.reason }],
            details: { phase: "failed" as const, error: "insufficient_models_for_compare" },
            isError: true,
          };
        }
        const [modelA, modelB] = compareModels.models;
        const baseId = `${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`;
        const groupId = `compare-${baseId}`;
        const id0 = `${baseId}-m0`;
        const id1 = `${baseId}-m1`;
        const sessionName0 = `task-${id0}`;
        const sessionName1 = `task-${id1}`;
        const sessionDir0 = join(artifactsDir, "sessions", id0);
        const sessionDir1 = join(artifactsDir, "sessions", id1);
        await mkdir(sessionDir0, { recursive: true });
        await mkdir(sessionDir1, { recursive: true });

        const specA = agent.modelSpecs?.find((s) => s.model === modelA);
        const specB = agent.modelSpecs?.find((s) => s.model === modelB);

        const siblings = [
          {
            id: id0,
            index: 0 as const,
            model: modelA,
            agent: { ...agent, model: modelA, thinking: specA?.thinking ?? agent.thinking },
            desc: descText ? `${descText} [${modelA}]` : `[${modelA}]`,
            sessionName: sessionName0,
            sessionDir: sessionDir0,
          },
          {
            id: id1,
            index: 1 as const,
            model: modelB,
            agent: { ...agent, model: modelB, thinking: specB?.thinking ?? agent.thinking },
            desc: descText ? `${descText} [${modelB}]` : `[${modelB}]`,
            sessionName: sessionName1,
            sessionDir: sessionDir1,
          },
        ] as const;

        const toolSelection = buildAgentToolSelection({
          tools: agent.tools,
          disallowedTools: agent.disallowedTools,
          parentToolNames,
          taskToolName,
        });

        if (selectedBackend === "sdk") {
          return executeSdkComparison({
            siblings,
            baseId,
            groupId,
            agent,
            description: descText,
            prompt: promptContent,
            cwd: taskCwd,
            ctx,
            pi,
            piDir,
            artifactsDir,
            skillPaths,
            fast: effectiveFast,
            signal,
            isBackground,
            toolSelection,
            foregroundTasks,
            backgroundTasks,
            deliveryGuard,
            comparisonCoordinator,
            taskWidget,
            ensureTaskWidget: () =>
              ignoreStaleExtensionCtx(() => ensureTaskWidget(ctx)),
            clearTaskWidgetIfIdle,
            markComparisonGroupPartiallyDelivered: (taskIds) =>
              markComparisonGroupPartiallyDelivered(piDir, taskIds),
          });
        }

        // Terminal backend (tmux / HerdR)
        const herdrRequiredExtension =
          selectedBackend === "herdr"
            ? resolveHerdrPiIntegrationExtension()
            : undefined;
        let terminalTasks: Awaited<ReturnType<typeof launchComparisonTerminalTasks>>;
        try {
          terminalTasks = await launchComparisonTerminalTasks({
            siblings,
            agentName: agent.name,
            selectedBackend,
            terminalBackend: herdrBackend,
            prompt: promptContent,
            cwd: taskCwd,
            parentToolNames,
            taskToolName,
            skillPaths,
            fast: effectiveFast,
            taskExtensionPath: TASK_EXTENSION_PATH,
            herdrRequiredExtension,
            workspaceGroup: taskParams.workspace_group,
            isBackground,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: "text" as const, text: `Failed to create ${selectedBackend} execution panes for comparison: ${message}` }],
            details: { phase: "failed" as const, error: `${selectedBackend} launch failed`, reason: message },
            isError: true,
          };
        }

        // Ownership (issue #20) is stamped identically on every record this
        // compare run persists (history spawn records and registry entries).
        const owner = durableParentOf(sessionViewOf(ctx));
        const ownerSessionId = owner.ownerSessionId;
        const ownerLeafId = owner.ownerLeafId;
        if (!isBackground) {
          for (const t of terminalTasks) {
            foregroundTasks.set(t.id, {
              dir: artifactsDir,
              cwd: taskCwd,
              agentType: agent.name,
              sessionName: t.sessionName,
              backend: selectedBackend,
              paneId: t.paneId,
              handle: t.handle,
              originalPane: t.originalPane,
              description: t.desc,
              startedAt: t.startedAt,
              toolUses: 0,
              turns: 0,
              recentCalls: [],
              comparisonGroupId: groupId,
              comparisonModel: t.model,
              comparisonDescription: descText,
              comparisonIndex: t.index,
              ownerSessionId,
              ownerLeafId,
            });
          }
          ignoreStaleExtensionCtx(() => ensureTaskWidget(ctx));
          const runs = await executeComparisonTerminalForeground({
            tasks: terminalTasks,
            groupId,
            agentType: agent.name,
            description: descText,
            artifactsDir,
            taskCwd,
            piDir,
            selectedBackend,
            terminalBackend: herdrBackend,
            signal,
            onUpdate,
            ownerSessionId,
            ownerLeafId,
            foregroundTasks,
            requestRender: taskWidget.requestRender,
            clearTaskWidgetIfIdle,
          });

          const report = formatComparisonReport({
            agentType: agent.name,
            description: descText,
            runs,
          });

          return {
            content: [{ type: "text" as const, text: report }],
            details: {
              phase: "done" as const,
              compare: true,
              agent_type: agent.name,
              description: descText,
              models: [modelA, modelB],
              runs,
            },
          };
        }

        // Terminal Background
        return executeComparisonTerminalBackground({
          tasks: terminalTasks,
          groupId,
          baseId,
          agentType: agent.name,
          description: descText,
          agentMaxTurns: agent.maxTurns,
          selectedBackend,
          piDir,
          artifactsDir,
          cwd: taskCwd,
          ctx,
          ownerSessionId,
          ownerLeafId,
          backgroundTasks,
          deliveryGuard,
          comparisonCoordinator,
          ensureTaskWidget: () =>
            ignoreStaleExtensionCtx(() => ensureTaskWidget(ctx)),
        });
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
      const herdrRequiredExtension =
        selectedBackend === "herdr"
          ? resolveHerdrPiIntegrationExtension()
          : undefined;
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
        prompt: promptContent,
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
