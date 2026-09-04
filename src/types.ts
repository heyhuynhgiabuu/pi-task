import type { TaskReportedStatus, ToolCallRecord } from "./helpers.js";
import type { TerminalHandle, TerminalBackendKind } from "./subagent/terminalBackend.js";
export type { TerminalHandle, HerdrTerminalHandle } from "./subagent/terminalBackend.js";

export type ExecutionBackend = "sdk" | TerminalBackendKind;

export interface BackgroundTask {
  /** Session artifact root used for completion polling. */
  dir: string;
  /** Directory in which the child Pi process runs. */
  cwd?: string;
  agentType: string;
  sessionName: string;
  /** Legacy tmux field retained while old in-memory callers are migrated. */
  paneId?: string;
  handle?: TerminalHandle;
  exitSentinelPath?: string;
  backend?: ExecutionBackend;
  originalPane: string | null;
  description: string;
  startedAt: number;
  toolUses: number;
  turns: number;
  /** Soft turn limit (issue #19); undefined = unlimited. */
  maxTurns?: number;
  /**
   * Wrap-up phase (issue #19): anchored at the turn count observed when the
   * limit was reached; the polling loop closes the task after
   * WRAP_UP_GRACE_TURNS further completed turns.
   */
  wrapUp?: { turnsAtStart: number };
  conversationId?: string;
  /** Most recent tool calls (capped), updated every COUNT_POLL_MS. */
  recentCalls: ToolCallRecord[];
  /** Consecutive completion-poll failures; reset to 0 on a successful poll. */
  pollErrors?: number;
  status?: "running" | "done" | "cancelled" | "aborted" | "failed" | "timeout";
  phase?: string;
  result?: string;
  completedAt?: number;
  comparisonGroupId?: string;
  comparisonModel?: string;
  comparisonDescription?: string;
  comparisonIndex?: 0 | 1;
  comparisonDelivered?: boolean;
}

/** Serializable subset for active task registry persistence. */
export interface RegistryEntry {
  id: string;
  agentType: string;
  description: string;
  sessionName: string;
  startedAt: number;
  handle?: TerminalHandle;
  /** Legacy persisted field accepted by migration only. */
  paneId?: string;
  backend?: TerminalBackendKind;
  piDir: string;
  /** Session artifact root, distinct from the child working directory. */
  dir: string;
  cwd?: string;
  conversationId?: string;
  sessionRef?: string;
  /** Soft turn limit persisted so restore keeps enforcing it (issue #19). */
  maxTurns?: number;
  /**
   * Pi session that owns this task's lifecycle (issue #20): only it may
   * restore, steer, time out, deliver, or remove the entry. Undefined on
   * legacy entries and entries spawned before a session context existed.
   */
  ownerSessionId?: string;
  /** OS pid of the owning Pi process; a dead pid lets others recover the task. */
  ownerPid?: number;
  /** Terminal cleanup must be retried before this record is removed. */
  cleanupPending?: boolean;
  cleanupPhase?: "done" | "cancelled" | "timeout" | "failed";
  /** Durable comparison metadata used to rebuild sibling aggregation after restart. */
  comparisonGroupId?: string;
  comparisonModel?: string;
  comparisonDescription?: string;
  comparisonIndex?: 0 | 1;
  comparisonDelivered?: boolean;
}

/** Durable task→session mapping used for resume after task completion. */
export interface TaskSessionHistoryEntry extends RegistryEntry {
  status: "running" | "done" | "cancelled" | "aborted" | "failed" | "timeout";
  reportedStatus?: TaskReportedStatus;
  /** The child's literal status word before normalization ("stalled", ...). */
  rawStatus?: string;
  resultValid?: boolean;
  completedAt?: number;
  background: boolean;
}
