import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  enrichSubagentFailureMessage,
  enrichSubagentFailureMessageAsync,
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

  it("uses asynchronous tmux diagnostics without blocking on sync probes", async () => {
    const calls: string[][] = [];
    const result = await enrichSubagentFailureMessageAsync(
      {
        kind: "pane_exit",
        baseMessage: "Subagent pane exited without producing a result.",
        paneId: "%pane-async",
      },
      async (args) => {
        calls.push([...args]);
        if (args[0] === "display-message" && args.at(-1) === "#{pane_id}") {
          return "%pane-async";
        }
        if (args[0] === "display-message" && args.at(-1) === "#{pane_dead}") {
          return "1";
        }
        if (args[0] === "capture-pane") return "async pane failure";
        throw new Error(`unexpected tmux command: ${args.join(" ")}`);
      },
    );

    assert.match(result, /Tmux pane %pane-async: dead/);
    assert.match(result, /async pane failure/);
    assert.deepEqual(calls.map((args) => args[0]), [
      "display-message",
      "display-message",
      "capture-pane",
    ]);
  });
});
