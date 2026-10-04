/**
 * Phase derivation behind the animated working indicators. Phases must come
 * from real activity only: an in-flight streamed partial (durable live
 * projection) or a tool that is still running. Snapshot transcripts hold
 * committed messages, so they never claim thinking/streaming.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { taskActivity } from "../src/task-activity.js";
import type { TranscriptItem } from "../src/panel/transcript.js";

function tool(name: string, inProgress: boolean): TranscriptItem {
  return {
    type: "tool",
    name,
    toolCallId: "call-1",
    args: {},
    inProgress,
    timestamp: "",
  };
}

test("task activity reports a running tool from live items and from session calls", () => {
  assert.deepEqual(
    taskActivity({ items: [tool("websearch", true)], status: "running" }),
    { phase: "tool", label: "Running websearch…" },
  );
  assert.deepEqual(
    taskActivity({
      recentCalls: [{ id: "c1", name: "grep", detail: "pattern", status: "in_progress" }],
      status: "running",
    }),
    { phase: "tool", label: "Running grep…" },
  );
});

test("task activity only claims thinking/streaming for an in-flight partial", () => {
  const thinking: TranscriptItem = {
    type: "assistant",
    text: "",
    thinking: "weighing options",
    streaming: true,
    timestamp: "",
  };
  assert.deepEqual(taskActivity({ items: [thinking], status: "running" }), {
    phase: "thinking",
    label: "Thinking…",
  });
  assert.deepEqual(
    taskActivity({
      items: [{ ...thinking, text: "I will read the file", thinking: undefined }],
      status: "running",
    }),
    { phase: "streaming", label: "Streaming…" },
  );

  // A committed assistant message read from a session snapshot is not streaming.
  assert.deepEqual(
    taskActivity({
      items: [{ type: "assistant", text: "Finished the step", timestamp: "" }],
      status: "running",
    }),
    { phase: "running", label: "Running…" },
  );
});

test("task activity falls back to running and stops once the task settles", () => {
  assert.deepEqual(taskActivity({ status: "running" }), { phase: "running", label: "Running…" });
  assert.deepEqual(taskActivity({ items: [tool("read", false)], status: "running" }), {
    phase: "running",
    label: "Running…",
  });
  for (const status of ["done", "failed", "cancelled", "aborted", "timeout"]) {
    assert.equal(
      taskActivity({ items: [tool("read", true)], status }),
      undefined,
      `${status} tasks must not keep an indicator moving`,
    );
  }
});
