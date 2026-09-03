import { upsertTaskSessionHistory } from "../conversation.js";
import { assessTaskResult, parseResultXml } from "../helpers.js";

export interface SdkBackgroundResult {
  output: string;
  sessionPath?: string | null;
}

export interface SdkBackgroundTaskInput {
  id: string;
  agentType: string;
  description: string;
  sessionName: string;
  startedAt: number;
  piDir: string;
  artifactsDir: string;
  cwd?: string;
  conversationId?: string;
  comparisonGroupId?: string;
  comparisonModel?: string;
  comparisonDescription?: string;
  comparisonIndex?: 0 | 1;
  run: () => Promise<SdkBackgroundResult>;
  onComplete?: (result: SdkBackgroundResult) => void;
  onFailed?: (error: unknown) => void;
  onSettled?: () => void;
  now?: () => number;
}

export function startSdkBackgroundTask(input: SdkBackgroundTaskInput): void {
  const now = input.now ?? Date.now;

  try {
    upsertTaskSessionHistory(input.piDir, {
    id: input.id,
    agentType: input.agentType,
    description: input.description,
    sessionName: input.sessionName,
    startedAt: input.startedAt,
    piDir: input.piDir,
    dir: input.artifactsDir,
    cwd: input.cwd,
    conversationId: input.conversationId,
    status: "running",
    background: true,
    comparisonGroupId: input.comparisonGroupId,
    comparisonModel: input.comparisonModel,
    comparisonDescription: input.comparisonDescription,
    comparisonIndex: input.comparisonIndex,
  });
  } catch {
    // A durable-write failure at launch must not prevent the task from
    // starting; the lifecycle handlers below keep their own guards.
  }

  // Promise.resolve().then defers input.run() so a synchronous throw is
  // routed through the failure path instead of escaping this function.
  void Promise.resolve()
    .then(() => input.run())
    .then((result) => {
      const assessment = assessTaskResult(parseResultXml(result.output));
      try {
        upsertTaskSessionHistory(input.piDir, {
          id: input.id,
          agentType: input.agentType,
          description: input.description,
          sessionName: input.sessionName,
          startedAt: input.startedAt,
          piDir: input.piDir,
          dir: input.artifactsDir,
          cwd: input.cwd,
          conversationId: input.conversationId,
          sessionRef: result.sessionPath ?? undefined,
          status: "done",
          reportedStatus: assessment.reportedStatus,
          rawStatus: assessment.rawStatus,
          resultValid: assessment.valid,
          completedAt: now(),
          background: true,
          comparisonGroupId: input.comparisonGroupId,
          comparisonModel: input.comparisonModel,
          comparisonDescription: input.comparisonDescription,
          comparisonIndex: input.comparisonIndex,
        });
      } catch {
        // A durable-write failure must not convert a completed task into a
        // failed one; the completion callback still runs.
      }
      try {
        input.onComplete?.(result);
      } catch {
        // Parent notification failure must not rewrite a completed task as failed.
      }
    })
    .catch((error: unknown) => {
      try {
        upsertTaskSessionHistory(input.piDir, {
          id: input.id,
          agentType: input.agentType,
          description: input.description,
          sessionName: input.sessionName,
          startedAt: input.startedAt,
          piDir: input.piDir,
          dir: input.artifactsDir,
          cwd: input.cwd,
          conversationId: input.conversationId,
          status: "failed",
          completedAt: now(),
          background: true,
          comparisonGroupId: input.comparisonGroupId,
          comparisonModel: input.comparisonModel,
          comparisonDescription: input.comparisonDescription,
          comparisonIndex: input.comparisonIndex,
        });
      } catch {
        // Best-effort durable record of the failure.
      }
      try {
        input.onFailed?.(error);
      } catch {
        // Notification failure does not change the durable task failure.
      }
    })
    .finally(() => {
      try {
        input.onSettled?.();
      } catch {
        // Settled callbacks must never reject the lifecycle chain.
      }
    })
    .catch(() => {
      // Terminal guard: no unhandled rejections from the task lifecycle.
    });
}

export function formatSdkBackgroundReceipt(id: string): string {
  return [
    `Task ${id} is running in the background.`,
    "OpenPi will keep the task alive while the app-side Pi process is alive and will surface its sub-session when it finishes.",
  ].join("\n");
}
