import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  markComparisonGroupDelivered,
  markComparisonGroupPartiallyDelivered,
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

test("ComparisonCoordinator delivers a bounded partial report for a straggler", async () => {
  const coordinator = new ComparisonCoordinator({ joinWindowMs: 10 });
  coordinator.registerGroup(
    "group-partial",
    "base-partial",
    "reviewer",
    "Review auth code",
    ["task-partial-a", "task-partial-b"],
    ["model-a", "model-b"],
  );

  const sentMessages: any[] = [];
  const fakePi: any = {
    sendMessage: (message: any) => sentMessages.push(message),
  };
  const runA: ComparisonRunResult = {
    model: "model-a",
    taskId: "task-partial-a",
    status: "success",
    rawStatus: "done",
    summary: "Completed model A",
    findings: "Finding A",
    evidence: "Evidence A",
    files: "src/a.ts",
    caveats: "",
    nextSteps: "",
    toolUses: 1,
    durationMs: 20,
  };

  coordinator.recordTaskSettled("task-partial-a", runA, fakePi);
  await sleep(30);

  assert.equal(sentMessages.length, 1, "the straggler deadline emits one report");
  assert.match(sentMessages[0]?.content ?? "", /model-b/);
  assert.match(sentMessages[0]?.content ?? "", /did not settle/);
  assert.equal(sentMessages[0]?.details.partial, true);

  const lateRun: ComparisonRunResult = {
    ...runA,
    model: "model-b",
    taskId: "task-partial-b",
    summary: "Completed model B late",
  };
  assert.equal(
    coordinator.recordTaskSettled("task-partial-b", lateRun, fakePi),
    true,
    "late sibling completion remains consumed by the comparison group",
  );
  assert.equal(sentMessages.length, 1, "late sibling does not emit a duplicate report");
});

test("ComparisonCoordinator retries a guard-suppressed deadline as a full report when the sibling arrives", async () => {
  const coordinator = new ComparisonCoordinator({ joinWindowMs: 10 });
  coordinator.registerGroup(
    "group-guarded-partial",
    "base-guarded-partial",
    "reviewer",
    "Review auth code",
    ["task-guarded-a", "task-guarded-b"],
    ["model-a", "model-b"],
  );
  const sentMessages: any[] = [];
  const fakePi: any = { sendMessage: (message: any) => sentMessages.push(message) };
  const runA: ComparisonRunResult = {
    model: "model-a",
    taskId: "task-guarded-a",
    status: "success",
    rawStatus: "done",
    summary: "Completed model A",
    findings: "",
    evidence: "",
    files: "",
    caveats: "",
    nextSteps: "",
    toolUses: 1,
    durationMs: 10,
  };
  let partialMarkers = 0;
  coordinator.recordTaskSettled(
    "task-guarded-a",
    runA,
    fakePi,
    true,
    undefined,
    () => false,
    () => { partialMarkers += 1; },
  );
  await sleep(30);
  assert.equal(sentMessages.length, 0, "guarded partial delivery is suppressed");
  assert.equal(partialMarkers, 0, "suppressed delivery is not marked durable");

  coordinator.recordTaskSettled(
    "task-guarded-b",
    {
      ...runA,
      model: "model-b",
      taskId: "task-guarded-b",
      summary: "Completed model B",
    },
    fakePi,
  );
  assert.equal(sentMessages.length, 1, "late sibling still produces one full report");
  assert.equal(sentMessages[0]?.details.partial, false);
});

test("ComparisonCoordinator checks both guards before partial delivery", async () => {
  const coordinator = new ComparisonCoordinator({ joinWindowMs: 10 });
  coordinator.registerGroup(
    "group-guarded-partial-both",
    "base-guarded-partial-both",
    "reviewer",
    "Review auth code",
    ["task-partial-guard-a", "task-partial-guard-b"],
    ["model-a", "model-b"],
  );
  const sentMessages: any[] = [];
  const fakePi: any = { sendMessage: (message: any) => sentMessages.push(message) };
  let checks = 0;
  coordinator.recordTaskSettled(
    "task-partial-guard-a",
    {
      model: "model-a",
      taskId: "task-partial-guard-a",
      status: "success",
      rawStatus: "done",
      summary: "done",
      findings: "",
      evidence: "",
      files: "",
      caveats: "",
      nextSteps: "",
      toolUses: 1,
      durationMs: 1,
    },
    fakePi,
    true,
    undefined,
    () => ++checks < 2,
  );
  await sleep(30);

  assert.equal(sentMessages.length, 0, "one refused sibling blocks partial delivery");
  assert.equal(checks, 2, "both sibling guards are checked for partial delivery");
});

