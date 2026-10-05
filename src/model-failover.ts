/**
 * Model failover policy shared by the durable and SDK backends.
 *
 * Failover is deliberately narrow: only a clear provider/model failure may
 * advance to the next model in an agent's frontmatter `models:` list. Tool
 * failures, cancellations, aborts, steering, explicit `/model` changes, and
 * lifecycle anomalies keep their normal error path. The helpers here are pure
 * so both backends classify identically and the policy is unit-testable.
 */

import type { AgentModelSpec } from "./helpers.js";

/** Why an attempt was considered safe to retry on the next model. */
export type ModelFailoverReason =
  | "model_error"
  | "no_model"
  | "provider_status"
  | "quota";

export interface ModelFailureSignal {
  /**
   * Durable submission reason when the harness recorded one
   * (`model_error`, `no_model`, `aborted`, ...). An explicit non-model reason
   * is authoritative: the harness already classified the failure.
   */
  submissionReason?: string;
  /** Provider/harness error text for the failed attempt. */
  message?: string;
}

export interface ModelFailoverVerdict {
  fallback: boolean;
  reason?: ModelFailoverReason;
}

/** Harness verdicts that are model/provider failures eligible for failover. */
const FALLBACK_SUBMISSION_REASONS = new Set(["model_error", "no_model"]);

/** Explicit durable reasons that are never model failures. `faulted`/`failed`
 *  are harness/lifecycle faults (tool crashes etc.); their message text is
 *  arbitrary, so it must not reach the provider-status heuristics. */
const NON_MODEL_SUBMISSION_REASON_RE =
  /^(?:aborted|cancelled|canceled|stale|reset|timeout|timed_out|faulted|failed)$/i;

const ABORT_TEXT_RE = /\b(?:abort(?:ed)?|cancel(?:led|ed)?|interrupted)\b/i;
const TIMEOUT_TEXT_RE = /\btimed?[ _-]?out\b/i;
const HTTP_STATUS_RE = /\b(?:400|401|402|403|404|408|429|5\d\d)\b/;
const QUOTA_TEXT_RE =
  /quota|rate[ _-]?limit|usage[ _-]?limit|too many requests|insufficient[ _-]?(?:quota|credit|balance|funds)|capacity|overloaded|billing|payment required/i;
const MODEL_TEXT_RE =
  /model[ _-]?(?:error|unavailable)|not available in the model registry|no model (?:is )?(?:configured|available)/i;
/** Composed durable failure text embeds the raw submission reason. */
const MODEL_REASON_TEXT_RE = /\bmodel_error\b|\bno_model\b/i;

export function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * The approved fallback matrix. `submissionReason`, when present, is the
 * harness's own verdict and wins over text heuristics; otherwise the message
 * is matched against provider status, quota, and model-unavailable wording.
 */
export function classifyModelFailover(
  signal: ModelFailureSignal,
): ModelFailoverVerdict {
  const submissionReason = signal.submissionReason?.trim().toLowerCase();
  if (submissionReason) {
    if (FALLBACK_SUBMISSION_REASONS.has(submissionReason)) {
      return { fallback: true, reason: submissionReason as ModelFailoverReason };
    }
    if (NON_MODEL_SUBMISSION_REASON_RE.test(submissionReason)) {
      return { fallback: false };
    }
  }

  const message = signal.message?.trim() ?? "";
  if (!message) return { fallback: false };

  // The composed durable failure text carries the submission reason; recover
  // it when a legacy run record predates the structured fields.
  if (!submissionReason && MODEL_REASON_TEXT_RE.test(message)) {
    return {
      fallback: true,
      reason: /\bno_model\b/i.test(message) ? "no_model" : "model_error",
    };
  }

  if (ABORT_TEXT_RE.test(message)) return { fallback: false };
  const providerStatus = HTTP_STATUS_RE.test(message);
  // A local timeout abort is not a provider failure; an explicit 408 is.
  if (!providerStatus && TIMEOUT_TEXT_RE.test(message)) return { fallback: false };
  if (providerStatus) return { fallback: true, reason: "provider_status" };
  if (QUOTA_TEXT_RE.test(message)) return { fallback: true, reason: "quota" };
  if (MODEL_TEXT_RE.test(message)) return { fallback: true, reason: "no_model" };
  return { fallback: false };
}

/**
 * The ordered chain of distinct models to attempt. Strict frontmatter order,
 * each model at most once: blank and duplicate entries are dropped so a chain
 * can never loop on the same model.
 */
export function planModelChain(
  specs: readonly AgentModelSpec[] | undefined,
): AgentModelSpec[] {
  const planned: AgentModelSpec[] = [];
  const seen = new Set<string>();
  for (const spec of specs ?? []) {
    const model = spec.model?.trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    planned.push(
      spec.thinking === undefined ? { model } : { model, thinking: spec.thinking },
    );
  }
  return planned;
}

/**
 * Whether any assistant output (text, thinking, or a tool call) was committed
 * by an attempt. A restart may only retry before this point: retrying after
 * partial output would duplicate work and double-charge the provider.
 */
export function assistantOutputProduced(messages: readonly unknown[]): boolean {
  for (const candidate of messages) {
    if (!candidate || typeof candidate !== "object") continue;
    const message = candidate as { role?: unknown; content?: unknown };
    if (message.role !== "assistant") continue;
    const content = message.content;
    if (typeof content === "string") {
      if (content.trim()) return true;
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (typeof block === "string") {
        if (block.trim()) return true;
        continue;
      }
      if (!block || typeof block !== "object") continue;
      const part = block as { type?: unknown; text?: unknown; thinking?: unknown };
      if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
        return true;
      }
      if (
        part.type === "thinking" &&
        typeof part.thinking === "string" &&
        part.thinking.trim()
      ) {
        return true;
      }
      if (part.type === "toolCall") return true;
    }
  }
  return false;
}

/** Cancellation/timeout markers an SDK attempt must never fail over. */
function isInterruptedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const kind = (error as { kind?: unknown }).kind;
  return kind === "cancelled" || kind === "timeout";
}

/**
 * SDK failover gate: a clean restart seam exists only when the attempt failed
 * with a clear model/provider error before any assistant output, was not a
 * cancellation/timeout, and another model remains in the chain.
 */
export function shouldRetrySdkWithNextModel(input: {
  error: unknown;
  hadAssistantOutput: boolean;
  remaining: number;
  /** The child's model was explicitly changed (for example `/model`). */
  explicitModelChange?: boolean;
}): boolean {
  if (input.remaining <= 0 || input.hadAssistantOutput) return false;
  if (input.explicitModelChange) return false;
  if (isInterruptedError(input.error)) return false;
  return classifyModelFailover({ message: errorMessageOf(input.error) }).fallback;
}

/**
 * Surface the original error after the chain is exhausted, with the attempt
 * trail appended so the provider's own words stay the primary message.
 */
export function failoverExhaustedError(
  original: Error,
  trail: readonly string[],
): Error {
  const attempts = trail.length === 1 ? "attempt" : "attempts";
  const lines = trail.map((entry, index) => `${index + 1}. ${entry}`).join("\n");
  return new Error(
    `${original.message}\n\nModel failover exhausted after ${trail.length} ${attempts}:\n${lines}`,
    { cause: original },
  );
}
