import { arr, bool, map, num, obj, opt, str, union } from "@earendil-works/pi-schema";

/** One `pi.usage` bucket of a durable child conversation, as `details.usage` reports it. */
const durableUsageTotals = obj({
  inputTokens: num(),
  outputTokens: num(),
  totalTokens: num(),
  costTotal: num({ description: "Provider-computed cost; 0 when unknown" }),
}, { open: true });

/**
 * The JSON contract codemode scripts receive instead of the text content once
 * the task tool declares an `outputSchema` (pi's codemode resolves nested calls
 * to `structuredContent`, also for error results that carry one).
 *
 * `execute` already builds everything a caller needs onto `details` — start
 * receipt, report sections, and failure diagnostics — so the schema names those
 * fields and lets the rest flow through: every property is optional and
 * additional ones are allowed.
 */
export function taskResultOutputSchema() {
  // `open` keeps the additional-properties-permitting object the TypeBox schema
  // this replaced emitted: `details` carries more than the fields named here.
  return obj({
    // Lifecycle and identity.
    phase: opt(
      str({ description: "Lifecycle phase: running | done | failed" }),
    ),
    execution_phase: opt(
      str({ description: "Compare settlement: done | partial" }),
    ),
    task_id: opt(
      str({
        description: "Durable id; pass it back as task_id to resume or inspect",
      }),
    ),
    task_ids: opt(
      arr(str(), { description: "Both sibling ids in compare mode" }),
    ),
    conversation_id: opt(
      str({ description: "Durable conversation key, when the task belongs to one" }),
    ),
    session_id: opt(
      str({ description: "Child Pi session id for ACP-linked tasks" }),
    ),
    pi_tool_call_id: opt(
      str({ description: "Parent tool call the child session is linked to" }),
    ),
    // Outcome.
    status: opt(
      str({
        description: "Normalized status: running | done | cancelled | aborted | failed | timeout",
      }),
    ),
    reported_status: opt(str()),
    raw_status: opt(
      str({ description: "The child's literal status word before normalization" }),
    ),
    result_valid: opt(bool()),
    result: opt(
      str({ description: "The child's full report text" }),
    ),
    background: opt(
      bool({
        description: "true = async receipt, result delivered later; false = sync result",
      }),
    ),
    compare: opt(
      bool({ description: "Result describes a two-model comparison" }),
    ),
    models: opt(
      arr(str(), { description: "The two compared models, sibling order" }),
    ),
    // Report sections, parsed from the child's structured report.
    summary: opt(str()),
    findings: opt(str()),
    evidence: opt(str()),
    files: opt(str()),
    caveats: opt(str()),
    next_steps: opt(str()),
    full_output: opt(
      str({
        description: "Full unparsed child output when the report sections are absent",
      }),
    ),
    structured_result: opt(
      union(
        [bool(), obj({}, { open: true })],
        {
          description:
            "Whether the report parsed as structured; the object form carries status details",
        },
      ),
    ),
    // Cost and timing.
    tool_uses: opt(num()),
    turn_count: opt(num()),
    duration_ms: opt(num()),
    // Launch context and failure diagnostics.
    agent_type: opt(str()),
    description: opt(str()),
    backend: opt(
      str({ description: "Execution backend that ran the task" }),
    ),
    runtime: opt(
      str({ description: "pi | claude" }),
    ),
    operation: opt(str()),
    error: opt(
      str({ description: "Stable failure code" }),
    ),
    reason: opt(
      str({ description: "Human-readable failure detail" }),
    ),
    file: opt(
      str({ description: "Durable file that could not be read" }),
    ),
    // Spend of the child conversation. Durable backend only: the other backends
    // report none, so the field is absent rather than zeroed.
    usage: opt(
      obj({
        models: map(durableUsageTotals),
        tools: map(durableUsageTotals),
        totals: durableUsageTotals,
      }, { open: true }),
    ),
  }, { open: true });
}

/** A result that carries task data on `details` and may carry a structured twin. */
interface StructuredContentCarrier {
  details?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
}

/**
 * Mirror `details` into `structuredContent` at the execute boundary.
 *
 * The model-facing result is untouched — text, `isError`, and `details` stay
 * exactly as built, so renderers, delivery, and session records keep working;
 * scripts gain a structured view of the same data. A result without `details`
 * (none today) keeps the codemode fallback of plain text, and an explicit
 * `structuredContent` set by the execute body is never overwritten.
 */
export function withTaskStructuredContent<
  Args extends unknown[],
  Result extends StructuredContentCarrier,
>(
  execute: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  return async (...args: Args) => {
    const result = await execute(...args);
    if (result.details !== undefined && result.structuredContent === undefined) {
      return {
        ...result,
        structuredContent: result.details as Result["structuredContent"],
      };
    }
    return result;
  };
}
