/**
 * Codemode scripts resolve a nested call to `structuredContent` instead of the
 * text content once the tool declares an `outputSchema` — including error
 * results that carry one (pi's codemode `toScriptValue`). The task tool's data
 * already lives on `details`, so the wrapper mirrors `details` into
 * `structuredContent` at the single `execute` funnel instead of touching every
 * return site.
 *
 * These tests pin the wrapper's contract: data flows, model-facing text and
 * flags are untouched, arguments pass through, and the declared schema accepts
 * the receipt, report, failure, and comparison shapes `execute` actually builds.
 */

import { strict as assert } from "node:assert";
import test from "node:test";

import { Compile } from "typebox/compile";

import taskExtension from "../src/index.js";
import {
  taskResultOutputSchema,
  withTaskStructuredContent,
} from "../src/tool/structured.js";

// Delegated pi-task children disable recursive registration; this test exercises host
// registration, so the env flag must not leak in (same dance as test/prompt.test.ts).
const inheritedTaskToolDisabled = process.env.PI_TASK_TOOL_DISABLED;
delete process.env.PI_TASK_TOOL_DISABLED;
process.on("exit", () => {
  if (inheritedTaskToolDisabled === undefined) delete process.env.PI_TASK_TOOL_DISABLED;
  else process.env.PI_TASK_TOOL_DISABLED = inheritedTaskToolDisabled;
});

interface ToolResult {
  content: { type: "text"; text: string }[];
  details?: Record<string, unknown>;
  isError?: boolean;
  structuredContent?: unknown;
}

const receipt: ToolResult = {
  content: [{ type: "text", text: "Background task t1 started." }],
  details: {
    phase: "running",
    task_id: "t1",
    background: true,
    agent_type: "explore",
    description: "Map the module",
    backend: "herdr",
  },
};

const report: ToolResult = {
  content: [{ type: "text", text: "done" }],
  details: {
    phase: "done",
    task_id: "t1",
    background: false,
    status: "done",
    result_valid: true,
    result: "the full child report",
    summary: "one line",
    findings: "what changed",
    tool_uses: 12,
    turn_count: 3,
    duration_ms: 45_000,
    structured_result: true,
  },
};

const failure: ToolResult = {
  content: [{ type: "text", text: "Invalid task request: no agent_type." }],
  details: { phase: "failed", error: "invalid_task_request", reason: "no agent_type" },
  isError: true,
};

const comparison: ToolResult = {
  content: [{ type: "text", text: "compare settled" }],
  details: {
    compare: true,
    phase: "done",
    execution_phase: "partial",
    models: ["m/a", "m/b"],
    task_ids: ["t1", "t2"],
  },
};

test("structuredContent mirrors details so scripts receive data", async () => {
  const execute = withTaskStructuredContent(async () => receipt);
  const result = await execute();
  assert.deepEqual(result.structuredContent, receipt.details);
  // The model keeps its text; nothing else on the result moves.
  assert.deepEqual(result.content, receipt.content);
  assert.equal(result.isError, undefined);
});

test("error results still carry structured data for scripts", async () => {
  const execute = withTaskStructuredContent(async () => failure);
  const result = await execute();
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, failure.details);
});

test("results without details stay text-only", async () => {
  const bare: ToolResult = { content: [{ type: "text", text: "ok" }] };
  const execute = withTaskStructuredContent(async () => bare);
  const result = await execute();
  assert.equal(result.structuredContent, undefined);
});

test("an existing structuredContent is never overwritten", async () => {
  const custom: ToolResult = {
    content: [{ type: "text", text: "ok" }],
    details: { phase: "done" },
    structuredContent: { custom: true },
  };
  const execute = withTaskStructuredContent(async () => custom);
  const result = await execute();
  assert.deepEqual(result.structuredContent, { custom: true });
});

test("the wrapper forwards every execute argument", async () => {
  const seen: unknown[][] = [];
  const execute = withTaskStructuredContent(async (...args: unknown[]) => {
    seen.push(args);
    return report;
  });
  const signal = new AbortController().signal;
  const onUpdate = () => {};
  const ctx = { cwd: "/tmp" };
  await execute("call-1", { agent_type: "explore" }, signal, onUpdate, ctx);
  assert.deepEqual(seen, [["call-1", { agent_type: "explore" }, signal, onUpdate, ctx]]);
});

test("the declared schema accepts the shapes execute builds", () => {
  const validator = Compile(taskResultOutputSchema());
  for (const shape of [receipt, report, failure, comparison]) {
    assert.equal(
      validator.Check(shape.details),
      true,
      JSON.stringify(shape.details),
    );
  }
});

test("registration wires annotations, outputSchema, and structuredContent", async () => {
  // The real registration: annotations and outputSchema must reach pi, and a
  // real execute result must carry structuredContent mirrored from details.
  const t = "registration wiring";

  let tool:
    | {
        annotations?: Record<string, unknown>;
        outputSchema?: unknown;
        execute: (
          ...args: unknown[]
        ) => Promise<{ details?: Record<string, unknown>; structuredContent?: unknown; isError?: boolean }>;
      }
    | undefined;
  let shutdown: (() => void) | undefined;
  const pi = {
    on(event: string, handler: () => void) {
      if (event === "session_shutdown") shutdown = handler;
    },
    registerMessageRenderer() {},
    registerFlag() {},
    getFlag() {
      return undefined;
    },
    registerTool(value: typeof tool) {
      tool = value;
    },
    registerCommand() {},
    getAllTools() {
      return [];
    },
  };
  taskExtension(pi as never);
  assert.ok(tool, t + " registration");
  assert.deepEqual(
    tool.annotations,
    { readOnlyHint: false, openWorldHint: true },
    t + " annotations",
  );
  assert.ok(tool.outputSchema, t + " outputSchema");

  const result = await tool.execute(
    "structured-contract",
    {
      agent_type: "explore",
      prompt: "Inspect only",
      description: "Inspect cwd",
      cwd: "relative/worktree",
      background: false,
    },
    undefined,
    undefined,
    { cwd: process.cwd() },
  );
  shutdown?.();
  assert.equal(result.isError, true, t + " rejected");
  assert.ok(result.details, t + " details");
  assert.deepEqual(result.structuredContent, result.details, t + " mirror");
});
