import assert from "node:assert/strict";
import test from "node:test";
import { armableTimeoutMs, getFinalAssistantResult } from "../src/subagent/runSdk.js";

test("accepts the final successful assistant message", () => {
  const result = getFinalAssistantResult([
    { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "stale" }] },
    { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "current" }] },
  ]);
  assert.deepEqual(result, { output: "current" });
});

test("classifies provider errors without reusing earlier assistant text", () => {
  const result = getFinalAssistantResult([
    { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "stale" }] },
    { role: "assistant", stopReason: "error", errorMessage: "rate limit", content: [] },
  ]);
  assert.deepEqual(result, { error: "rate limit" });
});

test("classifies aborted SDK runs", () => {
  const result = getFinalAssistantResult([
    { role: "assistant", stopReason: "aborted", content: [] },
  ]);
  assert.deepEqual(result, { error: "SDK subagent was aborted." });
});

test("rejects a terminal assistant message with no usable output", () => {
  const result = getFinalAssistantResult([
    { role: "assistant", stopReason: "stop", content: [] },
  ]);
  assert.deepEqual(result, { error: "SDK subagent completed without assistant text." });
});

test("does not treat an intermediate tool-use message as a result", () => {
  const result = getFinalAssistantResult([
    { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "partial" }] },
  ]);
  assert.deepEqual(result, { error: "SDK subagent has not reached a terminal result." });
});

test("arms the run timer for a finite timeout", () => {
  assert.equal(armableTimeoutMs(1_000), 1_000);
  assert.equal(armableTimeoutMs(0), 0);
});

test("never arms the run timer for a disabled or non-finite timeout", () => {
  assert.equal(armableTimeoutMs(undefined), undefined);
  assert.equal(armableTimeoutMs(Number.POSITIVE_INFINITY), undefined);
  assert.equal(armableTimeoutMs(Number.NEGATIVE_INFINITY), undefined);
  assert.equal(armableTimeoutMs(Number.NaN), undefined);
});

test("clamps a timeout past the setTimeout range instead of overflowing to 1ms", () => {
  assert.equal(armableTimeoutMs(Number.MAX_SAFE_INTEGER), 2_147_483_647);
});
