import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { TASK_TIMEOUT_MS } from "../constants.js";
import {
  assessTaskResult,
  formatComparisonReport,
  parseResultXml,
  subscribeToolEvents,
  type AgentConfig,
  type ComparisonRunResult,
} from "../helpers.js";
import { persistComparisonTaskHistory } from "../comparison.js";
import type { ComparisonCoordinator } from "../comparison.js";
import { sessionViewOf } from "../panel/delivery.js";
import type { DeliveryGuard } from "../panel/delivery.js";
import type { BackgroundTask } from "../types.js";
import { durableParentOf } from "./ownership.js";
import type { TaskWidgetController } from "./widget.js";
import { runSdkSubagent } from "../subagent/runSdk.js";
import { startSdkBackgroundTask } from "../subagent/sdkBackground.js";

export interface SdkComparisonSibling {
  id: string;
  index: 0 | 1;
  model: string;
  agent: AgentConfig;
  desc: string;
  sessionName: string;
  sessionDir: string;
}

export interface SdkComparisonExecutionOptions {
  siblings: readonly [SdkComparisonSibling, SdkComparisonSibling];
  baseId: string;
  groupId: string;
  agent: AgentConfig;
  description: string;
  prompt: string;
  cwd: string;
  ctx: ExtensionContext;
  pi: ExtensionAPI;
  piDir: string;
  artifactsDir: string;
  skillPaths: string[];
  fast: boolean;
  signal?: AbortSignal;
  isBackground: boolean;
  toolSelection: {
    tools: string[];
    excludeTools: string[];
  };
  foregroundTasks: Map<string, BackgroundTask>;
  backgroundTasks: Map<string, BackgroundTask>;
  deliveryGuard: DeliveryGuard;
  comparisonCoordinator: ComparisonCoordinator;
  taskWidget: Pick<
    TaskWidgetController,
    "requestRender" | "getContext" | "noteTaskFinished"
  >;
  ensureTaskWidget: () => void;
  clearTaskWidgetIfIdle: () => void;
  markComparisonGroupPartiallyDelivered: (taskIds: string[]) => void;
}

export async function executeSdkComparison({
  siblings,
  baseId,
  groupId,
  agent,
  description,
  prompt,
  cwd,
  ctx,
  pi,
  piDir,
  artifactsDir,
  skillPaths,
  fast,
  signal,
  isBackground,
  toolSelection,
  foregroundTasks,
  backgroundTasks,
  deliveryGuard,
  comparisonCoordinator,
  taskWidget,
  ensureTaskWidget,
  clearTaskWidgetIfIdle,
  markComparisonGroupPartiallyDelivered,
}: SdkComparisonExecutionOptions) {
  if (!isBackground) {
    const fgTasks = siblings.map((s) => {
      const fg: BackgroundTask = {
        dir: artifactsDir,
        cwd,
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
        comparisonDescription: description,
        comparisonIndex: s.index,
      };
      foregroundTasks.set(s.id, fg);
      return fg;
    });
    ensureTaskWidget();

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
              onSession: (session) =>
                subscribeToolEvents(session, fg, 10, taskWidget.requestRender),
              sessionName: fg.sessionName,
              prompt,
              agent: s.agent,
              cwd,
              ctx,
              model: s.model,
              thinkingLevel: s.agent.thinking,
              tools: toolSelection.tools,
              excludeTools: toolSelection.excludeTools,
              systemPrompt: agent.body,
              skillPaths,
              fast,
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
        description,
        runs,
      });

      return {
        content: [{ type: "text" as const, text: report }],
        details: {
          phase: "done" as const,
          compare: true,
          agent_type: agent.name,
          description,
          models: [siblings[0].model, siblings[1].model],
          runs,
        },
      };
    } finally {
      for (const s of siblings) foregroundTasks.delete(s.id);
      clearTaskWidgetIfIdle();
    }
  }

  comparisonCoordinator.registerGroup(
    groupId,
    baseId,
    agent.name,
    description,
    [siblings[0].id, siblings[1].id],
    [siblings[0].model, siblings[1].model],
  );

  for (const s of siblings) {
    const bg: BackgroundTask = {
      dir: artifactsDir,
      cwd,
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
      comparisonDescription: description,
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
      cwd,
      comparisonGroupId: groupId,
      comparisonModel: s.model,
      comparisonDescription: description,
      comparisonIndex: s.index,
      ...durableParentOf(sessionViewOf(ctx)),
      run: () =>
        runSdkSubagent({
          onSession: (session) =>
            subscribeToolEvents(session, bg, 10, taskWidget.requestRender),
          sessionName: s.sessionName,
          prompt,
          agent: s.agent,
          cwd,
          ctx,
          model: s.model,
          thinkingLevel: s.agent.thinking,
          tools: toolSelection.tools,
          excludeTools: toolSelection.excludeTools,
          systemPrompt: agent.body,
          skillPaths,
          fast,
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
            return current
              ? deliveryGuard.allows(sessionViewOf(current), taskId)
              : true;
          },
          markComparisonGroupPartiallyDelivered,
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
            return current
              ? deliveryGuard.allows(sessionViewOf(current), taskId)
              : true;
          },
          markComparisonGroupPartiallyDelivered,
        );
      },
      onSettled: () => {
        taskWidget.noteTaskFinished(s.id, bg);
        backgroundTasks.delete(s.id);
        clearTaskWidgetIfIdle();
      },
    });
  }
  ensureTaskWidget();

  return {
    content: [
      {
        type: "text" as const,
        text: `Dual-model evaluation started for agent "${agent.name}":
- Model A: \`${siblings[0].model}\` (task \`${siblings[0].id}\`)
- Model B: \`${siblings[1].model}\` (task \`${siblings[1].id}\`)

Both subagents are running in background. Results will be compared and delivered once both complete.`,
      },
    ],
    details: {
      phase: "running" as const,
      compare: true,
      agent_type: agent.name,
      description,
      models: [siblings[0].model, siblings[1].model],
      task_ids: [siblings[0].id, siblings[1].id],
    },
  };
}
