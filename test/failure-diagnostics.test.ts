import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  enrichSubagentFailureMessage,
  sessionDirForTask,
} from "../src/subagent/failure-diagnostics.js";

describe("failure diagnostics", () => {
  it("builds task-scoped session paths", () => {
    assert.equal(
      sessionDirForTask("/tmp/artifacts", "task-123"),
      join("/tmp/artifacts", "sessions", "task-123"),
    );
  });

  it("includes session location and recovery hint when no JSONL exists", () => {
    const result = enrichSubagentFailureMessage({
      kind: "pane_exit",
      baseMessage: "Subagent pane exited without producing a result.",
      artifactsDir: "/tmp/artifacts",
      taskId: "task-99",
      elapsedMs: 12_000,
    });

    assert.match(result, /Subagent pane exited/);
    assert.match(result, /Session dir:/);
    assert.match(result, /sessions[\\/]task-99/);
    assert.match(result, /Session JSONL: missing/);
    assert.match(result, /PI_TASK_CHILD_NO_EXTENSIONS/);
  });
});
