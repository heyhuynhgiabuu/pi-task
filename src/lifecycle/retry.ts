/**
 * Per-task retry policy for terminal background tasks.
 *
 * A retry is a deliberate fresh run: same task id, same prompt, same agent
 * config, same backend; a new child start time, a new pane, and the original
 * intent hash kept as-is (deduping an identical delegation against a live
 * retrying task is the correct outcome, so the hash is intentionally not
 * recomputed).
 *
 * Only provider/transient failures are retried. A task that failed on its own
 * fault (tool error, aborted run, pane exit without a report, turn limit) keeps
 * its terminal outcome; the classification reuses the model-failover policy so
 * both features agree on what a provider failure is.
 *
 * Out of scope by construction: comparison siblings (`comparisonGroupId`),
 * foreground tasks, and SDK/durable runs — none of them carry a
 * `BackgroundTask.relaunch` closure, and the gate below requires one.
 */

import { readRegistry, updateRegistry } from "../conversation.js";
import { classifyModelFailover, errorMessageOf } from "../model-failover.js";
import type { BackgroundTask, RegistryEntry } from "../types.js";

/** Retry phases: an ordinary failure or the wall-clock ceiling. */
export type RetryablePhase = "failed" | "timeout";

export const RETRY_BASE_DELAY_MS = 1_000;
export const RETRY_MAX_DELAY_MS = 60_000;
/** `2 ** attempt` is capped before the ms clamp so a corrupt counter cannot overflow. */
const RETRY_MAX_EXPONENT = 16;

export interface TaskRetryPlan {
  /** 0-based index of the retry being scheduled. */
  attempt: number;
  /** Backoff before the relaunch. */
  delayMs: number;
  /** Why the failed attempt was considered retryable. */
  reason: string;
}

/**
 * Exponential backoff for retry `attempt` (0-based): 1s, 2s, 4s, ... capped at
 * {@link RETRY_MAX_DELAY_MS}.
 */
export function retryBackoffMs(attempt: number): number {
  const step = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  return Math.min(
    RETRY_BASE_DELAY_MS * 2 ** Math.min(step, RETRY_MAX_EXPONENT),
    RETRY_MAX_DELAY_MS,
  );
}

/** Network/transport wording that always describes a transient condition. */
const TRANSIENT_NETWORK_RE =
  /\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ESOCKETTIMEDOUT)\b|socket hang up|network error|fetch failed|connection (?:reset|refused|closed|error)|temporary failure in name resolution|bad gateway|gateway time-?out|service unavailable|internal server error|upstream (?:error|timeout|connect)/i;

/** HTTP statuses worth another attempt: rate limiting and server faults. */
const TRANSIENT_STATUS_RE = /\b(?:429|5\d\d)\b/;

/**
 * A transient provider/transport failure the retry policy accepts even when the
 * model-failover matrix would not call it a model error (a 5xx is a provider
 * fault, not a model choice). Returns the reason, or undefined.
 */
export function transientFailureReason(content: string): string | undefined {
  const message = content.trim();
  if (!message) return undefined;
  if (TRANSIENT_STATUS_RE.test(message)) return "transient_status";
  if (TRANSIENT_NETWORK_RE.test(message)) return "transient_network";
  return undefined;
}

export interface TaskRetryInput {
  phase: "done" | "cancelled" | "timeout" | "failed";
  /** The settled content/message, i.e. what the child or the poller reported. */
  content: string;
  maxRetries: number | undefined;
  retryCount: number | undefined;
  comparisonGroupId?: string;
  /** Only a background terminal tracker carries a relaunch closure. */
  canRelaunch: boolean;
  /** The tracker is already waiting for a scheduled relaunch. */
  alreadyPending?: boolean;
  /** The caller knows the settlement is local and must not be retried. */
  suppressed?: boolean;
}

/**
 * The retry to schedule for a settled task, or undefined when the outcome is
 * terminal. Pure: the caller records the attempt and schedules the relaunch.
 */