test("partial comparison delivery markers persist and suppress replay", async () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-comparison-partial-marker-"));
  try {
    for (const [id, model, index] of [["marker-a", "model-a", 0], ["marker-b", "model-b", 1]] as const) {
      upsertTaskSessionHistory(piDir, {
        id,
        agentType: "reviewer",
        description: "Partial marker",
        sessionName: id,
        startedAt: 100,
        piDir,
        dir: piDir,
        status: index === 0 ? "done" : "running",
        background: true,
        comparisonGroupId: "marker-group",
        comparisonModel: model,
        comparisonDescription: "Partial marker",
        comparisonIndex: index,
      });
    }

    const coordinator = new ComparisonCoordinator({ joinWindowMs: 10 });
    coordinator.registerGroup(
      "marker-group",
      "marker-group",
      "reviewer",
      "Partial marker",
      ["marker-a", "marker-b"],
      ["model-a", "model-b"],
    );
    coordinator.recordTaskSettled(
      "marker-a",
      {
        model: "model-a",
        taskId: "marker-a",
        status: "success",
        rawStatus: "done",
        summary: "done",
        findings: "",
        evidence: "",
        files: "",
        caveats: "",
        nextSteps: "",
        toolUses: 1,
        durationMs: 1,
      },
      { sendMessage: () => {} } as any,
      true,
      undefined,
      undefined,
      (taskIds) => markComparisonGroupPartiallyDelivered(piDir, taskIds),
    );
    await sleep(30);

    assert.equal(
      readTaskSessionHistory(piDir).every((entry) => entry.comparisonPartialDelivered === true),
      true,
      "partial delivery marker is persisted for both siblings",
    );
    assert.deepEqual(
      restoreComparisonGroups(piDir, new Map(), new ComparisonCoordinator()),
      [],
      "restart replay skips an already delivered partial group",
    );
  } finally {
    rmSync(piDir, { recursive: true, force: true });
  }
});

test("replayed comparison groups persist partial delivery markers", async () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-comparison-replay-partial-"));
  try {
    const sharedHistory = {
      agentType: "reviewer",
      description: "Replay partial",
      piDir,
      dir: piDir,
      background: true,
      comparisonGroupId: "replay-partial-group",
      comparisonDescription: "Replay partial",
    } as const;
    upsertTaskSessionHistory(piDir, {
      ...sharedHistory,
      id: "replay-a",
      sessionName: "replay-a",
      startedAt: 100,
      completedAt: 110,
      status: "done",
      reportedStatus: "success",
      comparisonModel: "model-a",
      comparisonIndex: 0,
    });
    upsertTaskSessionHistory(piDir, {
      ...sharedHistory,
      id: "replay-b",
      sessionName: "replay-b",
      startedAt: 100,
      status: "running",
      comparisonModel: "model-b",
      comparisonIndex: 1,
    });
    const activeSibling: BackgroundTask = {
      dir: piDir,
      cwd: piDir,
      agentType: "reviewer",
      sessionName: "replay-b",
      paneId: "pane-replay-b",
      originalPane: null,
      description: "Replay partial",
      startedAt: 100,
      toolUses: 0,
      turns: 0,
      recentCalls: [],
      comparisonGroupId: "replay-partial-group",
      comparisonModel: "model-b",
      comparisonDescription: "Replay partial",
      comparisonIndex: 1,
    };
    const coordinator = new ComparisonCoordinator({ joinWindowMs: 10 });
    const pendingRuns = restoreComparisonGroups(
      piDir,
      new Map([[activeSibling.sessionName, activeSibling]]),
      coordinator,
    );
    assert.deepEqual(pendingRuns.map((run) => run.taskId), ["replay-a"]);

    const sentMessages: any[] = [];
    coordinator.recordTaskSettled(
      "replay-a",
      pendingRuns[0]!,
      { sendMessage: (message: any) => sentMessages.push(message) } as any,
      true,
      undefined,
      undefined,
      (taskIds) => markComparisonGroupPartiallyDelivered(piDir, taskIds),
    );
    await sleep(30);

    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0]?.details.partial, true);
    assert.equal(
      readTaskSessionHistory(piDir).every((entry) => entry.comparisonPartialDelivered === true),
      true,
    );
  } finally {
    rmSync(piDir, { recursive: true, force: true });
  }
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
      ownerSessionId: "session-a",
      ownerLeafId: "leaf-a",
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
  assert.equal(entry?.ownerSessionId, "session-a");
  assert.equal(entry?.ownerLeafId, "leaf-a");
});

