/**
 * One Pi process owns a durable store at a time. pi-durable has no
 * cross-process locking, so before this lock a second process opening the
 * same SQLite file resumed — and answered — work a live process was running.
 */

import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";

import {
  abortDurableTask,
  durableDatabasePath,
  durableSessionStore,
  durableStorePathForTask,
  openDurableHarness,
  resolveDurableStorePath,
} from "../src/subagent/durable.js";
import {
  acquireDurableStoreLock,
  DurableStoreLockedError,
  isDurableStoreLockedError,
} from "../src/subagent/durable-store-lock.js";
import {
  executeDurableTask,
  reconcileUnadmittedDurableTasks,
  resumeDurableAfterRestart,
} from "../src/lifecycle/durable-execution.js";
import { readTaskSessionHistory, upsertTaskSessionHistory } from "../src/conversation.js";
import { DeliveryGuard } from "../src/panel/delivery.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const crashScript = join(testDir, "durable-crash-child.ts");
const lockScript = join(testDir, "durable-lock-child.ts");

function fauxModels() {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("done")]);
  return models;
}

function fixture(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const piDir = join(root, ".pi");
  mkdirSync(piDir, { recursive: true });
  return { root, piDir, databasePath: join(root, "durable.sqlite") };
}

/** Run the lock child and return its first output line. */
function lockChild(databasePath: string, mode: "try" | "hold", env: NodeJS.ProcessEnv = process.env) {
  const child = spawn(process.execPath, ["--import", "tsx", lockScript, databasePath, mode], {
    env,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const line = new Promise<string>((resolve, reject) => {
    let output = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const newline = output.indexOf("\n");
      if (newline >= 0) resolve(output.slice(0, newline));
    });
    child.once("exit", (code) => reject(new Error(`lock child exited without output: ${code}`)));
  });
  return { child, line };
}

async function tryLockFromAnotherProcess(
  databasePath: string,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const { child, line } = lockChild(databasePath, "try", env);
  try {
    return await line;
  } finally {
    await kill(child);
  }
}

async function kill(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGKILL");
  await exited;
}

/** Start a process that owns `databasePath` with a durable task mid-tool. */
async function startDurableOwner(root: string, databasePath: string, piDir: string, taskId: string) {
  const started = join(root, "tool-started");
  const child = spawn(
    process.execPath,
    ["--import", "tsx", crashScript, databasePath, piDir, taskId, started],
    { env: process.env, stdio: ["ignore", "pipe", "inherit"] },
  );
  await new Promise<void>((resolve, reject) => {
    let output = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("M2 child: submitted")) resolve();
    });
    child.once("exit", (code) => reject(new Error(`owner exited early: ${code}`)));
    setTimeout(() => reject(new Error("owner never submitted")), 20_000).unref();
  });
  for (let waited = 0; !existsSync(started); waited += 20) {
    if (waited > 20_000) throw new Error("owner tool never started");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return child;
}

function runningDurableRow(piDir: string, id: string, ownerSessionId: string) {
  upsertTaskSessionHistory(piDir, {
    id,
    status: "running",
    background: true,
    backend: "durable",
    agentType: "general",
    description: "durable task",
    sessionName: `task-${id}`,
    startedAt: Date.now(),
    piDir,
    dir: join(piDir, "artifacts"),
    ownerSessionId,
    durableRequestId: `pi-task:${id}`,
    ownerPid: 2 ** 22 + 1,
  });
}

test("a second process cannot open a store a live process owns, and takes it over once the owner dies", async () => {
  const { root, piDir, databasePath } = fixture("pi-task-store-lock-");
  let owner: ChildProcess | undefined;
  let handle: Awaited<ReturnType<typeof openDurableHarness>> | undefined;
  try {
    owner = await startDurableOwner(root, databasePath, piDir, "t-live");
    await assert.rejects(
      openDurableHarness(piDir, { databasePath, models: () => fauxModels() }),
      (error: unknown) => {
        assert.ok(isDurableStoreLockedError(error), String(error));
        assert.equal(error.holderPid, owner!.pid);
        return true;
      },
    );
    // SIGKILL skips exit handlers, so a socket-file lock is left stale.
    await kill(owner);
    handle = await openDurableHarness(piDir, { databasePath, models: () => fauxModels() });
  } finally {
    if (owner) await kill(owner);
    if (handle) await handle.harness.close(handle.context);
    rmSync(root, { recursive: true, force: true });
  }
});