export function planTaskRetry(input: TaskRetryInput): TaskRetryPlan | undefined {
  if (input.suppressed || input.alreadyPending) return undefined;
  if (input.phase !== "failed" && input.phase !== "timeout") return undefined;
  // Comparison siblings settle as a group and are never retried individually.
  if (input.comparisonGroupId !== undefined) return undefined;
  if (!input.canRelaunch) return undefined;
  const maxRetries = input.maxRetries;
  if (maxRetries === undefined || !Number.isFinite(maxRetries) || maxRetries <= 0) {
    return undefined;
  }
  const attempt = Number.isFinite(input.retryCount) ? Math.max(0, Math.floor(input.retryCount!)) : 0;
  if (attempt >= maxRetries) return undefined;

  const transient = transientFailureReason(input.content);
  if (transient) {
    return { attempt, delayMs: retryBackoffMs(attempt), reason: transient };
  }
  const verdict = classifyModelFailover({ message: input.content });
  if (verdict.fallback) {
    return {
      attempt,
      delayMs: retryBackoffMs(attempt),
      reason: `model_failover:${verdict.reason ?? "provider"}`,
    };
  }
  // The wall-clock ceiling is the one local condition worth another run: the
  // child stalled instead of reporting a provider error. Every other local
  // cause (turn limit, abort, pane exit) is the caller's to suppress and the
  // classification above keeps it terminal.
  if (input.phase === "timeout") {
    return { attempt, delayMs: retryBackoffMs(attempt), reason: "wall_clock_timeout" };
  }
  return undefined;
}

export interface RetryAttemptRecord {
  /** Total retries attempted so far, counting this one. */
  retryCount: number;
  /** Epoch ms at which the relaunch is due. */
  nextRetryAt: number;
  lastRetryReason: string;
}

/**
 * Field-level merge of a retry attempt into the CURRENT registry entry (never a
 * whole-entry overwrite from an earlier read), mirroring `persistTurnBudget`.
 * A task without a registry entry is left alone and reported as not recorded;
 * the in-memory tracker still carries the count, so the retry proceeds.
 * May throw on an unreadable/unwritable registry: the caller decides.
 */
export function recordRetryAttempt(
  piDir: string,
  id: string,
  record: RetryAttemptRecord,
): boolean {
  if (!readRegistry(piDir).some((entry) => entry.id === id)) return false;
  updateRegistry(piDir, (entries) => {
    const index = entries.findIndex((entry) => entry.id === id);
    if (index === -1) return entries;
    const next: RegistryEntry = {
      ...entries[index]!,
      retryCount: record.retryCount,
      nextRetryAt: record.nextRetryAt,
      lastRetryReason: record.lastRetryReason,
    };
    entries[index] = next;
    return entries;
  });
  return true;
}

/** The retry bookkeeping a tracker carries, taken from a persisted entry. */
export function restoredRetryState(
  entry: Pick<RegistryEntry, "maxRetries" | "retryCount" | "timeoutMs" | "timeoutMinutes">,
): Pick<BackgroundTask, "timeoutMinutes" | "timeoutMs" | "maxRetries" | "retryCount"> {
  return {
    ...(typeof entry.timeoutMinutes === "number" && entry.timeoutMinutes > 0
      ? { timeoutMinutes: entry.timeoutMinutes }
      : {}),
    ...(typeof entry.timeoutMs === "number" && entry.timeoutMs > 0
      ? { timeoutMs: entry.timeoutMs }
      : {}),
    ...(typeof entry.maxRetries === "number" && entry.maxRetries > 0
      ? { maxRetries: entry.maxRetries }
      : {}),
    ...(typeof entry.retryCount === "number" && entry.retryCount > 0
      ? { retryCount: entry.retryCount }
      : {}),
  };
}

/** Human wording for a relaunch that threw, so the terminal notice is actionable. */
export function retryRelaunchFailureMessage(attempt: number, error: unknown): string {
  return `Task retry ${attempt + 1} could not be relaunched: ${errorMessageOf(error)}`;
}
