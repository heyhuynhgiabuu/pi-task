import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findJsonlSessionByName, readRegistry, upsertTaskSessionHistory, writeRegistry } from "../conversation.js";
import { parseResultXml } from "../helpers.js";
import { killAgentPane } from "../subagent/tmux.js";
import type { BackgroundTask } from "../types.js";

export function completeTask(
  pi: ExtensionAPI,
  id: string,
  task: BackgroundTask,
  content: string,
  phase: "done" | "timeout" | "failed",
  piDir: string,
): void {
  // Kill the tmux pane if still alive.
  if (task.paneId) killAgentPane(task.paneId, task.originalPane);

  const parsed = parseResultXml(content);
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
    piDir,
    dir: task.dir,
    conversationId: task.conversationId,
    sessionRef: completedSessionRef,
    status: phase,
    completedAt: Date.now(),
    background: true,
  });

  pi.sendMessage(
    {
      customType: "task-complete",
      content: `Background task ${id} (${task.agentType}) ${phase}.\n\nResult:\n${content}`,
      display: true,
      details: {
        task_id: id,
        agent_type: task.agentType,
        description: task.description,
        phase,
        status: phase,
        result: content,
        summary: parsed.summary,
        findings: parsed.findings,
        confidence: parsed.confidence,
        duration_ms: durationMs,
        tool_uses: task.toolUses,
        turn_count: task.turns,
      },
    },
    {
      triggerTurn: true,
      deliverAs: "followUp",
    },
  );

  const entries = readRegistry(piDir).filter((entry) => entry.id !== id);
  writeRegistry(piDir, entries);
}
