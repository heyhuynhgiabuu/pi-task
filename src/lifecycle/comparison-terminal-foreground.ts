import { TASK_TIMEOUT_MS } from "../constants.js";
import {
  findJsonlSessionByName,
  upsertTaskSessionHistory,
} from "../conversation.js";
import {
  assessTaskResult,
  countToolUses,
  parseResultXml,
  type ComparisonRunResult,
} from "../helpers.js";
import type { BackgroundTask, TerminalHandle } from "../types.js";
import { killAgentPane, probePaneAsync } from "../subagent/tmux.js";
import type { TerminalBackend, TerminalBackendKind } from "../subagent/terminalBackend.js";
import {
  waitForTaskCompletion,
  type TaskCompletionSnapshot,
} from "../subagent/waitCompletion.js";
import {
  startForegroundProgressPolling,
  type ForegroundProgressPollOptions,
} from "../tool/foregroundProgress.js";

export interface ComparisonTerminalTask {
  id: string;
  index: 0 | 1;
  model: string;
  desc: string;
  sessionName: string;
  sessionDir: string;
  handle: TerminalHandle;
  paneId: string;
  originalPane: string | null;
  startedAt: number;
}

export interface ComparisonTerminalForegroundOptions {
  tasks: ComparisonTerminalTask[];
  agentType: string;
  description: string;
  groupId: string;
  artifactsDir: string;
  taskCwd: string;
  piDir: string;
  selectedBackend: TerminalBackendKind;
  terminalBackend: TerminalBackend;
  signal?: AbortSignal;
  onUpdate?: ForegroundProgressPollOptions["onUpdate"];
  ownerSessionId?: string;
  ownerLeafId?: string | null;
  foregroundTasks: Map<string, BackgroundTask>;
  requestRender: () => void;
  clearTaskWidgetIfIdle: () => void;
}

export async function executeComparisonTerminalForeground({
  tasks,
  agentType,
  description,
  groupId,
  artifactsDir,
  taskCwd,
  piDir,
  selectedBackend,
  terminalBackend,
  signal,
  onUpdate,
  ownerSessionId,
  ownerLeafId,
  foregroundTasks,
  requestRender,
  clearTaskWidgetIfIdle,
}: ComparisonTerminalForegroundOptions): Promise<[
  ComparisonRunResult,
  ComparisonRunResult,
]> {
  const stopProgress = tasks.map((task) =>
    startForegroundProgressPolling({
      taskId: task.id,
      sessionDir: task.sessionDir,
      sessionName: task.sessionName,
      agentType,
      description: task.desc,
      startedAt: task.startedAt,
      onUpdate: (update) => {
        const progress = update.details._taskRunningProgress;
        const foregroundTask = foregroundTasks.get(task.id);
        if (
          foregroundTask &&
          progress &&
          typeof progress === "object" &&
          "toolUses" in progress &&
          typeof progress.toolUses === "number"
        ) {
          foregroundTask.toolUses = progress.toolUses;
          requestRender();
        }
        onUpdate?.(update);
      },
    }),
  );

  try {
    const runs = (await Promise.all(
      tasks.map(async (task) => {
        upsertTaskSessionHistory(piDir, {
          id: task.id,
          agentType,
          description: task.desc,
          sessionName: task.sessionName,
          startedAt: task.startedAt,
          paneId: task.paneId,
          handle: task.handle,
          piDir,
          dir: artifactsDir,
          cwd: taskCwd,
          status: "running",
          background: false,
          ownerSessionId,
          ownerLeafId,
          ownerPid: process.pid,
          comparisonGroupId: groupId,
          comparisonModel: task.model,
          comparisonDescription: description,
          comparisonIndex: task.index,
        });

        const completion: TaskCompletionSnapshot = await waitForTaskCompletion({
          sessionDir: task.sessionDir,
          sessionName: task.sessionName,
          paneId: task.paneId,
          signal,
          timeoutMs: TASK_TIMEOUT_MS,
          pollMs: 1000,
          sinceMs: task.startedAt,
          resourceExists: selectedBackend === "herdr"
            ? () => terminalBackend.isAlive(task.handle as Extract<TerminalHandle, { backend: "herdr" }>)
            : () => probePaneAsync(task.paneId).then((probe) => probe.state),
        });

        if (task.handle.backend === "herdr") {
          await terminalBackend.close(task.handle);
        } else {
          killAgentPane(task.paneId, task.originalPane);
        }

        const parsed = parseResultXml(completion.content);
        const assessment = assessTaskResult(parsed);
        const phase = completion.status === "completed"
          ? "done"
          : completion.status === "cancelled"
            ? "cancelled"
            : "failed";
        const completedSessionRef = findJsonlSessionByName(
          piDir,
          task.id,
          agentType,
        )?.sessionRef;
        upsertTaskSessionHistory(piDir, {
          id: task.id,
          agentType,
          description: task.desc,
          sessionName: task.sessionName,
          startedAt: task.startedAt,
          paneId: task.paneId,
          handle: task.handle,
          piDir,
          dir: artifactsDir,
          cwd: taskCwd,
          sessionRef: completedSessionRef,
          status: phase,
          reportedStatus: assessment.reportedStatus,
          rawStatus: assessment.rawStatus,
          resultValid: assessment.valid,
          completedAt: Date.now(),
          background: false,
          ownerSessionId,
          ownerLeafId,
          comparisonGroupId: groupId,
          comparisonModel: task.model,
          comparisonDescription: description,
          comparisonIndex: task.index,
        });
        const { toolUses } = countToolUses(task.sessionDir, task.sessionName);
        return {
          model: task.model,
          taskId: task.id,
          status: completion.status === "completed" ? assessment.reportedStatus : "failure",
          rawStatus: completion.status === "completed" ? assessment.rawStatus : completion.status,
          summary: parsed.summary,
          findings: parsed.findings,
          evidence: parsed.evidence,
          files: parsed.files,
          caveats: parsed.caveats,
          nextSteps: parsed.next_steps,
          toolUses,
          durationMs: Date.now() - task.startedAt,
          sessionPath: completedSessionRef,
        } satisfies ComparisonRunResult;
      }),
    )) as [ComparisonRunResult, ComparisonRunResult];
    return runs;
  } finally {
    for (const stop of stopProgress) stop();
    for (const task of tasks) foregroundTasks.delete(task.id);
    clearTaskWidgetIfIdle();
  }
}