test("restores settled SDK comparison siblings without pane handles", () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-comparison-sdk-restore-"));
  const artifactsDir = join(piDir, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  for (const [id, model, index] of [["sdk-m0", "model-a", 0], ["sdk-m1", "model-b", 1]] as const) {
    upsertTaskSessionHistory(piDir, {
      id,
      agentType: "reviewer",
      description: "SDK compare",
      sessionName: id,
      startedAt: Date.now() - 1000,
      piDir,
      dir: artifactsDir,
      status: "failed",
      background: true,
      comparisonGroupId: "sdk-group",
      comparisonModel: model,
      comparisonDescription: "SDK compare",
      comparisonIndex: index,
    });
  }

  const runs = restoreComparisonGroups(
    piDir,
    new Map(),
    new ComparisonCoordinator(),
    "session-current",
  );
  assert.deepEqual(runs.map((run) => run.model).sort(), ["model-a", "model-b"]);
});

test("comparison history forwards each sibling's own claudeSessionId", () => {
  // issue #22: the durable UUID is the transcript identity. Each sibling's
  // history record must carry its OWN claudeSessionId — reusing one UUID or
  // omitting it would point restore (and any transcript reader) at the wrong
  // or a missing transcript.
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-comparison-claude-"));
  const write = persistComparisonTaskHistory;
  const sibling = (id: string, claudeSessionId: string): ComparisonHistoryUpdate => ({
    id,
    task: {
      dir: join(piDir, "artifacts"),
      cwd: "/tmp/project",
      agentType: "reviewer",
      sessionName: `task-${id}`,
      runtime: "claude",
      claudeSessionId,
      originalPane: null,
      description: "Review",
      startedAt: 100,
      toolUses: 0,
      turns: 0,
      recentCalls: [],
      comparisonGroupId: "claude-group",
      comparisonModel: id === "task-m0" ? "model-a" : "model-b",
      comparisonDescription: "Review",
      comparisonIndex: id === "task-m0" ? 0 : 1,
    },
    status: "done",
    background: true,
    completedAt: 200,
  });

  write(piDir, sibling("task-m0", "d1111111-2222-4333-8444-555555555555"));
  write(piDir, sibling("task-m1", "e1111111-2222-4333-8444-555555555555"));

  const history = readTaskSessionHistory(piDir);
  assert.equal(
    history.find((entry) => entry.id === "task-m0")?.claudeSessionId,
    "d1111111-2222-4333-8444-555555555555",
    "sibling m0 keeps its own UUID",
  );
  assert.equal(
    history.find((entry) => entry.id === "task-m1")?.claudeSessionId,
    "e1111111-2222-4333-8444-555555555555",
    "sibling m1 keeps its own distinct UUID",
  );
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


test("ComparisonCoordinator requires guard permission for both siblings", () => {
  const coordinator = new ComparisonCoordinator();
  coordinator.registerGroup(
    "group-guard-both",
    "base-guard-both",
    "explore",
    "Explore repo",
    ["task-guard-m0", "task-guard-m1"],
    ["model-a", "model-b"],
  );
  const run = (taskId: string, model: string): ComparisonRunResult => ({
    model,
    taskId,
    status: "success",
    rawStatus: "done",
    summary: `Finished ${taskId}`,
    findings: "",
    evidence: "",
    files: "",
    caveats: "",
    nextSteps: "",
    toolUses: 1,
    durationMs: 500,
  });
  const sentMessages: any[] = [];
  const fakePi: any = { sendMessage: (message: any) => sentMessages.push(message) };
  let checks = 0;
  const guardCheck = () => {
    checks += 1;
    return checks !== 2;
  };

  coordinator.recordTaskSettled(
    "task-guard-m0",
    run("task-guard-m0", "model-a"),
    fakePi,
    true,
    undefined,
    guardCheck,
  );
  coordinator.recordTaskSettled(
    "task-guard-m1",
    run("task-guard-m1", "model-b"),
    fakePi,
    true,
    undefined,
    guardCheck,
  );

  assert.equal(sentMessages.length, 0, "one refused sibling blocks the joint report");
  assert.equal(checks, 2, "both sibling guards are checked");
});

test("restoreComparisonGroups defers groups split across owner sessions", () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-comparison-mixed-owner-"));
  const groupId = "mixed-owner-group";
  const timestamp = new Date().toISOString();
  for (const [name, model, index, ownerSessionId] of [
    ["task-m0", "model-a", 0, "sess-a"],
    ["task-m1", "model-b", 1, "sess-b"],
  ] as const) {
    const taskDir = join(piDir, "artifacts", "sessions", name);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(
      join(taskDir, "session.jsonl"),
      [
        { type: "session_info", timestamp, name },
        {
          type: "message",
          timestamp,
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: `<status>success</status>\n<summary>${name} result</summary>` }],
          },
        },
      ].map((entry) => JSON.stringify(entry)).join("\n"),
    );
    upsertTaskSessionHistory(piDir, {
      id: name,
      agentType: "reviewer",
      description: `Review [${model}]`,
      sessionName: name,
      startedAt: Date.now() - 1000,
      handle: { backend: "tmux", resourceId: `%${name}` },
      piDir,
      dir: join(piDir, "artifacts"),
      status: "done",
      sessionRef: join(taskDir, "session.jsonl"),
      completedAt: Date.now(),
      background: true,
      ownerSessionId,
      comparisonGroupId: groupId,
      comparisonModel: model,
      comparisonDescription: "Review",
      comparisonIndex: index,
    });
  }

  const coordinator = new ComparisonCoordinator();
  const diagnostics: unknown[] = [];
  const pending = restoreComparisonGroups(
    piDir,
    new Map(),
    coordinator,
    "sess-a",
    (diagnostic) => diagnostics.push(diagnostic),
  );
  assert.deepEqual(pending, [], "mixed-owner groups are not replayed as partial reports");
  assert.deepEqual(diagnostics, [
    {
      groupId,
      taskIds: ["task-m0", "task-m1"],
      reason: "mixed_owner",
    },
  ], "mixed-owner deferral is observable");
  assert.equal(coordinator.isComparisonTask("task-m0"), false, "mixed group is not registered");
  assert.equal(coordinator.isComparisonTask("task-m1"), false, "mixed group is not registered");
});

