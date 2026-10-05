import type { TaskReportedStatus, ToolCallRecord } from "./helpers.js";
import type {
  ExecutionBackendKind,
  TerminalHandle,
} from "./subagent/terminalBackend.js";
import type { PiThinkingLevel } from "./thinking.js";
export type { TerminalHandle, HerdrTerminalHandle } from "./subagent/terminalBackend.js";

export type ExecutionBackend = ExecutionBackendKind;

/** One native Pi built-in routed within the child editor, never to the parent session. */
export interface ChildBuiltinCommand {
  name: string;
  argument: string;
  rawText: string;
}

export interface ChildModelOption {
  provider: string;
  id: string;
  name: string;
}

/** Structured, child-owned data used by the transcript view's native selectors. */
export type ChildBuiltinSelectorData =
  | {
      kind: "model";
      models: ChildModelOption[];
      currentModel?: { provider: string; id: string };
    }
  | {
      kind: "thinking";
      currentLevel: PiThinkingLevel;
      levels: PiThinkingLevel[];
    };

export interface ChildHistoryOption {
  taskId: string;
  agentType: string;
  description: string;
  sessionName: string;
  status: string;
  cwd?: string;
  startedAt: number;
  completedAt?: number;
}

export interface ChildHistoryPickerData {
  sessions: ChildHistoryOption[];
  currentTaskId: string;
}

export interface ChildSessionInfo {
  sessionId?: string;
  sessionName?: string;
  storagePath?: string;
  model?: string;
  thinkingLevel?: string;
  cwd?: string;
  counts?: {
    scope: "session" | "current context";
    userMessages: number;
    assistantMessages: number;
    toolCalls: number;
    toolResults: number;
    totalMessages: number;
  };
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost?: number;
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
}

export interface ChildBuiltinCommandResult {
  message: string;
  level: "info" | "warning" | "error";
  /** Present only for a no-argument child /model or /thinking selector request. */
  selector?: ChildBuiltinSelectorData;
  /** Sourced child-owned data for read-only /session, never inferred from the parent. */
  sessionInfo?: ChildSessionInfo;
  /** Durable task-attributed history only; selecting it browses, never resumes execution. */
  historyPicker?: ChildHistoryPickerData;
}

export type ChildBuiltinCommandBackend = "durable" | "sdk" | "terminal" | "none";

/** A completion callback may suppress delivery when its owning conversation is no longer active. */
export type CompletionDeliveryOutcome = "suppressed";

export interface BackgroundTask {
  /** Session artifact root used for completion polling. */
  dir: string;
  /** Directory in which the child Pi process runs. */
  cwd?: string;
  agentType: string;
  sessionName: string;
  /** Child runtime; undefined/"pi" = pi CLI, "claude" = Claude Code CLI. */
  runtime?: "pi" | "claude";
  /** Claude Code transcript path (runtime "claude"); transient/cached —
   * rebuilt from `cwd + claudeSessionId` after restart. */
  claudeSessionFile?: string;
  /** Durable Claude Code session UUID (runtime "claude"); the transcript is
   * `<id>.jsonl` under the cwd's Claude projects dir. */
  claudeSessionId?: string;
  /** Legacy tmux field retained while old in-memory callers are migrated. */
  paneId?: string;
  handle?: TerminalHandle;
  exitSentinelPath?: string;
  backend?: ExecutionBackend;
  /** Process-local abort latch for an active durable runner; never persisted. */
  durableAbortController?: AbortController;
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
  /** Durable parent session used to restore delivery checks. */
  ownerSessionId?: string;
  /** Durable parent conversation leaf used to restore delivery checks. */
  ownerLeafId?: string | null;
  /** Most recent tool calls (capped), updated every COUNT_POLL_MS. */
  recentCalls: ToolCallRecord[];
  /** SDK child live session JSONL; captured when the session opens. The
   * transcript view reads this exact file so streaming tracks the real
   * session instead of the artifacts dir or the recentCalls fallback. */
  sessionPath?: string;
  /** SDK child steering: queues `text` into the live child session
   * (process-local, never persisted). Returns an error message or null. */
  sdkSteer?: (text: string) => string | null | Promise<string | null>;
  /** Child-session Pi controls; process-local and removed when the SDK run settles. */
  sdkCommand?: (
    command: ChildBuiltinCommand,
  ) => ChildBuiltinCommandResult | Promise<ChildBuiltinCommandResult>;
  status?: "running" | "done" | "cancelled" | "aborted" | "failed" | "timeout";
  phase?: string;
  result?: string;
  completedAt?: number;
  /** Identity of the fresh start; recorded on the durable registry entry. */
  intentHash?: string;
  comparisonGroupId?: string;
  comparisonModel?: string;
  comparisonDescription?: string;
  comparisonIndex?: 0 | 1;
  comparisonDelivered?: boolean;
  comparisonPartialDelivered?: boolean;
}

/** Serializable subset for active task registry persistence. */
export interface RegistryEntry {
  id: string;
  agentType: string;
  description: string;
  sessionName: string;
  /** Child runtime; undefined/"pi" = pi CLI, "claude" = Claude Code CLI. */
  runtime?: "pi" | "claude";
  /** Durable Claude Code session UUID (runtime "claude"); the transcript is
   * `<id>.jsonl` under the cwd's Claude projects dir. */
  claudeSessionId?: string;
  startedAt: number;
  handle?: TerminalHandle;
  /** Legacy persisted field accepted by migration only. */
  paneId?: string;
  backend?: ExecutionBackend;
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
  /** Conversation leaf that spawned the task; null means branch checks are disabled. */
  ownerLeafId?: string | null;
  /** OS pid of the owning Pi process; a dead pid lets others recover the task. */
  ownerPid?: number;
  /**
   * Identity of the fresh start that created this task (replay safety): a
   * re-invocation of the same delegation finds this entry and is answered
   * with it instead of spawning a twin. Absent on resumes, comparisons, and
   * legacy entries.
   */
  intentHash?: string;
  /** Terminal cleanup must be retried before this record is removed. */
  cleanupPending?: boolean;
  cleanupPhase?: "done" | "cancelled" | "timeout" | "failed";
  /** Durable comparison metadata used to rebuild sibling aggregation after restart. */
  comparisonGroupId?: string;
  comparisonModel?: string;
  comparisonDescription?: string;
  comparisonIndex?: 0 | 1;
  comparisonDelivered?: boolean;
  comparisonPartialDelivered?: boolean;
}

/** Durable task→session mapping used for resume after task completion. */
export interface TaskSessionHistoryEntry extends RegistryEntry {
  status: "running" | "done" | "cancelled" | "aborted" | "failed" | "timeout";
  reportedStatus?: TaskReportedStatus;
  /** The child's literal status word before normalization ("stalled", ...). */
  rawStatus?: string;
  resultValid?: boolean;
  /** Exact durable submission identity written before child admission. */
  durableRequestId?: string;
  completedAt?: number;
  background: boolean;
}

/** Resolve the child runtime of a persisted record (default: pi). */
export function taskRuntime(
  record: Pick<BackgroundTask, "runtime">,
): "pi" | "claude" {
  return record.runtime ?? "pi";
}
