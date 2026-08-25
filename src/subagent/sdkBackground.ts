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
  run: () => Promise<SdkBackgroundResult>;
  onComplete?: (result: SdkBackgroundResult) => void;
  onFailed?: (error: unknown) => void;
  onSettled?: () => void;
  now?: () => number;
}

export function startSdkBackgroundTask(input: SdkBackgroundTaskInput): void {
  const now = input.now ?? Date.now;

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
  });

  void input
    .run()
    .then((result) => {
      const assessment = assessTaskResult(parseResultXml(result.output));
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
      });
      try {
        input.onComplete?.(result);
      } catch {
        // Parent notification failure must not rewrite a completed task as failed.
      }
    })
    .catch((error: unknown) => {
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
      });
      try {
        input.onFailed?.(error);
      } catch {
        // Notification failure does not change the durable task failure.
      }
    })
    .finally(() => input.onSettled?.());
}

export function formatSdkBackgroundReceipt(id: string): string {
  return [
    `Task ${id} is running in the background.`,
    "OpenPi will keep the task alive while the app-side Pi process is alive and will surface its sub-session when it finishes.",
  ].join("\n");
}