test("restoreComparisonGroups defers partially migrated owner metadata", () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-comparison-partial-owner-"));
  const makeTask = (id: string, ownerSessionId?: string): BackgroundTask => ({
    dir: join(piDir, "artifacts"),
    cwd: "/tmp/project",
    agentType: "reviewer",
    sessionName: id,
    backend: "sdk",
    originalPane: null,
    description: "Review",
    startedAt: Date.now() - 1000,
    toolUses: 0,
    turns: 0,
    ownerSessionId,
    comparisonGroupId: "partial-owner-group",
    comparisonModel: id.endsWith("m0") ? "model-a" : "model-b",
    comparisonDescription: "Review",
    comparisonIndex: id.endsWith("m0") ? 0 : 1,
  });
  const coordinator = new ComparisonCoordinator();
  const diagnostics: unknown[] = [];
  const pending = restoreComparisonGroups(
    piDir,
    new Map([
      ["task-m0", makeTask("task-m0", "sess-a")],
      ["task-m1", makeTask("task-m1")],
    ]),
    coordinator,
    "sess-a",
    (diagnostic) => {
      diagnostics.push(diagnostic);
      throw new Error("diagnostic observer failure");
    },
  );

  assert.deepEqual(pending, [], "partially migrated groups are deferred");
  assert.deepEqual(diagnostics, [
    {
      groupId: "partial-owner-group",
      taskIds: ["task-m0", "task-m1"],
      reason: "partial_owner",
    },
  ], "partial-owner deferral is observable");
  assert.equal(coordinator.isComparisonTask("task-m0"), false, "partial group is not registered");
  assert.equal(coordinator.isComparisonTask("task-m1"), false, "partial group is not registered");
});

test("restoreComparisonGroups skips history runs owned by another session", () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-comparison-foreign-owner-"));
  const taskDirA = join(piDir, "artifacts", "sessions", "task-m0");
  const taskDirB = join(piDir, "artifacts", "sessions", "task-m1");
  mkdirSync(taskDirA, { recursive: true });
  mkdirSync(taskDirB, { recursive: true });
  const timestamp = new Date().toISOString();
  for (const [dir, name, model, index] of [
    [taskDirA, "task-m0", "model-a", 0],
    [taskDirB, "task-m1", "model-b", 1],
  ] as const) {
    writeFileSync(
      join(dir, "session.jsonl"),
      [
        { type: "session_info", timestamp, name },
        {
          type: "message",
          timestamp,
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: `<status>success</status>\n<summary>${name} result</summary>` }],
          },
        },
      ].map((entry) => JSON.stringify(entry)).join("\n"),
    );
    upsertTaskSessionHistory(piDir, {
      id: name,
      agentType: "reviewer",
      description: `Review [${model}]`,
      sessionName: name,
      startedAt: Date.now() - 1000,
      handle: { backend: "tmux", resourceId: `%${name}` },
      piDir,
      dir: join(piDir, "artifacts"),
      status: "done",
      sessionRef: join(dir, "session.jsonl"),
      completedAt: Date.now(),
      background: true,
      ownerSessionId: "sess-a",
      comparisonGroupId: "compare-group",
      comparisonModel: model,
      comparisonDescription: "Review",
      comparisonIndex: index as 0 | 1,
    });
  }

  const foreign = restoreComparisonGroups(piDir, new Map(), new ComparisonCoordinator(), "sess-b");
  assert.equal(foreign.length, 0, "a group owned by another session is not replayed");

  const own = restoreComparisonGroups(piDir, new Map(), new ComparisonCoordinator(), "sess-a");
  assert.equal(own.length, 2, "the owning session replays both siblings");
});
