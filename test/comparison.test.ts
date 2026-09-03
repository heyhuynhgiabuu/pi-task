import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  markComparisonGroupDelivered,
  readTaskSessionHistory,
  upsertTaskSessionHistory,
} from "../src/conversation.js";
import {
  ComparisonCoordinator,
  persistComparisonTaskHistory,
  type ComparisonHistoryUpdate,
} from "../src/comparison.js";
import type { ComparisonRunResult } from "../src/helpers.js";
import { restoreComparisonGroups } from "../src/index.js";
import type { BackgroundTask } from "../src/types.js";

test("ComparisonCoordinator registers groups and tracks comparison tasks", () => {
  const coordinator = new ComparisonCoordinator();
  coordinator.registerGroup(
    "group-1",
    "base-1",
    "reviewer",
    "Review auth code",
    ["task-1-m0", "task-1-m1"],
    ["openai/gpt-4o", "anthropic/claude-3-5-sonnet"],
  );

  assert.equal(coordinator.isComparisonTask("task-1-m0"), true);
  assert.equal(coordinator.isComparisonTask("task-1-m1"), true);
  assert.equal(coordinator.isComparisonTask("unrelated-task"), false);
});

test("ComparisonCoordinator waits for both sibling tasks before delivering report", () => {
  const coordinator = new ComparisonCoordinator();
  coordinator.registerGroup(
    "group-1",
    "base-1",
    "reviewer",
    "Review auth code",
    ["task-1-m0", "task-1-m1"],
    ["openai/gpt-4o", "anthropic/claude-3-5-sonnet"],
  );

  const sentMessages: any[] = [];
  const sentOptions: any[] = [];
  const fakePi: any = {
    sendMessage: (msg: any, options: any) => {
      sentMessages.push(msg);
      sentOptions.push(options);
    },
  };

  const runA: ComparisonRunResult = {
    model: "openai/gpt-4o",
    taskId: "task-1-m0",
    status: "success",
    rawStatus: "done",
    summary: "Auth looks solid",
    findings: "No vulnerabilities found",
    evidence: "Inspected src/auth.ts",
    files: "src/auth.ts",
    caveats: "",
    nextSteps: "",
    toolUses: 4,
    durationMs: 2500,
  };

  // First task settles
  const handledA = coordinator.recordTaskSettled("task-1-m0", runA, fakePi);
  assert.equal(handledA, true);
  assert.equal(sentMessages.length, 0, "No message sent when only 1 task settled");

  const runB: ComparisonRunResult = {
    model: "anthropic/claude-3-5-sonnet",
    taskId: "task-1-m1",
    status: "success",
    rawStatus: "done",
    summary: "Found potential token leak",
    findings: "Token logged to console in error handler",
    evidence: "Line 55: console.error(token)",
    files: "src/auth.ts",
    caveats: "",
    nextSteps: "Remove log",
    toolUses: 3,
    durationMs: 1800,
  };

  // Second task settles
  const handledB = coordinator.recordTaskSettled("task-1-m1", runB, fakePi);
  assert.equal(handledB, true);
  assert.equal(sentMessages.length, 1, "Message sent when both tasks settled");

  const sent = sentMessages[0];
  assert.equal(sent.customType, "task-complete");
  assert.ok(sent.content.includes("Model Comparison: reviewer"));
  assert.ok(sent.content.includes("openai/gpt-4o"));
  assert.ok(sent.content.includes("anthropic/claude-3-5-sonnet"));
  assert.equal(sent.details.compare, true);
  assert.deepEqual(sent.details.models, ["openai/gpt-4o", "anthropic/claude-3-5-sonnet"]);
  assert.ok(sentOptions[0]?.deliverAs, "delivery options passed as second arg to sendMessage");
  assert.equal(sentOptions[0]?.triggerTurn, true, "triggerTurn preserved in delivery options");

  // Group cleaned up
  assert.equal(coordinator.isComparisonTask("task-1-m0"), false);
  assert.equal(coordinator.isComparisonTask("task-1-m1"), false);
});

