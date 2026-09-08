import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { restoreActiveBackgroundTasks } from "../src/lifecycle/restore.ts";
import { claudeSessionFilePath } from "../src/subagent/claudeSession.ts";

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
  it("retains an unreadable registry for a later repair", async () => {
    const piDir = makePiDir();
    const registryPath = join(piDir, "task-registry.json");
    const corrupt = "{not-json";
    writeFileSync(registryPath, corrupt, "utf8");

    await assert.doesNotReject(() => restoreActiveBackgroundTasks(piDir, new Map()));
    assert.equal(readFileSync(registryPath, "utf8"), corrupt);
  });

  it("marks completed registry entries done and removes them from registry", async () => {
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
    await restoreActiveBackgroundTasks(piDir, backgroundTasks, () => false);

    assert.equal(backgroundTasks.size, 0);
    assert.deepEqual(readJson<unknown[]>(join(piDir, "task-registry.json")), []);
    const history = readJson<Array<{ id: string; status: string }>>(
      join(piDir, "task-session-history.json"),
    );
    assert.equal(history[0]?.status, "done");

  });

  it("records provider error sessions as failed during restore", async () => {
    const piDir = makePiDir();
    const taskDir = join(piDir, "artifacts", "sessions", "task-error");
    writeSession(taskDir, "task-task-error", "error");
    writeJson(join(piDir, "task-registry.json"), [{
      id: "task-error",
      dir: taskDir,
      sessionName: "task-task-error",
      startedAt: Date.now() - 1000,
      paneId: "%missing",
      agentType: "scout",
      description: "provider error",
    }]);

    const backgroundTasks = new Map();
    await restoreActiveBackgroundTasks(piDir, backgroundTasks, () => false);

    const history = readJson<Array<{ id: string; status: string }>>(
      join(piDir, "task-session-history.json"),
    );
    assert.equal(history[0]?.status, "failed");
  });

  it("keeps an error row pending while the child resource is still alive", async () => {
    const piDir = makePiDir();
    const taskDir = join(piDir, "artifacts", "sessions", "task-retry");
    writeSession(taskDir, "task-task-retry", "error");
    writeJson(join(piDir, "task-registry.json"), [{
      id: "task-retry",
      dir: taskDir,
      sessionName: "task-task-retry",
      startedAt: Date.now() - 1000,
      paneId: "%alive",
      agentType: "scout",
      description: "provider retry",
    }]);

    const backgroundTasks = new Map();
    await restoreActiveBackgroundTasks(piDir, backgroundTasks, () => true);

    assert.equal(backgroundTasks.has("task-retry"), true);
    assert.equal(readJson<unknown[]>(join(piDir, "task-registry.json")).length, 1);
  });

  it("awaits asynchronous liveness probes during restore", async () => {
    const piDir = makePiDir();
    const taskDir = join(piDir, "artifacts", "sessions", "task-async");
    mkdirSync(taskDir, { recursive: true });
    writeJson(join(piDir, "task-registry.json"), [{
      id: "task-async",
      dir: taskDir,
      sessionName: "task-task-async",
      startedAt: Date.now() - 1000,
      paneId: "%async",
      agentType: "scout",
      description: "async restore",
      background: true,
    }]);

    const backgroundTasks = new Map();
    await restoreActiveBackgroundTasks(
      piDir,
      backgroundTasks,
      async () => false,
    );

    assert.equal(backgroundTasks.size, 0);
    assert.equal(readJson<unknown[]>(join(piDir, "task-registry.json")).length, 0);
  });

  it("awaits asynchronous cleanup before removing restored terminal records", async () => {
    const piDir = makePiDir();
    const taskDir = join(piDir, "artifacts", "sessions", "task-async-close");
    writeSession(taskDir, "task-task-async-close", "stop");
    writeJson(join(piDir, "task-registry.json"), [{
      id: "task-async-close",
      dir: taskDir,
      sessionName: "task-task-async-close",
      startedAt: Date.now() - 1000,
      paneId: "%async-close",
      agentType: "scout",
      description: "async cleanup",
      background: true,
    }]);

    let closed = false;
    await restoreActiveBackgroundTasks(
      piDir,
      new Map(),
      async () => true,
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        closed = true;
      },
    );

    assert.equal(closed, true);
    assert.deepEqual(readJson<unknown[]>(join(piDir, "task-registry.json")), []);
  });

  it("preserves durable records during a temporary backend outage", async () => {
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
    await restoreActiveBackgroundTasks(piDir, backgroundTasks, () => {
      const error = new Error("connection refused");
      error.name = "HerdrUnavailableError";
      throw error;
    });

    assert.equal(backgroundTasks.size, 0);
    assert.equal(readJson<Array<{ id: string }>>(join(piDir, "task-registry.json"))[0]?.id, "task-herdr");
  });

  it("preserves an isolated child cwd while restoring a live task", async () => {
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
    await restoreActiveBackgroundTasks(piDir, backgroundTasks, () => true);

    assert.equal(backgroundTasks.get("task-live")?.cwd, childCwd);
  });

  it("restores comparison metadata on live sibling tasks", async () => {
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
    await restoreActiveBackgroundTasks(piDir, backgroundTasks, () => true);

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

  it("persists finished comparison siblings for grouped restore", async () => {
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
    await restoreActiveBackgroundTasks(piDir, backgroundTasks, () => false);

    assert.equal(backgroundTasks.size, 1);
    assert.equal(backgroundTasks.has("task-compare-m1"), true);
    assert.equal(readJson<unknown[]>(join(piDir, "task-registry.json")).length, 1);
    const history = readJson<Array<{ id: string; status: string; comparisonModel?: string }>>(
      join(piDir, "task-session-history.json"),
    );
    assert.equal(history.find((entry) => entry.id === "task-compare-m0")?.status, "done");
    assert.equal(history.find((entry) => entry.id === "task-compare-m0")?.comparisonModel, "model-a");
  });

  it("detects a comparison sibling finished during a long outage in the production session layout", async () => {
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
    await restoreActiveBackgroundTasks(piDir, backgroundTasks, (entry) => entry.id === "task-compare-m1");

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

  it("persists restored finished tasks with the session's last message timestamp", async () => {
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

    await restoreActiveBackgroundTasks(piDir, new Map(), () => false);

    const history = readJson<Array<{ id: string; status: string; completedAt?: number }>>(
      join(piDir, "task-session-history.json"),
    );
    const entry = history.find((e) => e.id === "task-finished-ts");
    assert.equal(entry?.status, "done");
    assert.equal(entry?.completedAt, finishedAt);
  });

  it("retains entries and never throws when a durable write fails during restore", async () => {
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
    await assert.doesNotReject(async () =>
      await restoreActiveBackgroundTasks(piDir, backgroundTasks, () => false),
    );
    // The entry could not be settled durably, so it must be retained.
    const registry = readJson<Array<{ id: string }>>(join(piDir, "task-registry.json"));
    assert.equal(registry.some((entry) => entry.id === "task-unwritable"), true);
  });

  it("marks non-terminal entries failed when their pane is gone", async () => {
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
    await restoreActiveBackgroundTasks(piDir, backgroundTasks, () => false);

    assert.equal(backgroundTasks.size, 0);
    assert.deepEqual(readJson<unknown[]>(join(piDir, "task-registry.json")), []);
    const history = readJson<Array<{ id: string; status: string }>>(
      join(piDir, "task-session-history.json"),
    );
    assert.equal(history[0]?.status, "failed");
  });

  it("retries terminal cleanup receipts without restoring them as running tasks", async () => {
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
  await restoreActiveBackgroundTasks(piDir, backgroundTasks, () => true, () => {
    closeCount += 1;
  });

  assert.equal(closeCount, 1);
  assert.equal(backgroundTasks.size, 0);
  assert.deepEqual(readJson<unknown[]>(join(piDir, "task-registry.json")), []);
});

it("synthesizes the terminal history record for a receipt that lost its history entry", async () => {
  // completion.ts writes the cleanup receipt BEFORE the history upsert, so a
  // crash (or an unwritable history file) can leave a receipt without a
  // terminal record. Restore must synthesize it — comparison grouping needs
  // both siblings' history records, and a receipt-only task would otherwise
  // vanish from history when its registry entry is removed.
  const piDir = makePiDir();
  const taskDir = join(piDir, "artifacts", "sessions", "task-receipt-only");
  mkdirSync(taskDir, { recursive: true });
  writeJson(join(piDir, "task-registry.json"), [{
    id: "task-receipt-only",
    dir: taskDir,
    sessionName: "task-task-receipt-only",
    startedAt: Date.now() - 1000,
    paneId: "%receipt",
    agentType: "scout",
    description: "receipt without history",
    ownerSessionId: "sess-a",
    ownerLeafId: "leaf-a",
    cleanupPending: true,
    cleanupPhase: "done",
    comparisonGroupId: "grp-1",
    comparisonModel: "zai/glm-5.3",
    comparisonDescription: "receipt sibling",
    comparisonIndex: 0,
  }]);

  const backgroundTasks = new Map();
  await restoreActiveBackgroundTasks(piDir, backgroundTasks, () => true, () => {});

  const history = readJson<
    Array<{
      id: string;
      status: string;
      completedAt?: number;
      comparisonModel?: string;
      comparisonDescription?: string;
      ownerSessionId?: string;
      ownerLeafId?: string | null;
    }>
  >(join(piDir, "task-session-history.json"));
  const entry = history.find((e) => e.id === "task-receipt-only");
  assert.ok(entry, "terminal history record was synthesized");
  assert.equal(entry.status, "done", "phase comes from cleanupPhase");
  assert.equal(entry.comparisonGroupId, "grp-1", "comparison group copied");
  assert.equal(entry.comparisonModel, "zai/glm-5.3", "comparison model copied");
  assert.equal(entry.ownerSessionId, "sess-a", "owner session copied");
  assert.equal(entry.ownerLeafId, "leaf-a", "owner leaf copied");
  assert.equal(
    entry.comparisonDescription,
    "receipt sibling",
    "comparison description copied",
  );
  assert.ok(typeof entry.completedAt === "number", "completedAt recorded");
  assert.deepEqual(readJson<unknown[]>(join(piDir, "task-registry.json")), []);
});

it("receipt synthesis never clobbers an already-delivered comparison marker", async () => {
  // A delivered group is marked comparisonDelivered: true in history; if the
  // registry-removal write then failed, the receipt still sits in the
  // registry WITHOUT the marker. Synthesizing naively would clobber true back
  // to undefined and let a restart replay the grouped report.
  const piDir = makePiDir();
  const taskDir = join(piDir, "artifacts", "sessions", "task-delivered");
  mkdirSync(taskDir, { recursive: true });
  writeJson(join(piDir, "task-registry.json"), [{
    id: "task-delivered",
    dir: taskDir,
    sessionName: "task-task-delivered",
    startedAt: Date.now() - 1000,
    paneId: "%delivered",
    agentType: "scout",
    description: "delivered receipt",
    cleanupPending: true,
    cleanupPhase: "done",
    comparisonGroupId: "grp-2",
  }]);
  writeJson(join(piDir, "task-session-history.json"), [{
    id: "task-delivered",
    status: "done",
    background: true,
    comparisonGroupId: "grp-2",
    comparisonDelivered: true,
  }]);

  await restoreActiveBackgroundTasks(piDir, new Map(), () => true, () => {});

  const history = readJson<Array<{ id: string; comparisonDelivered?: boolean }>>(
    join(piDir, "task-session-history.json"),
  );
  const entry = history.find((e) => e.id === "task-delivered");
  assert.equal(
    entry.comparisonDelivered,
    true,
    "delivered marker survives receipt synthesis",
  );
});

it("preserves terminal cleanup receipts when retry still fails", async () => {
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

  await restoreActiveBackgroundTasks(piDir, new Map(), () => true, () => {
    throw new Error("backend unavailable");
  });

  assert.deepEqual(readJson<unknown[]>(join(piDir, "task-registry.json")), [entry]);
});

it("preserves a dead HerdR record when identity-safe cleanup fails", async () => {
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

    await assert.doesNotReject(async () => {
      await restoreActiveBackgroundTasks(
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

describe("session ownership (issue #20)", () => {
  function ownedEntry(piDir: string, over: Record<string, unknown>) {
    const taskDir = join(piDir, "artifacts", "sessions", String(over.id));
    writeSession(taskDir, `task-${over.id}`, over.stopReason);
    return {
      id: over.id,
      dir: taskDir,
      sessionName: `task-${over.id}`,
      startedAt: Date.now() - 1000,
      paneId: "%live",
      agentType: "scout",
      description: "owned task",
      ...over,
    };
  }

  it("skips live entries owned by another session with a live owner process", async () => {
    const piDir = makePiDir();
    writeJson(join(piDir, "task-registry.json"), [
      ownedEntry(piDir, { id: "task-foreign", ownerSessionId: "sess-a", ownerPid: 4242 }),
    ]);

    const backgroundTasks = new Map();
    await restoreActiveBackgroundTasks(piDir, backgroundTasks, () => true, () => {}, {
      sessionId: "sess-b",
      isProcessAlive: () => true,
    });

    assert.equal(backgroundTasks.size, 0, "foreign task must not be adopted");
    assert.equal(
      readJson<Array<{ id: string }>>(join(piDir, "task-registry.json")).length,
      1,
      "registry entry left untouched for the owner",
    );
    assert.equal(
      existsSync(join(piDir, "task-session-history.json")),
      false,
      "no receipt written for another session's task",
    );
  });

  it("treats an owned entry without a pid as unverifiable and skips it", async () => {
    const piDir = makePiDir();
    writeJson(join(piDir, "task-registry.json"), [
      ownedEntry(piDir, { id: "task-nopid", ownerSessionId: "sess-a" }),
    ]);

    const backgroundTasks = new Map();
    await restoreActiveBackgroundTasks(piDir, backgroundTasks, () => true, () => {}, {
      sessionId: "sess-b",
      isProcessAlive: () => false,
    });

    assert.equal(backgroundTasks.size, 0, "unverifiable owner is never overridden");
    assert.equal(
      readJson<Array<{ id: string }>>(join(piDir, "task-registry.json")).length,
      1,
      "registry entry retained",
    );
  });

  it("restores entries owned by the current session", async () => {
    const piDir = makePiDir();
    writeJson(join(piDir, "task-registry.json"), [
      ownedEntry(piDir, {
        id: "task-own",
        ownerSessionId: "sess-b",
        ownerLeafId: "leaf-1",
        ownerPid: 4242,
      }),
    ]);

    const backgroundTasks = new Map();
    await restoreActiveBackgroundTasks(piDir, backgroundTasks, () => true, () => {}, {
      sessionId: "sess-b",
      isProcessAlive: () => true,
    });

    assert.equal(backgroundTasks.has("task-own"), true, "own live task restored");
    assert.equal(
      (backgroundTasks.get("task-own") as { ownerLeafId?: string }).ownerLeafId,
      "leaf-1",
      "spawn leaf survives restore",
    );
    assert.equal(
      readJson<Array<{ id: string }>>(join(piDir, "task-registry.json")).length,
      1,
      "live entry stays registered",
    );
  });

  it("terminates an orphaned live pane when the owning process is gone", async () => {
    const piDir = makePiDir();
    writeJson(join(piDir, "task-registry.json"), [
      ownedEntry(piDir, { id: "task-orphan", ownerSessionId: "sess-a", ownerPid: 4242 }),
    ]);

    let closeCount = 0;
    const backgroundTasks = new Map();
    await restoreActiveBackgroundTasks(
      piDir,
      backgroundTasks,
      () => true,
      () => {
        closeCount += 1;
      },
      { sessionId: "sess-b", isProcessAlive: () => false },
    );

    assert.equal(closeCount, 1, "orphaned pane terminated");
    assert.equal(backgroundTasks.size, 0, "orphan is never adopted");
    assert.deepEqual(
      readJson<Array<{ id: string }>>(join(piDir, "task-registry.json")),
      [],
      "orphan entry settled and removed",
    );
    const history = readJson<Array<{ id: string; status: string }>>(
      join(piDir, "task-session-history.json"),
    );
    assert.equal(history[0]?.status, "failed", "terminal receipt recorded");
  });

  it("records a finished orphan done when its owner is gone", async () => {
    const piDir = makePiDir();
    writeJson(join(piDir, "task-registry.json"), [
      ownedEntry(piDir, {
        id: "task-orphan-done",
        ownerSessionId: "sess-a",
        ownerPid: 4242,
        stopReason: "stop",
      }),
    ]);

    const backgroundTasks = new Map();
    await restoreActiveBackgroundTasks(piDir, backgroundTasks, () => true, () => {}, {
      sessionId: "sess-b",
      isProcessAlive: () => false,
    });

    assert.equal(backgroundTasks.size, 0);
    const history = readJson<Array<{ id: string; status: string }>>(
      join(piDir, "task-session-history.json"),
    );
    assert.equal(history[0]?.status, "done", "finished orphan keeps its result");
  });

  it("restores legacy entries without ownership information", async () => {
    const piDir = makePiDir();
    writeJson(join(piDir, "task-registry.json"), [
      ownedEntry(piDir, { id: "task-legacy" }),
    ]);

    const backgroundTasks = new Map();
    await restoreActiveBackgroundTasks(piDir, backgroundTasks, () => true, () => {}, {
      sessionId: "sess-b",
      isProcessAlive: () => true,
    });

    assert.equal(backgroundTasks.has("task-legacy"), true, "legacy entry restores as before");
  });

  it("restores owned entries when the current session id is unknown", async () => {
    const piDir = makePiDir();
    writeJson(join(piDir, "task-registry.json"), [
      ownedEntry(piDir, { id: "task-unknown-host", ownerSessionId: "sess-a", ownerPid: 4242 }),
    ]);

    const backgroundTasks = new Map();
    await restoreActiveBackgroundTasks(piDir, backgroundTasks, () => true, () => {}, {
      sessionId: "",
      isProcessAlive: () => true,
    });

    assert.equal(
      backgroundTasks.has("task-unknown-host"),
      true,
      "unknown session id disables ownership scoping",
    );
  });
});

describe("claude restart recovery (issue #22)", () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function claudeEntry(
    piDir: string,
    over: {
      id: string;
      cwd: string;
      sessionName: string;
      claudeSessionId?: string;
      startedAt?: number;
    },
  ) {
    mkdirSync(join(piDir, "artifacts"), { recursive: true });
    mkdirSync(over.cwd, { recursive: true });
    return {
      id: over.id,
      dir: join(piDir, "artifacts"),
      cwd: over.cwd,
      sessionName: over.sessionName,
      runtime: "claude",
      ...(over.claudeSessionId !== undefined ? { claudeSessionId: over.claudeSessionId } : {}),
      startedAt: over.startedAt ?? Date.now() - 1000,
      handle: { backend: "herdr", resourceId: "w1:p9", socketPath: "/tmp/h.sock", terminalId: "t9" },
      agentType: "general",
      description: "claude runtime recovery",
      background: true,
    };
  }

  function writeClaudeTranscript(
    cwd: string,
    sessionId: string,
    stopReason: string | null,
    timestamp = new Date().toISOString(),
  ) {
    const transcript = claudeSessionFilePath(cwd, sessionId);
    mkdirSync(dirname(transcript), { recursive: true });
    writeFileSync(
      transcript,
      JSON.stringify({
        type: "assistant",
        timestamp,
        message: {
          role: "assistant",
          stop_reason: stopReason,
          content: [{ type: "text", text: "claude done" }],
        },
      }) + "\n",
    );
    return transcript;
  }

  it("recovers a finished claude task via its persisted claudeSessionId, not sessionName", async () => {
    // issue #22: the transcript is <claudeSessionId>.jsonl under the child
    // cwd's Claude projects dir while sessionName stays the ordinary
    // task-<id> name, so restore must inspect the UUID transcript — not
    // sessionName — to classify the task as done.
    const piDir = makePiDir();
    const cwd = join(piDir, "repo");
    const claudeSessionId = "a1111111-2222-4333-8444-555555555555";
    assert.ok(UUID_RE.test(claudeSessionId));
    const completionTimestamp = "2026-09-08T10:00:05.000Z";
    writeClaudeTranscript(cwd, claudeSessionId, "end_turn", completionTimestamp);
    writeJson(join(piDir, "task-registry.json"), [
      claudeEntry(piDir, {
        id: "task-claude-done",
        cwd,
        sessionName: "task-task-claude-done",
        claudeSessionId,
        startedAt: Date.parse(completionTimestamp) - 1000,
      }),
    ]);

    const closes: string[] = [];
    const backgroundTasks = new Map();
    await restoreActiveBackgroundTasks(piDir, backgroundTasks, () => false, (entry) => {
      closes.push(String((entry as { claudeSessionId?: string }).claudeSessionId));
    });

    assert.equal(backgroundTasks.size, 0, "finished claude task must not be restored as running");
    assert.deepEqual(
      readJson<unknown[]>(join(piDir, "task-registry.json")),
      [],
      "settled claude entry removed from the registry",
    );
    const history = readJson<Array<{
      id: string;
      status: string;
      runtime?: string;
      claudeSessionId?: string;
      completedAt?: number;
    }>>(
      join(piDir, "task-session-history.json"),
    );
    assert.equal(history[0]?.status, "done", "claude transcript proves completion");
    assert.equal(history[0]?.runtime, "claude", "history preserves the runtime");
    assert.equal(
      history[0]?.completedAt,
      Date.parse(completionTimestamp),
      "history uses the Claude completion timestamp",
    );
    assert.equal(
      history[0]?.claudeSessionId,
      claudeSessionId,
      "history keeps the durable claudeSessionId",
    );
    assert.deepEqual(closes, [claudeSessionId], "cleanup receives the persisted UUID");
  });

  it("restores a running claude task with the UUID-rebuilt transcript path", async () => {
    const piDir = makePiDir();
    const cwd = join(piDir, "repo");
    const claudeSessionId = "b1111111-2222-4333-8444-555555555555";
    writeJson(join(piDir, "task-registry.json"), [
      claudeEntry(piDir, {
        id: "task-claude-live",
        cwd,
        sessionName: "task-task-claude-live",
        claudeSessionId,
      }),
    ]);

    const backgroundTasks = new Map();
    await restoreActiveBackgroundTasks(piDir, backgroundTasks, () => true);

    const restored = backgroundTasks.get("task-claude-live") as {
      claudeSessionId?: string;
      claudeSessionFile?: string;
    } | undefined;
    assert.ok(restored, "running claude task is restored for polling");
    assert.equal(restored.claudeSessionId, claudeSessionId, "durable UUID survives restore");
    assert.equal(
      restored.claudeSessionFile,
      claudeSessionFilePath(cwd, claudeSessionId),
      "transcript path rebuilt from cwd + claudeSessionId",
    );
  });

  it("never invents a claude transcript path from a non-UUID sessionName", async () => {
    // Legacy claude entries recorded only task-task-<id> names. Those must
    // not be treated as session UUIDs: restore leaves claudeSessionFile
    // unset so completion polling fails closed instead of probing a
    // fabricated "<sessionName>.jsonl" transcript.
    const piDir = makePiDir();
    const cwd = join(piDir, "repo");
    writeJson(join(piDir, "task-registry.json"), [
      claudeEntry(piDir, {
        id: "task-claude-legacy",
        cwd,
        sessionName: "task-task-claude-legacy",
      }),
    ]);

    const backgroundTasks = new Map();
    await restoreActiveBackgroundTasks(piDir, backgroundTasks, () => true);

    const restored = backgroundTasks.get("task-claude-legacy") as {
      claudeSessionFile?: string;
    } | undefined;
    assert.ok(restored, "legacy claude task still restores as running");
    assert.equal(
      restored.claudeSessionFile,
      undefined,
      "no transcript path fabricated from the task session name",
    );
  });

  it("falls back to a legacy UUID sessionName when claudeSessionId is absent", async () => {
    // Early builds pinned sessionName to the claude UUID. Restore must keep
    // accepting those, but only when the name is syntactically a UUID.
    const piDir = makePiDir();
    const cwd = join(piDir, "repo");
    const legacyId = "c1111111-2222-4333-8444-555555555555";
    writeJson(join(piDir, "task-registry.json"), [
      claudeEntry(piDir, {
        id: "task-claude-uuid-name",
        cwd,
        sessionName: legacyId,
      }),
    ]);

    const backgroundTasks = new Map();
    await restoreActiveBackgroundTasks(piDir, backgroundTasks, () => true);

    const restored = backgroundTasks.get("task-claude-uuid-name") as {
      claudeSessionFile?: string;
    } | undefined;
    assert.ok(restored, "legacy UUID-named claude task restores as running");
    assert.equal(
      restored.claudeSessionFile,
      claudeSessionFilePath(cwd, legacyId),
      "legacy UUID sessionName resolves the transcript path",
    );
  });
});
