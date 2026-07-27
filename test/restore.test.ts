import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
    writeJson(join(piDir, "task-registry.json"), [
      {
        id: "task-live",
        dir: taskDir,
        cwd: childCwd,
        sessionName: "task-task-live",
        startedAt: Date.now() - 1000,
        paneId: "%live",
        agentType: "general",
        description: "isolated writer",
        background: true,
      },
    ]);

    const backgroundTasks = new Map();
    restoreActiveBackgroundTasks(piDir, backgroundTasks, () => true);

    assert.equal(backgroundTasks.get("task-live")?.cwd, childCwd);
  });

  it("marks non-terminal entries failed when their pane is gone", () => {
    const piDir = makePiDir();
    const taskDir = join(piDir, "artifacts", "sessions", "task-2");
    writeSession(taskDir, "task-task-2");
    writeJson(join(piDir, "task-registry.json"), [
      {
        id: "task-2",
        dir: taskDir,
        sessionName: "task-task-2",
        startedAt: Date.now() - 1000,
        paneId: "%missing",
        agentType: "scout",
        description: "lost task",
        background: true,
      },
    ]);
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

  it("continues restoring when cleanup of a dead grouped HerdR pane fails", () => {
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

    assert.deepEqual(readJson<unknown[]>(join(piDir, "task-registry.json")), []);
    const history = readJson<Array<{ id: string; status: string }>>(
      join(piDir, "task-session-history.json"),
    );
    assert.equal(history[0]?.status, "failed");
  });
});