test("restores a grouped report when one sibling is only in history", () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-comparison-restore-history-"));
  const taskDirA = join(piDir, "artifacts", "sessions", "task-m0");
  const taskDirB = join(piDir, "artifacts", "sessions", "task-m1");
  mkdirSync(taskDirA, { recursive: true });
  mkdirSync(taskDirB, { recursive: true });
  const sessionPath = join(taskDirA, "session.jsonl");
  const timestamp = new Date().toISOString();
  writeFileSync(
    sessionPath,
    [
      { type: "session_info", timestamp, name: "task-m0" },
      {
        type: "message",
        timestamp,
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "<status>success</status>\n<summary>history result</summary>" }],
        },
      },
    ].map((entry) => JSON.stringify(entry)).join("\n"),
  );

  upsertTaskSessionHistory(piDir, {
    id: "task-m0",
    agentType: "reviewer",
    description: "Review [model-a]",
    sessionName: "task-m0",
    startedAt: Date.now() - 1000,
    handle: { backend: "tmux", resourceId: "%closed" },
    piDir,
    dir: join(piDir, "artifacts"),
    status: "done",
    sessionRef: sessionPath,
    completedAt: Date.now(),
    background: true,
    comparisonGroupId: "compare-group",
    comparisonModel: "model-a",
    comparisonDescription: "Review",
    comparisonIndex: 0,
  });
  upsertTaskSessionHistory(piDir, {
    id: "task-m1",
    agentType: "reviewer",
    description: "Review [model-b]",
    sessionName: "task-m1",
    startedAt: Date.now() - 1000,
    handle: { backend: "tmux", resourceId: "%live" },
    piDir,
    dir: join(piDir, "artifacts"),
    status: "running",
    background: true,
    comparisonGroupId: "compare-group",
    comparisonModel: "model-b",
    comparisonDescription: "Review",
    comparisonIndex: 1,
  });

  const liveTask: BackgroundTask = {
    dir: join(piDir, "artifacts"),
    cwd: "/tmp/project",
    agentType: "reviewer",
    sessionName: "task-m1",
    backend: "tmux",
    paneId: "%live",
    originalPane: null,
    description: "Review [model-b]",
    startedAt: Date.now() - 1000,
    toolUses: 0,
    turns: 0,
    recentCalls: [],
    comparisonGroupId: "compare-group",
    comparisonModel: "model-b",
    comparisonDescription: "Review",
    comparisonIndex: 1,
  };
  const active = new Map([["task-m1", liveTask]]);
  const coordinator = new ComparisonCoordinator();
  const restoredRuns = restoreComparisonGroups(piDir, active, coordinator);
  assert.equal(restoredRuns.length, 1);
  assert.equal(restoredRuns[0]?.status, "success");
  assert.equal(restoredRuns[0]?.summary, "history result");
  assert.equal(restoredRuns[0]?.sessionPath, sessionPath);
  assert.equal(coordinator.isComparisonTask("task-m0"), true);
  assert.equal(coordinator.isComparisonTask("task-m1"), true);

  const sentMessages: any[] = [];
  const fakePi: any = { sendMessage: (message: any) => sentMessages.push(message) };
  coordinator.recordTaskSettled("task-m0", restoredRuns[0]!, fakePi);
  coordinator.recordTaskSettled("task-m1", {
    model: "model-b",
    taskId: "task-m1",
    status: "success",
    rawStatus: "done",
    summary: "live result",
    findings: "",
    evidence: "",
    files: "",
    caveats: "",
    nextSteps: "",
    toolUses: 1,
    durationMs: 100,
  }, fakePi, true, (taskIds) => markComparisonGroupDelivered(piDir, taskIds));
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0]?.content ?? "", /Model Comparison: reviewer/);
  assert.equal(readTaskSessionHistory(piDir).every((entry) => entry.comparisonDelivered), true);
});

