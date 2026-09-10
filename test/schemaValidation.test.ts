/**
 * The schema is the handoff contract, so this checks it against the validator
 * Pi actually runs.
 *
 * Pi validates tool arguments before `execute`: `getValidator` compiles
 * `parameters` with typebox's `Compile`, `validator.Check(args)` must pass, and
 * a failure throws with the offending path. `formatValidationPath` names the
 * missing property for a `required` failure. Reproducing that pair here means a
 * change to the schema is measured against the real enforcement, not against
 * the intent behind it.
 */

import { strict as assert } from "node:assert";
import test from "node:test";

import { Compile } from "typebox/compile";

import { taskParametersSchema } from "../src/tool/schema.js";

interface ValidationError {
	keyword?: string;
	instancePath?: string;
	params?: { requiredProperties?: string[] };
	message?: string;
}

const validator = Compile(taskParametersSchema());

/**
 * The property paths a validation error is about.
 *
 * A `required` failure reports every missing property in one error, so it is
 * expanded here into one path per property. Pi's own formatValidationPath names
 * only the first, which is fine for a single missing field but hides the rest.
 */
function errorPaths(error: ValidationError): string[] {
	if (error.keyword === "required") {
		const base = String(error.instancePath ?? "").replace(/^\//, "").replace(/\//g, ".");
		return (error.params?.requiredProperties ?? []).map((property) => (base ? `${base}.${property}` : property));
	}
	return [String(error.instancePath ?? "").replace(/^\//, "")];
}

function validate(args: Record<string, unknown>): { accepted: boolean; errors: string[] } {
	if (validator.Check(args)) return { accepted: true, errors: [] };
	return { accepted: false, errors: validator.Errors(args).flatMap(errorPaths) };
}

test("the handoff fields are required by the schema Pi enforces", () => {
	const t = "required handoff fields";

	assert.equal(validate({ agent_type: "explore", description: "Map repo", prompt: "Map it." }).accepted, true, t);

	for (const [label, args] of [
		["agent_type", { description: "Map repo", prompt: "Map it." }],
		["description", { agent_type: "explore", prompt: "Map it." }],
		["prompt", { agent_type: "explore", description: "Map repo" }],
	] as const) {
		const result = validate(args);
		assert.equal(result.accepted, false, `${t}: ${label} is required`);
		assert.ok(
			result.errors.some((path) => path === label),
			`${t}: the error names ${label} (got ${result.errors.join(", ")})`,
		);
	}

	// An empty object reports all three, so the caller is not left guessing.
	const empty = validate({});
	assert.equal(empty.accepted, false, t + ": an empty request is rejected");
	assert.deepEqual(empty.errors.slice().sort(), ["agent_type", "description", "prompt"], t + ": every missing field is named");
});

test("a stale control payload cannot pass the schema as a start request", () => {
	// `operation` is no longer a property. A control call that still carries it
	// fails on the required fields, and one that also carries them is rejected
	// by parseTaskStartRequest, which is the layer that still knows the field.
	const bare = validate({ operation: "status", task_id: "task-1" });
	assert.equal(bare.accepted, false, "a control-only payload is not a start request");
	assert.deepEqual(bare.errors.slice().sort(), ["agent_type", "description", "prompt"]);
});

test("optional fields accept their documented shapes and reject others", () => {
	const base = { agent_type: "reviewer", description: "Review", prompt: "Review the diff." };

	assert.equal(validate(base).accepted, true, "optional fields may be omitted");
	assert.equal(
		validate({ ...base, parent_context: "The parent read the diff.", proposed_changes: ["No design changes"] }).accepted,
		true,
		"a reviewer handoff passes",
	);
	assert.equal(
		validate({ ...base, task_id: "task-1", conversation_id: "architecture" }).accepted,
		true,
		"both resume references are accepted",
	);
	assert.equal(validate({ ...base, background: true }).accepted, true, "background is a boolean");
	assert.equal(validate({ ...base, background: "yes" }).accepted, false, "a non-boolean background is rejected");
	assert.equal(validate({ ...base, prompt: 42 }).accepted, false, "a non-string prompt is rejected");
});