test("the lock is re-entrant within one process and excludes others until its last release", async () => {
  const { root, databasePath } = fixture("pi-task-store-lock-reentrant-");
  try {
    const first = await acquireDurableStoreLock(databasePath);
    const second = await acquireDurableStoreLock(databasePath);
    assert.equal(await tryLockFromAnotherProcess(databasePath), `locked ${process.pid}`);
    // The lock must not depend on per-process settings such as TMPDIR.
    const otherTmp = mkdtempSync(join(root, "tmp-"));
    assert.equal(
      await tryLockFromAnotherProcess(databasePath, { ...process.env, TMPDIR: otherTmp }),
      `locked ${process.pid}`,
    );
    first();
    first(); // idempotent: must not release the second holder's claim
    assert.equal(await tryLockFromAnotherProcess(databasePath), `locked ${process.pid}`);
    second();
    assert.equal(await tryLockFromAnotherProcess(databasePath), "acquired");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a store held by an earlier copy of this extension is refused, and the error says to restart", async () => {
  // After `/reload` the extension is evaluated again in the same process and the earlier
  // copy still holds the store through its own harness. The new copy must stay refused
  // (two harnesses on one store would rerun the running turn), but the error must not
  // blame "another Pi process" when the holder is this very process.
  const { root, databasePath } = fixture("pi-task-store-lock-earlier-copy-");
  try {
    const earlier = (await import(
      `../src/subagent/durable-store-lock.js?earlier=${Date.now()}`
    )) as typeof import("../src/subagent/durable-store-lock.js");
    const release = await earlier.acquireDurableStoreLock(databasePath);
    try {
      let refused: unknown;
      try {
        await acquireDurableStoreLock(databasePath);
      } catch (error) {
        refused = error;
      }
      assert.ok(refused, "the second copy must not take the store");
      assert.ok(isDurableStoreLockedError(refused));
      assert.equal((refused as { holderPid?: number }).holderPid, process.pid);
      const message = (refused as Error).message;
      assert.match(message, /earlier copy of pi-task in this process/);
      assert.match(message, /could not release it/);
      assert.match(message, /\/reload/);
      assert.match(message, /restart Pi/i);
      assert.match(message, /"taskBackend": "sdk"/);
      assert.match(message, /PI_TASK_BACKEND=sdk/);
      assert.match(message, /environment variable wins over the setting/);
      assert.doesNotMatch(message, /another Pi process/);
      assert.match(message, new RegExp(databasePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } finally {
      release();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a store another process owns still reads as another Pi process", async () => {
  const { root, databasePath } = fixture("pi-task-store-lock-other-process-");
  const { child, line } = lockChild(databasePath, "hold");
  try {
    assert.equal(await line, "held");
    let refused: unknown;
    try {
      await acquireDurableStoreLock(databasePath);
    } catch (error) {
      refused = error;
    }
    assert.ok(isDurableStoreLockedError(refused));
    assert.notEqual((refused as { holderPid?: number }).holderPid, process.pid);
    assert.equal((refused as { holderPid?: number }).holderPid, child.pid);
    assert.match((refused as Error).message, new RegExp(`another Pi process \\(pid ${child.pid}\\)`));
    assert.doesNotMatch((refused as Error).message, /earlier copy/);
  } finally {
    await kill(child);
    rmSync(root, { recursive: true, force: true });
  }
});

test("the lock error reads by who holds the store, whatever the holder's pid is known to be", () => {
  const path = "/store/durable.sqlite";

  assert.match(new DurableStoreLockedError(path, process.pid).message, /earlier copy of pi-task in this process/);
  assert.match(new DurableStoreLockedError(path, 1).message, /another Pi process \(pid 1\)/);
  const unknown = new DurableStoreLockedError(path, undefined).message;
  assert.match(unknown, /another Pi process\. /);
  assert.doesNotMatch(unknown, /earlier copy|\(pid/);
});

test("session start claims the store only for this session's own running durable work", async () => {
  const { root, piDir, databasePath } = fixture("pi-task-store-lock-gate-");
  try {
    writeFileSync(databasePath, "");
    runningDurableRow(piDir, "t-foreign", "sess-other");
    const resume = () => resumeDurableAfterRestart({
      pi: { sendMessage: () => undefined } as never,
      piDir,
      databasePath,
      sessionId: "sess-me",
      models: () => fauxModels(),
    });

    assert.equal((await resume()).size, 0);
    assert.equal(await tryLockFromAnotherProcess(databasePath), "acquired", "foreign work alone must not claim the store");

    runningDurableRow(piDir, "t-mine", "sess-me");
    await resume();
    assert.equal(await tryLockFromAnotherProcess(databasePath), `locked ${process.pid}`);
    const handle = await openDurableHarness(piDir, { databasePath, models: () => fauxModels() });
    await handle.harness.close(handle.context);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("admission reconciliation keeps a running row whose store another process owns", async () => {
  const { root, piDir, databasePath } = fixture("pi-task-store-lock-reconcile-");
  const holder = lockChild(databasePath, "hold");
  try {
    assert.equal(await holder.line, "held");
    writeFileSync(databasePath, "");
    runningDurableRow(piDir, "t-locked", "sess-me");

    const reconciled = await reconcileUnadmittedDurableTasks({
      piDir,
      sessionId: "sess-me",
      recoveredTaskIds: new Set(),
      databasePath,
      isProcessAlive: () => false,
      models: () => fauxModels(),
    });
    assert.deepEqual(reconciled, []);
    assert.equal(readTaskSessionHistory(piDir).find((entry) => entry.id === "t-locked")?.status, "running");
  } finally {
    await kill(holder.child);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a durable task is refused before any receipt or history row while another process owns the store", async () => {
  const { root, piDir } = fixture("pi-task-store-lock-execute-");
  const holder = lockChild(durableDatabasePath(piDir), "hold");
  try {
    assert.equal(await holder.line, "held");
    let ran = false;
    const result = await executeDurableTask({
      id: "t-refused",
      agent: { name: "general", description: "General task", body: "", source: "project", path: "test-agent.md" },
      description: "refused", sessionName: "task-t-refused", prompt: "Return.", cwd: root,
      toolCallId: "call-refused", ctx: { modelRegistry: {} } as never, pi: {} as never,
      piDir, artifactsDir: join(piDir, "artifacts"), isBackground: true,
      backgroundTasks: new Map(), foregroundTasks: new Map(), deliveryGuard: new DeliveryGuard(),
      taskWidget: { openTaskView() {}, closeTaskView() {}, noteTaskFinished() {}, setLiveTranscript() {} } as never,
      clearTaskWidgetIfIdle: () => {}, ensureTaskWidget: () => {}, enqueueDelivery: (delivery) => delivery(),
      runTask: async () => {
        ran = true;
        throw new Error("must not run");
      },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /^Durable task not started: .*owned by another Pi process \(pid \d+\)/);
    assert.equal(ran, false);
    assert.equal(readTaskSessionHistory(piDir).some((entry) => entry.id === "t-refused"), false);
  } finally {
    await kill(holder.child);
    rmSync(root, { recursive: true, force: true });
  }
});

// ── One store per Pi session ─────────────────────────────────────────────

function sessionCtx(sessionId: string) {
  return {
    modelRegistry: {},
    sessionManager: {
      getSessionId: () => sessionId,
      getLeafId: () => "leaf-1",
      getBranch: () => [{ id: "leaf-1" }],
    },
  } as never;
}

async function executeWithCapturedStore(piDir: string, root: string, id: string, sessionId: string, body = "") {
  let databasePath: string | undefined;
  let instructions: string | undefined;
  const result = await executeDurableTask({
    id,
    agent: { name: "general", description: "General task", body, source: "project", path: "test-agent.md" },
    description: "store", sessionName: `task-${id}`, prompt: "Return.", cwd: root,
    toolCallId: `call-${id}`, ctx: sessionCtx(sessionId), pi: {} as never,
    piDir, artifactsDir: join(piDir, "artifacts"), isBackground: false,
    backgroundTasks: new Map(), foregroundTasks: new Map(), deliveryGuard: new DeliveryGuard(),
    taskWidget: { openTaskView() {}, closeTaskView() {}, noteTaskFinished() {}, setLiveTranscript() {} } as never,
    clearTaskWidgetIfIdle: () => {}, ensureTaskWidget: () => {}, enqueueDelivery: (delivery) => delivery(),
    runTask: async (input) => {
      databasePath = input.databasePath;
      instructions = input.instructions;
      return {
        conversationId: `child-${id}`,
        answer: "Status: success\nDone.",
        usage: { models: {}, tools: {}, totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costTotal: 0 } },
      } as never;
    },
  });
  return { result, databasePath, instructions };
}

test("a durable task hands the agent body to the child as instructions, and omits a blank body", async () => {
  const { root, piDir } = fixture("pi-task-agent-body-");
  try {
    const withBody = await executeWithCapturedStore(piDir, root, "t-body", "sess-a", "You are read-only.\n");
    assert.equal(withBody.instructions, "You are read-only.\n");

    const blank = await executeWithCapturedStore(piDir, root, "t-blank", "sess-a", "  \n");
    assert.equal(blank.instructions, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a new durable task runs in its session's own store and records it", async () => {
  const { root, piDir } = fixture("pi-task-session-store-new-");
  try {
    const { result, databasePath } = await executeWithCapturedStore(piDir, root, "t-new", "sess-a");
    assert.notEqual(result.isError, true);
    assert.equal(databasePath, join(piDir, "durable", "sessions", "sess-a.sqlite"));
    assert.equal(
      readTaskSessionHistory(piDir).find((entry) => entry.id === "t-new")?.durableStore,
      "durable/sessions/sess-a.sqlite",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resuming a durable task from another session keeps the store that holds its child", async () => {
  const { root, piDir } = fixture("pi-task-session-store-resume-");
  try {
    await executeWithCapturedStore(piDir, root, "t-origin", "sess-a");
    const resumed = await executeWithCapturedStore(piDir, root, "t-origin", "sess-b");
    assert.equal(resumed.databasePath, join(piDir, "durable", "sessions", "sess-a.sqlite"));

    upsertTaskSessionHistory(piDir, {
      id: "t-legacy", status: "done", background: false, backend: "durable", agentType: "general",
      description: "legacy", sessionName: "task-t-legacy", startedAt: 1, piDir, dir: join(piDir, "artifacts"),
    });
    const legacy = await executeWithCapturedStore(piDir, root, "t-legacy", "sess-b");
    assert.equal(legacy.databasePath, durableDatabasePath(piDir));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two sessions in one project run durable tasks concurrently", async () => {
  const { root, piDir } = fixture("pi-task-session-store-concurrent-");
  const otherSession = lockChild(join(piDir, "durable", "sessions", "sess-a.sqlite"), "hold");
  try {
    assert.equal(await otherSession.line, "held");
    const { result, databasePath } = await executeWithCapturedStore(piDir, root, "t-b", "sess-b");
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    assert.equal(databasePath, join(piDir, "durable", "sessions", "sess-b.sqlite"));
  } finally {
    await kill(otherSession.child);
    rmSync(root, { recursive: true, force: true });
  }
});

test("session start opens only the stores holding this session's own running work", async () => {
  const { root, piDir } = fixture("pi-task-session-store-startup-");
  const mine = join(piDir, "durable", "sessions", "sess-me.sqlite");
  const theirs = join(piDir, "durable", "sessions", "sess-other.sqlite");
  try {
    mkdirSync(dirname(mine), { recursive: true });
    writeFileSync(mine, "");
    writeFileSync(theirs, "");
    runningDurableRow(piDir, "t-mine", "sess-me");
    upsertTaskSessionHistory(piDir, { ...readTaskSessionHistory(piDir)[0]!, durableStore: "durable/sessions/sess-me.sqlite" });
    runningDurableRow(piDir, "t-theirs", "sess-other");
    upsertTaskSessionHistory(piDir, {
      ...readTaskSessionHistory(piDir).find((entry) => entry.id === "t-theirs")!,
      durableStore: "durable/sessions/sess-other.sqlite",
    });

    await resumeDurableAfterRestart({
      pi: { sendMessage: () => undefined } as never,
      piDir,
      sessionId: "sess-me",
      models: () => fauxModels(),
    });
    assert.equal(await tryLockFromAnotherProcess(mine), `locked ${process.pid}`);
    assert.equal(await tryLockFromAnotherProcess(theirs), "acquired");
    const handle = await openDurableHarness(piDir, { databasePath: mine, models: () => fauxModels() });
    await handle.harness.close(handle.context);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task-scoped durable operations open the store recorded for the task", async () => {
  const { root, piDir } = fixture("pi-task-session-store-ops-");
  const store = join(piDir, "durable", "sessions", "sess-x.sqlite");
  try {
    runningDurableRow(piDir, "t-x", "sess-x");
    upsertTaskSessionHistory(piDir, { ...readTaskSessionHistory(piDir)[0]!, durableStore: "durable/sessions/sess-x.sqlite" });
    assert.equal(durableStorePathForTask(piDir, "t-x"), store);
    assert.match(String(await abortDurableTask(piDir, "t-x", { models: () => fauxModels() } as never)), /No durable child conversation/);
    assert.equal(await tryLockFromAnotherProcess(store), `locked ${process.pid}`);
    assert.equal(await tryLockFromAnotherProcess(durableDatabasePath(piDir)), "acquired");
    const handle = await openDurableHarness(piDir, { databasePath: store, models: () => fauxModels() });
    await handle.harness.close(handle.context);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recorded store paths stay inside the project's durable directory", () => {
  const piDir = join(tmpdir(), "pi-task-store-paths", ".pi");
  assert.equal(durableSessionStore(undefined), undefined);
  assert.equal(durableSessionStore("a/b:c"), "durable/sessions/a_b_c.sqlite");
  assert.equal(resolveDurableStorePath(piDir, undefined), durableDatabasePath(piDir));
  assert.equal(
    resolveDurableStorePath(piDir, "durable/sessions/x.sqlite"),
    join(piDir, "durable", "sessions", "x.sqlite"),
  );
  assert.throws(() => resolveDurableStorePath(piDir, "../../elsewhere.sqlite"), /outside/);
  assert.throws(() => resolveDurableStorePath(piDir, "/tmp/elsewhere.sqlite"), /outside/);
});

test("a background durable task records its session store from the first history write", async () => {
  const { root, piDir } = fixture("pi-task-session-store-background-");
  let releaseRun!: () => void;
  const runGate = new Promise<void>((resolve) => { releaseRun = resolve; });
  try {
    const result = await executeDurableTask({
      id: "t-bg",
      agent: { name: "general", description: "General task", body: "", source: "project", path: "test-agent.md" },
      description: "bg", sessionName: "task-t-bg", prompt: "Return.", cwd: root,
      toolCallId: "call-bg", ctx: sessionCtx("sess-bg"), pi: { sendMessage: () => undefined } as never,
      piDir, artifactsDir: join(piDir, "artifacts"), isBackground: true,
      backgroundTasks: new Map(), foregroundTasks: new Map(), deliveryGuard: new DeliveryGuard(),
      taskWidget: { openTaskView() {}, closeTaskView() {}, noteTaskFinished() {}, setLiveTranscript() {} } as never,
      clearTaskWidgetIfIdle: () => {}, ensureTaskWidget: () => {}, enqueueDelivery: () => {},
      runTask: async () => {
        await runGate;
        return {
          conversationId: "child-bg",
          answer: "Status: success\nDone.",
          usage: { models: {}, tools: {}, totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costTotal: 0 } },
        } as never;
      },
    });
    assert.notEqual(result.isError, true);
    const row = readTaskSessionHistory(piDir).find((entry) => entry.id === "t-bg");
    assert.equal(row?.status, "running");
    assert.equal(row?.durableStore, "durable/sessions/sess-bg.sqlite");
  } finally {
    releaseRun();
    await new Promise((resolve) => setTimeout(resolve, 50));
    rmSync(root, { recursive: true, force: true });
  }
});

test("a task that recorded a store keeps it even after running on another backend", async () => {
  const { root, piDir } = fixture("pi-task-session-store-recorded-");
  try {
    upsertTaskSessionHistory(piDir, {
      id: "t-moved", status: "done", background: false, backend: "sdk", agentType: "general",
      description: "moved", sessionName: "task-t-moved", startedAt: 1, piDir, dir: join(piDir, "artifacts"),
      durableStore: "durable/sessions/sess-a.sqlite",
    });
    upsertTaskSessionHistory(piDir, {
      id: "t-pane", status: "done", background: false, agentType: "general", paneId: "%1",
      description: "pane", sessionName: "task-t-pane", startedAt: 1, piDir, dir: join(piDir, "artifacts"),
    });
    assert.equal(
      (await executeWithCapturedStore(piDir, root, "t-moved", "sess-b")).databasePath,
      join(piDir, "durable", "sessions", "sess-a.sqlite"),
    );
    assert.equal(
      (await executeWithCapturedStore(piDir, root, "t-pane", "sess-b")).databasePath,
      join(piDir, "durable", "sessions", "sess-b.sqlite"),
      "a legacy pane task has no durable child to resume",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session start resumes every other store when one is owned elsewhere or recorded badly", async () => {
  const { root, piDir } = fixture("pi-task-session-store-isolation-");
  const mine = join(piDir, "durable", "sessions", "sess-me.sqlite");
  const resumed = join(piDir, "durable", "sessions", "sess-other.sqlite");
  const holder = lockChild(resumed, "hold");
  try {
    assert.equal(await holder.line, "held");
    mkdirSync(dirname(mine), { recursive: true });
    writeFileSync(mine, "");
    writeFileSync(resumed, "");
    const row = (id: string, durableStore: string) => {
      runningDurableRow(piDir, id, "sess-me");
      upsertTaskSessionHistory(piDir, {
        ...readTaskSessionHistory(piDir).find((entry) => entry.id === id)!,
        durableStore,
      });
    };
    row("t-bad", "../../outside.sqlite");
    row("t-locked", "durable/sessions/sess-other.sqlite");
    row("t-mine", "durable/sessions/sess-me.sqlite");

    const failures: string[] = [];
    await resumeDurableAfterRestart({
      pi: { sendMessage: () => undefined } as never,
      piDir,
      sessionId: "sess-me",
      models: () => fauxModels(),
      onStoreFailure: (databasePath, error) => {
        failures.push(isDurableStoreLockedError(error) ? `locked ${databasePath}` : String(error));
      },
    });
    assert.equal(failures.length, 2, failures.join("\n"));
    assert.ok(failures.some((failure) => /outside/.test(failure)));
    assert.ok(failures.some((failure) => failure.startsWith("locked ") && failure.endsWith("sess-other.sqlite")));
    assert.equal(await tryLockFromAnotherProcess(mine), `locked ${process.pid}`, "this session's own store still resumed");
    const handle = await openDurableHarness(piDir, { databasePath: mine, models: () => fauxModels() });
    await handle.harness.close(handle.context);
  } finally {
    await kill(holder.child);
    rmSync(root, { recursive: true, force: true });
  }
});
