import type { ToolCallRecord } from "./helpers.js";

export interface BackgroundTask {
  dir: string;
  agentType: string;
  sessionName: string;
  paneId?: string;
  originalPane: string | null;
  description: string;
  startedAt: number;
  toolUses: number;
  turns: number;
  conversationId?: string;
  /** Most recent tool calls (capped), updated every COUNT_POLL_MS. */
  recentCalls: ToolCallRecord[];
  /** Consecutive completion-poll failures; reset to 0 on a successful poll. */
  pollErrors?: number;
}

/** Serializable subset for active task registry persistence. */
export interface RegistryEntry {
  id: string;
  agentType: string;
  description: string;
  sessionName: string;
  startedAt: number;
  paneId?: string;
  piDir: string;
  dir: string;
  conversationId?: string;
  sessionRef?: string;
}

/** Durable task→session mapping used for resume after task completion. */
export interface TaskSessionHistoryEntry extends RegistryEntry {
  status: "running" | "done" | "cancelled" | "aborted" | "failed" | "timeout";
  completedAt?: number;
  background: boolean;
}

/** Details attached to tool result for rendering. */
export interface TaskDetails {
  task_id: string;
  agent_type: string;
  description: string;
  conversation_id?: string;
  phase: "done" | "timeout" | "aborted" | "failed";
  status?: string;
  summary?: string;
  findings?: string;
  evidence?: string;
  confidence?: string;
  duration_ms?: number;
  turn_count?: number;
  tool_uses?: number;
  background?: boolean;
  tmux_session?: string;
}
