/**
 * Prompt budget for the model-facing `task` surface.
 *
 * The `task` tool is paid on every turn, so this prints what each part costs
 * and the total. Run with `npm run cost` before and after a change to a tool
 * description, an agent description, or the parameter schema.
 *
 * It calls the same `buildTaskToolDescription` and `discoverAgents` the
 * extension uses, so the numbers follow the real surface rather than a copy.
 * Characters/4 is the estimate used throughout; it tracks the tokenizer
 * closely enough for budgeting and needs no model dependency.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildTaskToolDescription, discoverAgents, TASK_TOOL_DESCRIPTION } from "../src/helpers.js";
import { taskParametersSchema } from "../src/tool/schema.js";

const bundledAgentDir = join(dirname(fileURLToPath(import.meta.url)), "..", "agents");
const tokens = (text: string): number => Math.round(text.length / 4);

const { agents } = discoverAgents(process.cwd(), bundledAgentDir);
const description = buildTaskToolDescription(agents);
const roster = description.slice(TASK_TOOL_DESCRIPTION.length);
const schema = JSON.stringify(taskParametersSchema(), null, 2);

const rows: Array<[string, string]> = [
	["tool description (prose)", TASK_TOOL_DESCRIPTION],
	["agent roster", roster],
	["parameter schema", schema],
];

let total = 0;
for (const [label, text] of rows) {
	const cost = tokens(text);
	total += cost;
	console.log(`${label.padEnd(26)} ${String(text.length).padStart(6)} chars  ~${String(cost).padStart(5)} tok`);
}
console.log(`${"TOTAL".padEnd(26)} ${"".padStart(6)}         ~${String(total).padStart(5)} tok`);
console.log();

const parameterCosts = Object.entries(taskParametersSchema().properties)
	.map(([name, value]) => [name, tokens((value as { description?: string }).description ?? "")] as const)
	.sort((a, b) => b[1] - a[1]);
console.log("per-parameter description cost:");
for (const [name, cost] of parameterCosts) {
	console.log(`  ${name.padEnd(18)} ~${String(cost).padStart(4)} tok`);
}