test("foreground comparison history keeps execution status separate from reported status", () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-comparison-history-"));
  const write = persistComparisonTaskHistory;
  const base: ComparisonHistoryUpdate = {
    id: "task-m0",
    task: {
      dir: join(piDir, "artifacts"),
      cwd: "/tmp/project",
      agentType: "reviewer",
      sessionName: "task-m0",
      backend: "sdk",
      originalPane: null,
      description: "Review [model-a]",
      startedAt: 100,
      toolUses: 0,
      turns: 0,
      recentCalls: [],
      comparisonGroupId: "compare-group",
      comparisonModel: "model-a",
      comparisonDescription: "Review",
      comparisonIndex: 0,
    },
    status: "running",
    background: false,
  };

  write(piDir, base);
  write(piDir, {
    ...base,
    status: "done",
    reportedStatus: "partial",
    rawStatus: "partial",
    resultValid: true,
    completedAt: 200,
  });

  const entry = readTaskSessionHistory(piDir)[0];
  assert.equal(entry?.status, "done");
  assert.equal(entry?.reportedStatus, "partial");
  assert.equal(entry?.resultValid, true);
  assert.equal(entry?.comparisonModel, "model-a");
  assert.equal(entry?.comparisonIndex, 0);
});

test("ComparisonCoordinator handles failures gracefully", () => {
  const coordinator = new ComparisonCoordinator();
  coordinator.registerGroup(
    "group-2",
    "base-2",
    "explore",
    "Explore repo",
    ["task-2-m0", "task-2-m1"],
    ["model-a", "model-b"],
  );

  const sentMessages: any[] = [];
  const fakePi: any = {
    sendMessage: (msg: any) => sentMessages.push(msg),
  };

  const runA: ComparisonRunResult = {
    model: "model-a",
    taskId: "task-2-m0",
    status: "failure",
    rawStatus: "failed",
    summary: "Process crashed",
    findings: "",
    evidence: "",
    files: "",
    caveats: "",
    nextSteps: "",
    toolUses: 1,
    durationMs: 500,
    error: "Connection refused",
  };

  const runB: ComparisonRunResult = {
    model: "model-b",
    taskId: "task-2-m1",
    status: "success",
    rawStatus: "done",
    summary: "Mapped 10 files",
    findings: "Architecture is modular",
    evidence: "Found src/index.ts",
    files: "src/index.ts",
    caveats: "",
    nextSteps: "",
    toolUses: 5,
    durationMs: 3000,
  };

  coordinator.recordTaskSettled("task-2-m0", runA, fakePi);
  assert.equal(sentMessages.length, 0);

  coordinator.recordTaskSettled("task-2-m1", runB, fakePi);
  assert.equal(sentMessages.length, 1);

  assert.ok(sentMessages[0].content.includes("Connection refused"));
  assert.ok(sentMessages[0].content.includes("Mapped 10 files"));
});

test("ComparisonCoordinator respects deliveryGuard when delivery is refused", () => {
  const coordinator = new ComparisonCoordinator();
  coordinator.registerGroup(
    "group-3",
    "base-3",
    "explore",
    "Explore repo",
    ["task-3-m0", "task-3-m1"],
    ["model-a", "model-b"],
  );

  const sentMessages: any[] = [];
  const fakePi: any = {
    sendMessage: (msg: any) => sentMessages.push(msg),
  };

  const runA: ComparisonRunResult = {
    model: "model-a",
    taskId: "task-3-m0",
    status: "success",
    rawStatus: "done",
    summary: "Finished A",
    findings: "",
    evidence: "",
    files: "",
    caveats: "",
    nextSteps: "",
    toolUses: 1,
    durationMs: 500,
  };
  const runB: ComparisonRunResult = {
    model: "model-b",
    taskId: "task-3-m1",
    status: "success",
    rawStatus: "done",
    summary: "Finished B",
    findings: "",
    evidence: "",
    files: "",
    caveats: "",
    nextSteps: "",
    toolUses: 1,
    durationMs: 500,
  };

  coordinator.recordTaskSettled("task-3-m0", runA, fakePi, false);
  coordinator.recordTaskSettled("task-3-m1", runB, fakePi, false);

  assert.equal(sentMessages.length, 0, "No message delivered when deliveryGuard returns false");
  // But group is still cleaned up
  assert.equal(coordinator.isComparisonTask("task-3-m0"), false);
  assert.equal(coordinator.isComparisonTask("task-3-m1"), false);
});

