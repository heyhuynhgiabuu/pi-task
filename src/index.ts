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
import { registerTaskFastModeBridge } from "./fast-mode.js";
export { createTaskFastModeStream, registerTaskFastModeBridge } from "./fast-mode.js";
export type { TaskToolParameters } from "./tool/schema.js";
import {
  findJsonlSessionByName,
  normalizeConversationId,
  findTaskSessionHistory,
  repairTaskSessionRef,
  markComparisonGroupDelivered,
  markComparisonGroupPartiallyDelivered,
  readRegistry,
  readTaskSessionHistory,
  readTaskSessionsRegistry,
  updateRegistry,
  upsertTaskSessionHistory,
  writeTaskSessionsRegistry,
} from "./conversation.js";
import {
  TASK_BACKGROUND_DEFAULT,
  buildPiArgs,
  buildTaskToolDescription,
      discoverAgents,
      subscribeToolEvents,
  resolveTaskAgentPreflight,
  resolveTaskFastMode,
  envTurnLimit,
  assessTaskResult,
  buildTaskEnvelope,
  structuredResultPayload,
  taskResultContentText,
  completionDeliveryOptions,
  formatBackgroundReceipt,
  formatComparisonReport,
  isTaskCompareAllowed,
  parseResultXml,
  resolveCompareModels,
  type ComparisonRunResult,
} from "./helpers.js";
import {
  ComparisonCoordinator,
  persistComparisonTaskHistory,
} from "./comparison.js";
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
  executeTerminalForegroundTask,
  executeComparisonTerminalForeground,
  registerBackgroundTask,
  restoreActiveBackgroundTasks,
  startBackgroundPolling,
  startToolStatsPolling,
  durableParentOf,
  transferTaskOwnership,
  createRegistryEntryStatus,
  createComparisonSettledHandler,
} from "./lifecycle/index.js";
import { DeliveryGuard, sessionViewOf } from "./panel/delivery.js";
import {
  formatSdkBackgroundReceipt,
  reconcileStaleSdkBackgroundTasks,
  startSdkBackgroundTask,
} from "./subagent/sdkBackground.js";
import {
  runSdkSubagent,
  SdkSubagentInterruptedError,
} from "./subagent/runSdk.js";
import { resolveAgentSkillPaths } from "./subagent/skills.js";
import {
  createDefaultHerdrTerminalBackend,
  createSyncHerdrControl,
  resolveHerdrPiIntegrationExtension,
} from "./subagent/herdr.js";
import { describeCommandFailure } from "./subagent/terminalBackend.js";
import { resolveTaskBackend } from "./subagent/selectBackend.js";
import {
  steerRunningBackgroundTask,
  steerRunningBackgroundTaskAsync,
} from "./subagent/steer.js";
import { launchTerminalTask } from "./subagent/terminal-launch.js";
import {
  checkTaskCompletion,
} from "./subagent/waitCompletion.js";
import {
  hasTmux,
  killAgentPane,
  killAgentPaneStrictAsync,
  probePaneAsync,
} from "./subagent/tmux.js";
import {
  buildTaskFollowUpPrompt,
  buildTaskPrompt,
  createTaskCompleteRenderer,
  renderCall,
  renderResult,
  taskParametersSchema,
} from "./tool/index.js";
import type {
  BackgroundTask,
  TerminalHandle,
} from "./types.js";
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
            id = registeredTaskId;
            sessionName = conversationId ?? `task-${id}`;
            const previous = findTaskSessionHistory(piDir, id);
            const repairedPrevious = previous
              ? repairTaskSessionRef(piDir, previous)
              : undefined;
            persistedTaskCwd = repairedPrevious?.cwd ?? previous?.cwd;
            resumeSessionRef = repairedPrevious?.sessionRef;
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
        if (entry?.comparisonGroupId || repairedPrevious?.comparisonGroupId) {
          return {
            content: [{ type: "text" as const, text: "Comparison tasks cannot be resumed individually." }],
            details: { phase: "failed" as const, error: "resume_unsupported_for_compare", task_id: id },
            isError: true,
          };
        }
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
            maxTurns: entry.maxTurns,
            conversationId,
            ...durableParentOf(sessionViewOf(ctx)),
            recentCalls: [],
          };
                    backgroundTasks.set(id, bgtask);
                    deliveryGuard.track(id, sessionViewOf(ctx));
                    transferTaskOwnership(extensionPiDir, entry, sessionViewOf(ctx));
          const steerResult = steerRunningBackgroundTask(
            bgtask.paneId,
            buildTaskFollowUpPrompt({
              prompt: taskParams.prompt,
              parentContext: taskParams.parent_context,
              proposedChanges: taskParams.proposed_changes,
            }),
            bgtask.handle,
          );
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

        if (!resumeSessionRef) {
          return {
            content: [{
              type: "text" as const,
              text: `Conversation "${conversationId}" was found, but its session JSONL file could not be resolved. Cannot resume without a --session file path.`,
            }],
            details: {
              phase: "failed" as const,
              error: "Conversation session file missing",
              conversation_id: conversationId,
            },
            isError: true,
          };
        }
      } else if (taskParams.task_id) {
        // Look up active tasks first, then durable completed-session history.
        const entries = readRegistry(piDir);
        const registryEntry = entries.find(
          (e) => e.id === taskParams.task_id || e.sessionName === taskParams.task_id,
        );
        let entry =
          registryEntry ??
          findTaskSessionHistory(piDir, taskParams.task_id) ??
          findJsonlSessionByName(piDir, taskParams.task_id, agent.name);

        // Older history entries can lack the JSONL path needed by
        // `pi --session`, or hold a stale one. Repair it (and the durable
        // record) before the spawn reuses it.
        if (entry) entry = repairTaskSessionRef(piDir, entry);
        if (entry?.comparisonGroupId) {
          return {
            content: [{ type: "text" as const, text: "Comparison tasks cannot be resumed individually." }],
            details: { phase: "failed" as const, error: "resume_unsupported_for_compare", task_id: entry.id },
            isError: true,
          };
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
        // repairTaskSessionRef ran above: a present sessionRef implies the
        // file exists (valid refs are kept, stale ones re-discovered). A
        // stale recorded dir must not block resume when the transcript is
        // discoverable — the spawn writes runtime files under the current
        // artifacts root and heals the record.
        if (!existsSync(entry.dir) && !entry.sessionRef) {
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
            maxTurns: entry.maxTurns,
            conversationId: entry.conversationId,
            ...durableParentOf(sessionViewOf(ctx)),
            recentCalls: [],
          };
          backgroundTasks.set(id, bgtask);
          deliveryGuard.track(id, sessionViewOf(ctx));
          transferTaskOwnership(extensionPiDir, registryEntry, sessionViewOf(ctx));
          const steerResult = steerRunningBackgroundTask(
            bgtask.paneId,
            buildTaskFollowUpPrompt({
              prompt: taskParams.prompt,
              parentContext: taskParams.parent_context,
              proposedChanges: taskParams.proposed_changes,
            }),
            bgtask.handle,
          );
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
          if (!isBackground) {
            const fgTasks = siblings.map((s) => {
              const fg: BackgroundTask = {
                dir: artifactsDir,
                cwd: taskCwd,
                agentType: agent.name,
                sessionName: s.sessionName,
                backend: "sdk",
                originalPane: null,
                description: s.desc,
                startedAt: Date.now(),
                toolUses: 0,
                turns: 0,
                ...durableParentOf(sessionViewOf(ctx)),
                recentCalls: [],
                comparisonGroupId: groupId,
                comparisonModel: s.model,
                comparisonDescription: descText,
                comparisonIndex: s.index,
              };
              foregroundTasks.set(s.id, fg);
              return fg;
            });
            ignoreStaleExtensionCtx(() => ensureTaskWidget(ctx));

            try {
              for (let i = 0; i < siblings.length; i++) {
                persistComparisonTaskHistory(piDir, {
                  id: siblings[i]!.id,
                  task: fgTasks[i]!,
                  status: "running",
                  background: false,
                });
              }
              const runs = (await Promise.all(
                siblings.map(async (s, i) => {
                  const fg = fgTasks[i]!;
                  try {
                    const res = await runSdkSubagent({
                      onSession: (session) => subscribeToolEvents(session, fg, 10, taskWidget.requestRender),
                      sessionName: fg.sessionName,
                      prompt: promptContent,
                      agent: s.agent,
                      cwd: taskCwd,
                      ctx,
                      model: s.model,
                      thinkingLevel: s.agent.thinking,
                      tools: toolSelection.tools,
                      excludeTools: toolSelection.excludeTools,
                      systemPrompt: agent.body,
                      skillPaths,
                      fast: effectiveFast,
                      signal,
                      timeoutMs: TASK_TIMEOUT_MS,
                    });
                    const parsed = parseResultXml(res.output);
                    const assess = assessTaskResult(parsed);
                    const run = {
                      model: s.model,
                      taskId: s.id,
                      status: assess.reportedStatus,
                      rawStatus: assess.rawStatus,
                      summary: parsed.summary,
                      findings: parsed.findings,
                      evidence: parsed.evidence,
                      files: parsed.files,
                      caveats: parsed.caveats,
                      nextSteps: parsed.next_steps,
                      toolUses: fg.toolUses,
                      durationMs: Date.now() - fg.startedAt,
                      sessionPath: res.sessionPath ?? undefined,
                    } satisfies ComparisonRunResult;
                    persistComparisonTaskHistory(piDir, {
                      id: s.id,
                      task: fg,
                      status: "done",
                      background: false,
                      sessionRef: run.sessionPath,
                      reportedStatus: assess.reportedStatus,
                      rawStatus: assess.rawStatus,
                      resultValid: assess.valid,
                      completedAt: Date.now(),
                    });
                    return run;
                  } catch (err) {
                    const error = err instanceof Error ? err.message : String(err);
                    const run = {
                      model: s.model,
                      taskId: s.id,
                      status: "failure",
                      rawStatus: "failed",
                      summary: "",
                      findings: "",
                      evidence: "",
                      files: "",
                      caveats: "",
                      nextSteps: "",
                      toolUses: fg.toolUses,
                      durationMs: Date.now() - fg.startedAt,
                      error,
                    } satisfies ComparisonRunResult;
                    persistComparisonTaskHistory(piDir, {
                      id: s.id,
                      task: fg,
                      status: "failed",
                      background: false,
                      reportedStatus: "failure",
                      rawStatus: "failed",
                      resultValid: false,
                      completedAt: Date.now(),
                    });
                    return run;
                  }
                }),
              )) as [ComparisonRunResult, ComparisonRunResult];

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
            } finally {
              for (const s of siblings) foregroundTasks.delete(s.id);
              clearTaskWidgetIfIdle();
            }
          }

          // SDK Background
          comparisonCoordinator.registerGroup(
            groupId,
            baseId,
            agent.name,
            descText,
            [id0, id1],
            [modelA, modelB],
          );

          for (const s of siblings) {
            const bg: BackgroundTask = {
              dir: artifactsDir,
              cwd: taskCwd,
              agentType: agent.name,
              sessionName: s.sessionName,
              backend: "sdk",
              originalPane: null,
              description: s.desc,
              startedAt: Date.now(),
              toolUses: 0,
              turns: 0,
              ...durableParentOf(sessionViewOf(ctx)),
              recentCalls: [],
              comparisonGroupId: groupId,
              comparisonModel: s.model,
              comparisonDescription: descText,
              comparisonIndex: s.index,
            };
            backgroundTasks.set(s.id, bg);
            deliveryGuard.track(s.id, sessionViewOf(ctx));

            startSdkBackgroundTask({
              id: s.id,
              agentType: agent.name,
              description: s.desc,
              sessionName: s.sessionName,
              startedAt: bg.startedAt,
              piDir,
              artifactsDir,
              cwd: taskCwd,
              comparisonGroupId: groupId,
              comparisonModel: s.model,
              comparisonDescription: descText,
              comparisonIndex: s.index,
              ...durableParentOf(sessionViewOf(ctx)),
              run: () =>
                runSdkSubagent({
                  onSession: (session) => subscribeToolEvents(session, bg, 10, taskWidget.requestRender),
                  sessionName: s.sessionName,
                  prompt: promptContent,
                  agent: s.agent,
                  cwd: taskCwd,
                  ctx,
                  model: s.model,
                  thinkingLevel: s.agent.thinking,
                  tools: toolSelection.tools,
                  excludeTools: toolSelection.excludeTools,
                  systemPrompt: agent.body,
                  skillPaths,
                  fast: effectiveFast,
                  timeoutMs: TASK_TIMEOUT_MS,
                }),
              onComplete: (result) => {
                bg.status = "done";
                const parsed = parseResultXml(result.output);
                const assess = assessTaskResult(parsed);
                comparisonCoordinator.recordTaskSettled(
                  s.id,
                  {
                    model: s.model,
                    taskId: s.id,
                    status: assess.reportedStatus,
                    rawStatus: assess.rawStatus,
                    summary: parsed.summary,
                    findings: parsed.findings,
                    evidence: parsed.evidence,
                    files: parsed.files,
                    caveats: parsed.caveats,
                    nextSteps: parsed.next_steps,
                    toolUses: bg.toolUses,
                    durationMs: Date.now() - bg.startedAt,
                    sessionPath: result.sessionPath ?? undefined,
                  },
                  pi,
                  deliveryGuard.allows(sessionViewOf(ctx), s.id),
                  undefined,
                  (taskId) => {
                    const current = taskWidget.getContext();
                    return current ? deliveryGuard.allows(sessionViewOf(current), taskId) : true;
                  },
                  (taskIds) => markComparisonGroupPartiallyDelivered(piDir, taskIds),
                );
              },
              onFailed: (error) => {
                bg.status = "failed";
                comparisonCoordinator.recordTaskSettled(
                  s.id,
                  {
                    model: s.model,
                    taskId: s.id,
                    status: "failure",
                    rawStatus: "failed",
                    summary: "",
                    findings: "",
                    evidence: "",
                    files: "",
                    caveats: "",
                    nextSteps: "",
                    toolUses: bg.toolUses,
                    durationMs: Date.now() - bg.startedAt,
                    error: error instanceof Error ? error.message : String(error),
                  },
                  pi,
                  deliveryGuard.allows(sessionViewOf(ctx), s.id),
                  undefined,
                  (taskId) => {
                    const current = taskWidget.getContext();
                    return current ? deliveryGuard.allows(sessionViewOf(current), taskId) : true;
                  },
                  (taskIds) => markComparisonGroupPartiallyDelivered(piDir, taskIds),
                );
              },
              onSettled: () => {
                taskWidget.noteTaskFinished(s.id, bg);
                backgroundTasks.delete(s.id);
                clearTaskWidgetIfIdle();
              },
            });
          }
          ignoreStaleExtensionCtx(() => ensureTaskWidget(ctx));

          return {
            content: [
              {
                type: "text" as const,
                text: `Dual-model evaluation started for agent "${agent.name}":
- Model A: \`${modelA}\` (task \`${id0}\`)
- Model B: \`${modelB}\` (task \`${id1}\`)

Both subagents are running in background. Results will be compared and delivered once both complete.`,
              },
            ],
            details: {
              phase: "running" as const,
              compare: true,
              agent_type: agent.name,
              description: descText,
              models: [modelA, modelB],
              task_ids: [id0, id1],
            },
          };
        }

        // Terminal backend (tmux / HerdR)
        const terminalTasks: Array<(typeof siblings)[number] & { handle: TerminalHandle; paneId: string; originalPane: string | null; startedAt: number }> = [];
        const herdrRequiredExtension =
          selectedBackend === "herdr"
            ? resolveHerdrPiIntegrationExtension()
            : undefined;
        try {
          for (const s of siblings) {
            const startedAt = Date.now();
            let promptLaunch: { systemPromptPath: string; deferTaskPrompt: boolean } | undefined;
            if (selectedBackend === "herdr") {
              promptLaunch = {
                systemPromptPath: join(s.sessionDir, "agent-system-prompt.md"),
                deferTaskPrompt: true,
              };
              await writeFile(promptLaunch.systemPromptPath, s.agent.body, "utf8");
            }

            const piArgs = buildPiArgs(
              s.agent,
              s.sessionName,
              s.sessionDir,
              promptContent,
              false,
              parentToolNames,
              taskToolName,
              undefined,
              promptLaunch,
              skillPaths,
              effectiveFast,
              TASK_EXTENSION_PATH,
              herdrRequiredExtension ? [herdrRequiredExtension] : undefined,
            );

            const launched = await launchTerminalTask({
              backend: selectedBackend,
              terminalBackend: herdrBackend,
              agentArgs: piArgs,
              initialPrompt: promptContent,
              cwd: taskCwd,
              sessionDir: s.sessionDir,
              sessionName: s.sessionName,
              environment: { PI_TASK_TOOL_DISABLED: "1" },
              label: `${agent.name}-${s.id}`,
              workspaceGroup: taskParams.workspace_group,
              remainOnExit: !isBackground,
              selfDestruct: isBackground,
            });
            terminalTasks.push({ ...s, ...launched, startedAt });
          }
        } catch (error) {
          for (const t of terminalTasks) {
            try {
              if (t.handle.backend === "herdr") await herdrBackend.close(t.handle);
              else killAgentPane(t.paneId, t.originalPane);
            } catch {
              // Best effort cleanup of already created panes
            }
          }
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
        comparisonCoordinator.registerGroup(
          groupId,
          baseId,
          agent.name,
          descText,
          [id0, id1],
          [modelA, modelB],
        );

        const maxTurns = agent.maxTurns ?? envTurnLimit();
        for (const t of terminalTasks) {
          const bg: BackgroundTask = {
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
            maxTurns,
            recentCalls: [],
            comparisonGroupId: groupId,
            comparisonModel: t.model,
            comparisonDescription: descText,
            comparisonIndex: t.index,
            ownerSessionId,
            ownerLeafId,
          };
          backgroundTasks.set(t.id, bg);
          deliveryGuard.track(t.id, sessionViewOf(ctx));

          upsertTaskSessionHistory(piDir, {
            id: t.id,
            agentType: agent.name,
            description: t.desc,
            sessionName: t.sessionName,
            startedAt: bg.startedAt,
            paneId: t.paneId,
            handle: t.handle,
            piDir,
            dir: artifactsDir,
            cwd: taskCwd,
            status: "running",
            background: true,
            ownerSessionId,
            ownerLeafId,
            ownerPid: process.pid,
            comparisonGroupId: groupId,
            comparisonModel: t.model,
            comparisonDescription: descText,
            comparisonIndex: t.index,
          });

        }

        const comparisonIds = new Set(terminalTasks.map((t) => t.id));
        updateRegistry(piDir, (existingEntries) => [
          ...existingEntries.filter((entry) => !comparisonIds.has(entry.id)),
          ...terminalTasks.map((t) => ({
            id: t.id,
            agentType: agent.name,
            description: t.desc,
            sessionName: t.sessionName,
            startedAt: t.startedAt,
            paneId: t.paneId,
            handle: t.handle,
            backend: selectedBackend,
            piDir,
            dir: artifactsDir,
            cwd: taskCwd,
            maxTurns,
            ownerSessionId,
            ownerLeafId,
            ownerPid: process.pid,
            comparisonGroupId: groupId,
            comparisonModel: t.model,
            comparisonDescription: descText,
            comparisonIndex: t.index,
          })),
        ]);
        ignoreStaleExtensionCtx(() => ensureTaskWidget(ctx));

        return {
          content: [
            {
              type: "text" as const,
              text: `Dual-model evaluation started for agent "${agent.name}":
- Model A: \`${modelA}\` (task \`${id0}\`, pane \`${terminalTasks[0]!.paneId}\`)
- Model B: \`${modelB}\` (task \`${id1}\`, pane \`${terminalTasks[1]!.paneId}\`)

Both subagents are running in background. Results will be compared and delivered once both complete.`,
            },
          ],
          details: {
            phase: "running" as const,
            compare: true,
            agent_type: agent.name,
            description: descText,
            models: [modelA, modelB],
            task_ids: [id0, id1],
          },
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
          const runSdkFallback = async (
            foregroundTask?: BackgroundTask,
            onSession?: (session: any) => () => void,
          ) =>
            runSdkSubagent({
              onSession: foregroundTask
                ? (session) => subscribeToolEvents(session, foregroundTask, 10, taskWidget.requestRender)
                : onSession,
              sessionName: foregroundTask?.sessionName ?? sessionName,
              prompt: promptContent,
              agent,
              cwd: taskCwd,
              ctx,
              model: agent.model,
              thinkingLevel: agent.thinking,
              tools: toolSelection.tools,
              excludeTools: toolSelection.excludeTools,
              systemPrompt: agent.body,
              skillPaths,
              fast: effectiveFast,
              signal: foregroundTask ? signal : undefined,
              timeoutMs: TASK_TIMEOUT_MS,
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
                ...durableParentOf(sessionViewOf(ctx)),
                recentCalls: [],
              };
              backgroundTasks.set(id, backgroundTask);
              deliveryGuard.track(id, sessionViewOf(ctx));
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
                ...durableParentOf(sessionViewOf(ctx)),
                run: async () => runSdkFallback(undefined, bgOnSession),
                deliver: (delivery) => completionDeliveryQueue.enqueue(delivery),
                onComplete: (result) => {
                  if (!deliveryGuard.allows(sessionViewOf(ctx), id)) return;
                  backgroundTask.status = "done";
                  const parsed = parseResultXml(result.output);
                  const assessment = assessTaskResult(parsed);
                  const summary =
                    taskResultContentText(parsed, assessment) ||
                    "SDK subagent completed without assistant text.";
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
                          raw_status: assessment.rawStatus,
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
                          structured_result: structuredResultPayload(assessment),
                          full_output: parsed.raw.trim() || result.output.trim(),
                        },
                      },
                      completionDeliveryOptions(process.env.PI_TASK_COMPLETION_DELIVERY),
                    ),
                  );
                },
                onFailed: (error) => {
                  if (!deliveryGuard.allows(sessionViewOf(ctx), id)) return;
                  const interrupted = error instanceof SdkSubagentInterruptedError;
                  const phase = interrupted && error.kind === "timeout" ? "timeout" : "failed";
                  backgroundTask.status = phase;
                  const message = error instanceof Error ? error.message : String(error);
                  ignoreStaleExtensionCtx(() =>
                    pi.sendMessage(
                      {
                        customType: "task-complete",
                        content: `Background task ${id} (${agent.name}) ${phase}.\n\n${message}`,
                        display: true,
                        details: {
                          task_id: id,
                          agent_type: agent.name,
                          description: descText,
                          phase,
                          execution_phase: phase,
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
                      completionDeliveryOptions(process.env.PI_TASK_COMPLETION_DELIVERY),
                    ),
                  );
                },
                onSettled: () => {
                  taskWidget.noteTaskFinished(id, backgroundTasks.get(id) ?? backgroundTask);
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
                  raw_status: assessment.rawStatus,
                  result_valid: assessment.valid,
                  backend: "sdk" as const,
                  session_path: sessionPath,
                  conversation_id: conversationId,
                  full_output: parsed.raw.trim() || finalOutput,
                },
              };
        } catch (error) {
          const interrupted = error instanceof SdkSubagentInterruptedError;
          const phase = interrupted && error.kind === "cancelled" ? "cancelled" :
            interrupted && error.kind === "timeout" ? "timeout" : "failed";
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [
              { type: "text" as const, text: `SDK task ${phase}: ${message}` },
            ],
            details: {
              phase,
              execution_phase: phase,
              status: "unknown",
              reported_status: "unknown",
              result_valid: false,
              backend: "sdk" as const,
              error: message,
            },
            isError: phase === "failed",
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
        const launched = await launchTerminalTask({
          backend: selectedBackend,
          terminalBackend: herdrBackend,
          agentArgs: piArgs,
          initialPrompt: promptContent,
          cwd: taskCwd,
          sessionDir,
          sessionName,
          environment: { PI_TASK_TOOL_DISABLED: "1" },
          label: `${agent.name}-${id.slice(0, 8)}`,
          workspaceGroup: taskParams.workspace_group,
          remainOnExit: Boolean(foregroundTask),
          selfDestruct: !foregroundTask,
        });
        ({ handle, paneId, originalPane } = launched);
        if (foregroundTask) {
          foregroundTask.backend = selectedBackend;
          foregroundTask.paneId = paneId;
          foregroundTask.handle = handle;
          foregroundTask.originalPane = originalPane;
        }
      } catch (error) {
        foregroundTasks.delete(id);
        clearTaskWidgetIfIdle();
        const reason = describeCommandFailure(error);
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to create ${selectedBackend} execution pane for the agent: ${reason}`,
            },
          ],
          details: { phase: "failed" as const, error: `${selectedBackend} launch failed`, reason },
          isError: true,
        };
      }

      // ── FOREGROUND MODE: block until result, return directly ────────────
      const owner = durableParentOf(sessionViewOf(ctx));
      const ownerSessionId = owner.ownerSessionId;
      const ownerLeafId = owner.ownerLeafId;
      if (!isBackground) {
        return executeTerminalForegroundTask({
          id,
          agentType: agent.name,
          description: descText,
          sessionName,
          sessionDir,
          artifactsDir,
          taskCwd,
          conversationId,
          piDir,
          handle,
          paneId,
          originalPane,
          startedAt: foregroundTask?.startedAt ?? Date.now(),
          ownerSessionId,
          ownerLeafId,
          selectedBackend,
          terminalBackend: herdrBackend,
          signal,
          onUpdate,
          foregroundTasks,
          clearTaskWidgetIfIdle,
        });
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
        maxTurns: agent.maxTurns ?? envTurnLimit(),
        conversationId,
        ownerSessionId,
        ownerLeafId,
        recentCalls: [],
        backend: selectedBackend,
      };

      registerBackgroundTask({
        id,
        task: bgtask,
        piDir,
        pi,
        backgroundTasks,
        trackDelivery: () => deliveryGuard.track(id, sessionViewOf(ctx)),
        ensureTaskWidget: () => ignoreStaleExtensionCtx(() => ensureTaskWidget(ctx)),
      });

      // Do not kill a background subagent when the parent session aborts or is
      // replaced. Background tasks are intentionally detached; the registry and
      // polling loop own their lifecycle after the pane is spawned.

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
