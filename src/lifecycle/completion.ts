import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  findJsonlSessionByName,
  readRegistry,
  upsertTaskSessionHistory,
  writeRegistry,
} from "../conversation.js";
import { assessTaskResult, parseResultXml } from "../helpers.js";
import { createSyncHerdrControl } from "../subagent/herdr.js";
import { killAgentPaneStrict } from "../subagent/tmux.js";
import { ignoreStaleExtensionCtx } from "../stale-ctx.js";
import type { BackgroundTask, RegistryEntry } from "../types.js";

function closeTaskResource(task: BackgroundTask): void {
  if (task.handle?.backend === "herdr") {
    if (
      task.handle.foregroundProcessGroupId === undefined
    ) {
      throw new Error("HerdR cleanup requires persisted agent identity");
    }
    createSyncHerdrControl().close(task.handle);
  } else if (task.paneId) {
    killAgentPaneStrict(task.paneId, task.originalPane);
  }
}

export function completeTask(
  pi: ExtensionAPI,
  id: string,
  task: BackgroundTask,
  content: string,
  phase: "done" | "cancelled" | "timeout" | "failed",
  piDir: string,
  resourceCloser: (task: BackgroundTask) => void = closeTaskResource,
): { cleanupSucceeded: boolean } {
  const parsed = parseResultXml(content);
  const assessment = assessTaskResult(parsed);
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
    handle: task.handle,
    piDir,
    dir: task.dir,
    cwd: task.cwd,
    conversationId: task.conversationId,
    sessionRef: completedSessionRef,
    status: phase,
    reportedStatus: assessment.reportedStatus,
    resultValid: assessment.valid,
    completedAt: Date.now(),
    background: true,
  });

  const entries = readRegistry(piDir).filter((entry) => entry.id !== id);
  const cleanupEntry: RegistryEntry = {
    id,
    agentType: task.agentType,
    description: task.description,
    sessionName: task.sessionName,
    startedAt: task.startedAt,
    handle: task.handle,
    paneId: task.paneId,
    piDir,
    dir: task.dir,
    cwd: task.cwd,
    conversationId: task.conversationId,
    sessionRef: completedSessionRef,
    cleanupPending: true,
    cleanupPhase: phase,
  };
  // Keep a terminal cleanup receipt durable across a crash between the
  // state write and backend close. Restore retries it and removes it only
  // after close succeeds.
  writeRegistry(piDir, [...entries, cleanupEntry]);

  let cleanupSucceeded = true;
  try {
    resourceCloser(task);
  } catch {
    cleanupSucceeded = false;
  }
  if (cleanupSucceeded) writeRegistry(piDir, entries);

  const summaryText = parsed.summary?.trim()
    ? parsed.summary.trim()
    : content.replace(/\s+/g, " ").trim().slice(0, 240);

  ignoreStaleExtensionCtx(() =>
    pi.sendMessage(
      {
        customType: "task-complete",
        content: `Background task ${id} (${task.agentType}) ${phase}.\n\n${summaryText}`,
        display: true,
        details: {
          task_id: id,
          agent_type: task.agentType,
          description: task.description,
          phase,
          execution_phase: phase,
          status: assessment.reportedStatus,
          reported_status: assessment.reportedStatus,
          result_valid: assessment.valid,
          result: content,
          summary: parsed.summary,
          findings: parsed.findings,
          evidence: parsed.evidence,
          files: parsed.files,
          caveats: parsed.caveats,
          next_steps: parsed.next_steps,
          confidence: parsed.confidence,
          duration_ms: durationMs,
          tool_uses: task.toolUses,
          turn_count: task.turns,
          background: true,
          structured_result: assessment.valid,
          full_output: parsed.raw.trim() || content.trim(),
        },
      },
      {
        triggerTurn: true,
        deliverAs: "followUp",
      },
    ),
  );

  return { cleanupSucceeded };
}