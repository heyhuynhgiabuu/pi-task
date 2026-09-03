import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { restoreActiveBackgroundTasks } from "../src/lifecycle/restore.ts";

function makePiDir() {
  return mkdtempSync(join(tmpdir(), "pi-task-restore-"));
}

function writeJson(file: string, value: unknown) {
  writeFileSync(file, JSON.stringify(value, null, 2));
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function writeSession(dir: string, sessionName: string, stopReason?: string) {
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const content = [
    { type: "session_info", timestamp: now, name: sessionName },
    {
      type: "message",
      timestamp: now,
      message: {
        role: "assistant",
        stopReason,
        content: [{ type: "text", text: "done" }],
      },
    },
  ];
  writeFileSync(join(dir, "session.jsonl"), content.map((entry) => JSON.stringify(entry)).join("\n"));
}

describe("restoreActiveBackgroundTasks", () => {
  it("marks completed registry entries done and removes them from registry", () => {
    const piDir = makePiDir();
    const taskDir = join(piDir, "artifacts", "sessions", "task-1");
    writeSession(taskDir, "task-task-1", "stop");
    writeJson(join(piDir, "task-registry.json"), [
      {
        id: "task-1",
        dir: taskDir,
        sessionName: "task-task-1",
        startedAt: Date.now() - 1000,
        paneId: "%missing",
        agentType: "scout",
        description: "done task",
        background: true,
      },
    ]);
    writeJson(join(piDir, "task-session-history.json"), [
      { id: "task-1", status: "running", startedAt: Date.now() - 1000 },
    ]);

    const backgroundTasks = new Map();
    restoreActiveBackgroundTasks(piDir, backgroundTasks);

    assert.equal(backgroundTasks.size, 0);
    assert.deepEqual(readJson<unknown[]>(join(piDir, "task-registry.json")), []);
    const history = readJson<Array<{ id: string; status: string }>>(
      join(piDir, "task-session-history.json"),
    );
    assert.equal(history[0]?.status, "done");

  });

  it("preserves durable records during a temporary backend outage", () => {
    const piDir = makePiDir();
    const taskDir = join(piDir, "artifacts", "sessions", "task-herdr");
    writeSession(taskDir, "task-task-herdr");
    const entry = {
      id: "task-herdr",
      dir: taskDir,
      sessionName: "task-task-herdr",
      startedAt: Date.now() - 1000,
      paneId: "w1:p2",
      handle: {
        backend: "herdr",
        resourceId: "w1:p2",
        socketPath: "/tmp/herdr.sock",
        terminalId: "term-2",
      },
      agentType: "scout",
      description: "temporarily unreachable",
      background: true,
    };
    writeJson(join(piDir, "task-registry.json"), [entry]);

    const backgroundTasks = new Map();
    restoreActiveBackgroundTasks(piDir, backgroundTasks, () => {
      const error = new Error("connection refused");
      error.name = "HerdrUnavailableError";
      throw error;
    });

    assert.equal(backgroundTasks.size, 0);
    assert.equal(readJson<Array<{ id: string }>>(join(piDir, "task-registry.json"))[0]?.id, "task-herdr");
  });

  it("preserves an isolated child cwd while restoring a live task", () => {
    const piDir = makePiDir();
    const taskDir = join(piDir, "artifacts", "sessions", "task-live");
    const childCwd = join(piDir, "worktrees", "task-live");
    writeSession(taskDir, "task-task-live");
    mkdirSync(childCwd, { recursive: true });
    writeJson(join(piDir, "task-registry.json"), [{
      id: "task-live",
      dir: taskDir,
      cwd: childCwd,
      sessionName: "task-task-live",
      startedAt: Date.now() - 1000,
      paneId: "%live",
      agentType: "general",
      description: "isolated writer",
      background: true,
    }]);

    const backgroundTasks = new Map();
    restoreActiveBackgroundTasks(piDir, backgroundTasks, () => true);

    assert.equal(backgroundTasks.get("task-live")?.cwd, childCwd);
  });

  it("restores comparison metadata on live sibling tasks", () => {
    const piDir = makePiDir();
    const taskDir = join(piDir, "artifacts", "sessions", "task-compare-m0");
    mkdirSync(taskDir, { recursive: true });
    writeJson(join(piDir, "task-registry.json"), [{
      id: "task-compare-m0",
      dir: taskDir,
      sessionName: "task-compare-m0",
      startedAt: Date.now() - 1000,
      paneId: "%compare",
      agentType: "reviewer",
      description: "Review [model-a]",
      comparisonGroupId: "compare-group",
      comparisonModel: "model-a",
      comparisonDescription: "Review",
      comparisonIndex: 0,
    }]);

    const backgroundTasks = new Map();
    restoreActiveBackgroundTasks(piDir, backgroundTasks, () => true);

    const restored = backgroundTasks.get("task-compare-m0") as {
      comparisonGroupId?: string;
      comparisonModel?: string;
      comparisonDescription?: string;
      comparisonIndex?: number;
    } | undefined;
    assert.equal(restored?.comparisonGroupId, "compare-group");
    assert.equal(restored?.comparisonModel, "model-a");
    assert.equal(restored?.comparisonDescription, "Review");
    assert.equal(restored?.comparisonIndex, 0);
  });

  it("persists finished comparison siblings for grouped restore", () => {
    const piDir = makePiDir();
    const taskDirA = join(piDir, "artifacts", "sessions", "task-compare-m0");
    const taskDirB = join(piDir, "artifacts", "sessions", "task-compare-m1");
    writeSession(taskDirA, "task-compare-m0", "stop");
    writeSession(taskDirB, "task-compare-m1");
    writeJson(join(piDir, "task-registry.json"), [
      {
        id: "task-compare-m0",
        dir: taskDirA,
        sessionName: "task-compare-m0",
        startedAt: Date.now() - 1000,
        paneId: "%compare-a",
        agentType: "reviewer",
        description: "Review [model-a]",
        comparisonGroupId: "compare-group",
        comparisonModel: "model-a",
        comparisonDescription: "Review",
        comparisonIndex: 0,
      },
      {
        id: "task-compare-m1",
        dir: taskDirB,
        sessionName: "task-compare-m1",
        startedAt: Date.now() - 1000,
        paneId: "%compare-b",
        agentType: "reviewer",
        description: "Review [model-b]",
        comparisonGroupId: "compare-group",
        comparisonModel: "model-b",
        comparisonDescription: "Review",
        comparisonIndex: 1,
      },
    ]);

    const backgroundTasks = new Map();
    restoreActiveBackgroundTasks(piDir, backgroundTasks, () => false);

    assert.equal(backgroundTasks.size, 1);
    assert.equal(backgroundTasks.has("task-compare-m1"), true);
    assert.equal(readJson<unknown[]>(join(piDir, "task-registry.json")).length, 1);
    const history = readJson<Array<{ id: string; status: string; comparisonModel?: string }>>(
      join(piDir, "task-session-history.json"),
    );
    assert.equal(history.find((entry) => entry.id === "task-compare-m0")?.status, "done");
    assert.equal(history.find((entry) => entry.id === "task-compare-m0")?.comparisonModel, "model-a");
  });

  it("detects a comparison sibling finished during a long outage in the production session layout", () => {
    // Production layout: dir is the artifacts root and the session JSONL lives
    // under dir/sessions/<id>/ — restore must look there, not only at dir.
    const piDir = makePiDir();
    const artifactsDir = join(piDir, "artifacts");
    const taskDirA = join(artifactsDir, "sessions", "task-compare-m0");
    const taskDirB = join(artifactsDir, "sessions", "task-compare-m1");
    writeSession(taskDirA, "task-compare-m0", "stop");
    mkdirSync(taskDirB, { recursive: true });
    writeJson(join(piDir, "task-registry.json"), [
      {
        id: "task-compare-m0",
        dir: artifactsDir,
        sessionName: "task-compare-m0",
        startedAt: Date.now() - 40 * 60 * 1000,
        paneId: "%compare-a",
        agentType: "reviewer",
        description: "Review [model-a]",
        comparisonGroupId: "compare-group",
        comparisonModel: "model-a",
        comparisonDescription: "Review",
        comparisonIndex: 0,
      },
      {
        id: "task-compare-m1",
        dir: artifactsDir,
        sessionName: "task-compare-m1",
        startedAt: Date.now() - 40 * 60 * 1000,
        paneId: "%compare-b",
        agentType: "reviewer",
        description: "Review [model-b]",
        comparisonGroupId: "compare-group",
        comparisonModel: "model-b",
        comparisonDescription: "Review",
        comparisonIndex: 1,
      },
    ]);

    const backgroundTasks = new Map();
    // Sibling A finished while Pi was offline (pane gone); sibling B is live.
    restoreActiveBackgroundTasks(piDir, backgroundTasks, (entry) => entry.id === "task-compare-m1");

    // The finished sibling must be persisted done and dropped from polling,
    // not restored as running where the global timeout would misreport it.
    assert.equal(backgroundTasks.size, 1);
    assert.equal(backgroundTasks.has("task-compare-m1"), true);
    const registry = readJson<Array<{ id: string }>>(join(piDir, "task-registry.json"));
    assert.equal(registry.some((entry) => entry.id === "task-compare-m0"), false);
    const history = readJson<Array<{ id: string; status: string; comparisonModel?: string }>>(
      join(piDir, "task-session-history.json"),
    );
    const finished = history.find((entry) => entry.id === "task-compare-m0");
    assert.equal(finished?.status, "done");
    assert.equal(finished?.comparisonModel, "model-a");
  });

  it("persists restored finished tasks with the session's last message timestamp", () => {
    // A sibling that finished while Pi was offline must record completedAt
    // from its session JSONL, not from restore time — recovered comparison
    // reports otherwise show durations inflated by the outage.
    const piDir = makePiDir();
    const artifactsDir = join(piDir, "artifacts");
    const taskDir = join(artifactsDir, "sessions", "task-finished-ts");
    const startedAt = Date.now() - 31 * 60 * 1000;
    const finishedAt = Date.now() - 30 * 60 * 1000;
    const finishedIso = new Date(finishedAt).toISOString();
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(
      join(taskDir, "session.jsonl"),
      [
        { type: "session_info", timestamp: finishedIso, name: "task-task-finished-ts" },
        {
          type: "message",
          timestamp: finishedIso,
          message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
        },
      ].map((entry) => JSON.stringify(entry)).join("\n"),
    );
    writeJson(join(piDir, "task-registry.json"), [{
      id: "task-finished-ts",
      dir: artifactsDir,
      sessionName: "task-task-finished-ts",
      startedAt,
      paneId: "%gone",
      agentType: "reviewer",
      description: "finished during outage",
      comparisonGroupId: "compare-ts",
      comparisonModel: "model-a",
      comparisonIndex: 0,
    }]);

    restoreActiveBackgroundTasks(piDir, new Map(), () => false);

    const history = readJson<Array<{ id: string; status: string; completedAt?: number }>>(
      join(piDir, "task-session-history.json"),
    );
    const entry = history.find((e) => e.id === "task-finished-ts");
    assert.equal(entry?.status, "done");
    assert.equal(entry?.completedAt, finishedAt);
  });

  it("retains entries and never throws when a durable write fails during restore", () => {
    // A restore-time I/O failure (e.g. history file occupied by a directory)
    // must not abort extension registration or destroy the durable record.
    const piDir = makePiDir();
    const taskDir = join(piDir, "artifacts", "sessions", "task-unwritable");
    writeSession(taskDir, "task-task-unwritable", "stop");
    writeJson(join(piDir, "task-registry.json"), [{
      id: "task-unwritable",
      dir: taskDir,
      sessionName: "task-task-unwritable",
      startedAt: Date.now() - 1000,
      paneId: "%gone",
      agentType: "scout",
      description: "history write will fail",
    }]);
    // Occupy the history file path with a directory: every history write fails.
    mkdirSync(join(piDir, "task-session-history.json"), { recursive: true });

    const backgroundTasks = new Map();
    assert.doesNotThrow(() =>
      restoreActiveBackgroundTasks(piDir, backgroundTasks, () => false),
    );
    // The entry could not be settled durably, so it must be retained.
    const registry = readJson<Array<{ id: string }>>(join(piDir, "task-registry.json"));
    assert.equal(registry.some((entry) => entry.id === "task-unwritable"), true);
  });

  it("marks non-terminal entries failed when their pane is gone", () => {
    const piDir = makePiDir();
    const taskDir = join(piDir, "artifacts", "sessions", "task-2");
    writeSession(taskDir, "task-task-2");
    writeJson(join(piDir, "task-registry.json"), [{
      id: "task-2",
      dir: taskDir,
      sessionName: "task-task-2",
      startedAt: Date.now() - 1000,
      paneId: "%missing",
      agentType: "scout",
      description: "lost task",
      background: true,
    }]);
    writeJson(join(piDir, "task-session-history.json"), [
      { id: "task-2", status: "running", startedAt: Date.now() - 1000 },
    ]);

    const backgroundTasks = new Map();
    restoreActiveBackgroundTasks(piDir, backgroundTasks);

    assert.equal(backgroundTasks.size, 0);
    assert.deepEqual(readJson<unknown[]>(join(piDir, "task-registry.json")), []);
    const history = readJson<Array<{ id: string; status: string }>>(
      join(piDir, "task-session-history.json"),
    );
    assert.equal(history[0]?.status, "failed");
  });

  it("retries terminal cleanup receipts without restoring them as running tasks", () => {
  const piDir = makePiDir();
  const taskDir = join(piDir, "artifacts", "sessions", "task-cleanup");
  mkdirSync(taskDir, { recursive: true });
  writeJson(join(piDir, "task-registry.json"), [{
    id: "task-cleanup",
    dir: taskDir,
    sessionName: "task-task-cleanup",
    startedAt: Date.now() - 1000,
    paneId: "%cleanup",
    agentType: "scout",
    description: "pending cleanup",
    cleanupPending: true,
    cleanupPhase: "cancelled",
  }]);

  let closeCount = 0;
  const backgroundTasks = new Map();
  restoreActiveBackgroundTasks(piDir, backgroundTasks, () => true, () => {
    closeCount += 1;
  });

  assert.equal(closeCount, 1);
  assert.equal(backgroundTasks.size, 0);
  assert.deepEqual(readJson<unknown[]>(join(piDir, "task-registry.json")), []);
});

it("preserves terminal cleanup receipts when retry still fails", () => {
  const piDir = makePiDir();
  const taskDir = join(piDir, "artifacts", "sessions", "task-cleanup-fail");
  mkdirSync(taskDir, { recursive: true });
  const entry = {
    id: "task-cleanup-fail",
    dir: taskDir,
    sessionName: "task-task-cleanup-fail",
    startedAt: Date.now() - 1000,
    paneId: "%cleanup-fail",
    agentType: "scout",
    description: "pending cleanup failure",
    cleanupPending: true,
    cleanupPhase: "cancelled",
  };
  writeJson(join(piDir, "task-registry.json"), [entry]);

  restoreActiveBackgroundTasks(piDir, new Map(), () => true, () => {
    throw new Error("backend unavailable");
  });

  assert.deepEqual(readJson<unknown[]>(join(piDir, "task-registry.json")), [entry]);
});

it("preserves a dead HerdR record when identity-safe cleanup fails", () => {
    const piDir = makePiDir();
    const taskDir = join(piDir, "artifacts", "sessions", "task-herdr-dead");
    writeSession(taskDir, "task-task-herdr-dead");
    writeJson(join(piDir, "task-registry.json"), [
      {
        id: "task-herdr-dead",
        dir: taskDir,
        sessionName: "task-task-herdr-dead",
        startedAt: Date.now() - 1000,
        paneId: "w1:p2",
        handle: {
          backend: "herdr",
          resourceId: "w1:p2",
          socketPath: "/tmp/herdr.sock",
          terminalId: "term-2",
          workspaceId: "w1",
          workspaceGroup: "parallel-retry",
        },
        agentType: "scout",
        description: "dead grouped task",
        background: true,
      },
    ]);

    assert.doesNotThrow(() => {
      restoreActiveBackgroundTasks(
        piDir,
        new Map(),
        () => false,
        () => {
          throw new Error("workspace_not_found");
        },
      );
    });

    assert.equal(readJson<Array<{ id: string }>>(join(piDir, "task-registry.json"))[0]?.id, "task-herdr-dead");
    assert.equal(existsSync(join(piDir, "task-session-history.json")), false);
  });
});
