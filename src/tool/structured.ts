import { Type } from "typebox";

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
  return Type.Object({
    // Lifecycle and identity.
    phase: Type.Optional(
      Type.String({ description: "Lifecycle phase: running | done | failed" }),
    ),
    execution_phase: Type.Optional(
      Type.String({ description: "Compare settlement: done | partial" }),
    ),
    task_id: Type.Optional(
      Type.String({
        description: "Durable id; pass it back as task_id to resume or inspect",
      }),
    ),
    task_ids: Type.Optional(
      Type.Array(Type.String(), { description: "Both sibling ids in compare mode" }),
    ),
    conversation_id: Type.Optional(
      Type.String({ description: "Durable conversation key, when the task belongs to one" }),
    ),
    session_id: Type.Optional(
      Type.String({ description: "Child Pi session id for ACP-linked tasks" }),
    ),
    pi_tool_call_id: Type.Optional(
      Type.String({ description: "Parent tool call the child session is linked to" }),
    ),
    // Outcome.
    status: Type.Optional(
      Type.String({
        description: "Normalized status: running | done | cancelled | aborted | failed | timeout",
      }),
    ),
    reported_status: Type.Optional(Type.String()),
    raw_status: Type.Optional(
      Type.String({ description: "The child's literal status word before normalization" }),
    ),
    result_valid: Type.Optional(Type.Boolean()),
    result: Type.Optional(
      Type.String({ description: "The child's full report text" }),
    ),
    background: Type.Optional(
      Type.Boolean({
        description: "true = async receipt, result delivered later; false = sync result",
      }),
    ),
    compare: Type.Optional(
      Type.Boolean({ description: "Result describes a two-model comparison" }),
    ),
    models: Type.Optional(
      Type.Array(Type.String(), { description: "The two compared models, sibling order" }),
    ),
    // Report sections, parsed from the child's structured report.
    summary: Type.Optional(Type.String()),
    findings: Type.Optional(Type.String()),
    evidence: Type.Optional(Type.String()),
    files: Type.Optional(Type.String()),
    caveats: Type.Optional(Type.String()),
    next_steps: Type.Optional(Type.String()),
    full_output: Type.Optional(
      Type.String({
        description: "Full unparsed child output when the report sections are absent",
      }),
    ),
    structured_result: Type.Optional(
      Type.Union(
        [Type.Boolean(), Type.Object({})],
        {
          description:
            "Whether the report parsed as structured; the object form carries status details",
        },
      ),
    ),
    // Cost and timing.
    tool_uses: Type.Optional(Type.Number()),
    turn_count: Type.Optional(Type.Number()),
    duration_ms: Type.Optional(Type.Number()),
    // Launch context and failure diagnostics.
    agent_type: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
    backend: Type.Optional(
      Type.String({ description: "Execution backend that ran the task" }),
    ),
    runtime: Type.Optional(
      Type.String({ description: "pi | claude" }),
    ),
    operation: Type.Optional(Type.String()),
    error: Type.Optional(
      Type.String({ description: "Stable failure code" }),
    ),
    reason: Type.Optional(
      Type.String({ description: "Human-readable failure detail" }),
    ),
    file: Type.Optional(
      Type.String({ description: "Durable file that could not be read" }),
    ),
  });
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
