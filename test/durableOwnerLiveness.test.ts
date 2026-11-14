/**
 * Durable owner liveness (TODO item C): a durable row's owner is proved by the
 * store lock, not only by its recorded pid. A pid is recycled, so after a
 * reboot a dead owner's pid can name an unrelated live process — the row then
 * looks alive forever and its recovery, adoption, or lost-notice replay is
 * blocked. A process that holds the store's lock is proof of life; a free lock
 * lets the pid decide.
 *
 * Terminal/SDK rows keep pid-only semantics throughout.
 *
 * Run: npx tsx --test test/durableOwnerLiveness.test.ts
 */

import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  durableOwnerLiveness,
  durableOwnerLivenessOf,
  probeDurableStoreHolder,
} from "../src/subagent/durable-store-lock.js";
import { reconcileUnadmittedDurableTasks } from "../src/lifecycle/durable-execution.js";
import {
  findLostCompletionNotices,
  resolveLostNoticeDurableLiveness,
} from "../src/lifecycle/completion.js";
import type { TaskSessionHistoryEntry } from "../src/types.js";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { readTaskSessionHistory, upsertTaskSessionHistory } from "../src/conversation.js";

/** A real model bridge: the reconciliation path opens the durable harness. */
function fauxModels() {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("done")]);
  return models;
}

const testDir = dirname(fileURLToPath(import.meta.url));
const lockScript = join(testDir, "durable-lock-child.ts");
/** A pid that is certainly not running, standing in for a recycled one. */
const DEAD_PID = 4_000_000;

function fixture(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const piDir = join(root, ".pi");
  mkdirSync(piDir, { recursive: true });
  return { root, piDir, databasePath: join(root, "durable.sqlite") };
}

async function kill(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGKILL");
  await exited;
}

/** Start a separate process that holds `databasePath`'s lock until killed. */
async function holdStore(databasePath: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["--import", "tsx", lockScript, databasePath, "hold"], {
    env: process.env,
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((resolve, reject) => {
    let output = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("held")) resolve();
    });
    child.once("exit", (code) => reject(new Error(`lock child exited early: ${code}`)));
    setTimeout(() => reject(new Error("lock child never reported")), 20_000).unref();
  });
  return child;
}

// ── The decision table, pure ────────────────────────────────────────────────

test("a foreign live lock holder proves the owner alive, whatever its recorded pid says", () => {
  // The recycled-pid case: the pid is gone, but another process holds the store.
  assert.equal(
    durableOwnerLivenessOf({ holder: { alive: true, pid: 4242 }, ownerPid: DEAD_PID, isProcessAlive: () => false }),
    "alive",
    "the lock outranks a dead pid",
  );
  // Only the store's holder pid matters, never a pid that merely looks alive.
  assert.equal(
    durableOwnerLivenessOf({ holder: { alive: false }, ownerPid: DEAD_PID, isProcessAlive: () => false }),
    "dead",
    "a free lock plus a dead pid is a dead owner",
  );
});

test("this process's own pid is alive without probing anything", () => {
  assert.equal(durableOwnerLivenessOf({ holder: undefined, ownerPid: process.pid }), "alive");
  assert.equal(durableOwnerLivenessOf({ holder: { alive: false }, ownerPid: process.pid }), "alive");
});

test("a lock held by this very process says nothing about a foreign row, so the pid decides", () => {
  // We hold the store for our own work; that must not make another process's
  // row immortal (its recovery would then never be possible).
  assert.equal(
    durableOwnerLivenessOf({
      holder: { alive: true, pid: process.pid },
      ownerPid: DEAD_PID,
      isProcessAlive: () => false,
    }),
    "dead",
  );
  assert.equal(
    durableOwnerLivenessOf({
      holder: { alive: true, pid: process.pid },
      ownerPid: 4242,
      isProcessAlive: () => true,
    }),
    "alive",
  );
});

test("an absent pid is unknown, and an unprobeable lock leaves the pid in charge", () => {
  assert.equal(durableOwnerLivenessOf({ holder: { alive: false }, ownerPid: undefined }), "unknown");
  assert.equal(durableOwnerLivenessOf({ holder: { alive: true, pid: 4242 }, ownerPid: undefined }), "unknown");
  // The probe could not speak: the pid is the only signal, exactly as before.
  for (const pid of [DEAD_PID, 4242]) {
    assert.equal(
      durableOwnerLivenessOf({ holder: undefined, ownerPid: pid, isProcessAlive: (p) => p !== DEAD_PID }),
      pid === DEAD_PID ? "dead" : "alive",
    );
  }
});

// ── The primitive against a real lock socket ────────────────────────────────

test("the durable liveness probe reads a real foreign lock holder as alive for a dead pid", async () => {
  const { root, databasePath } = fixture("pi-task-durable-liveness-foreign-");
  const holder = await holdStore(databasePath);
  try {
    // A recycled pid: this process cannot signal it, but the store is held.
    assert.equal(
      await durableOwnerLiveness({ databasePath, ownerPid: DEAD_PID, isProcessAlive: () => false }),
      "alive",
    );
    // The raw probe names the real holder, so a caller can tell it is foreign.
    const probe = await probeDurableStoreHolder(databasePath);
    assert.equal(probe?.alive, true);
    assert.equal(probe?.pid, holder.pid);
  } finally {
    await kill(holder);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a free lock plus a dead pid is dead, and an unknown store path is unknown", async () => {
  const { root, databasePath } = fixture("pi-task-durable-liveness-free-");
  try {
    // Nothing listens: the probe speaks, and says nobody holds the store.
    assert.deepEqual(await probeDurableStoreHolder(databasePath), { alive: false });
    assert.equal(
      await durableOwnerLiveness({ databasePath, ownerPid: DEAD_PID, isProcessAlive: () => false }),
      "dead",
      "an unprobeable lock leaves the pid to decide",
    );
    // An unknown store path must not invent a verdict: the pid decides here too.
    assert.equal(
      await durableOwnerLiveness({ ownerPid: DEAD_PID, isProcessAlive: () => false }),
      "dead",
    );
    assert.equal(
      await durableOwnerLiveness({ databasePath: join(root, "no-such-dir", "x.sqlite"), ownerPid: DEAD_PID, isProcessAlive: () => false }),
      "dead",
      "a store whose directory does not exist cannot be probed",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Wiring site 1: unadmitted-durable reconciliation ────────────────────────

function runningDurableRow(piDir: string, id: string, ownerPid: number, store?: string) {
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
    ownerSessionId: "sess-me",
    durableRequestId: `pi-task:${id}`,
    ownerPid,
    ...(store !== undefined ? { durableStore: store } : {}),
  });
}

test("reconciliation keeps a durable row whose store a foreign live process holds, despite a dead pid", async () => {
  const { root, piDir, databasePath } = fixture("pi-task-durable-liveness-reconcile-");
  const holder = await holdStore(databasePath);
  try {
    writeFileSync(databasePath, "");
    // The row's pid is provably dead, so the pid-only rule would reconcile it.
    runningDurableRow(piDir, "t-held", DEAD_PID);

    const reconciled = await reconcileUnadmittedDurableTasks({
      piDir,
      sessionId: "sess-me",
      recoveredTaskIds: new Set(),
      databasePath,
      isProcessAlive: () => false,
      models: () => fauxModels(),
    });
    assert.deepEqual(reconciled, [], "the live lock holder is proved alive");
    assert.equal(readTaskSessionHistory(piDir).find((e) => e.id === "t-held")?.status, "running");
  } finally {
    await kill(holder);
    rmSync(root, { recursive: true, force: true });
  }
});

test("reconciliation still reconciles a durable row whose lock is free and whose pid is dead", async () => {
  const { root, piDir, databasePath } = fixture("pi-task-durable-liveness-reconcile-dead-");
  try {
    // A store file with no lock socket and no admission: the owner is gone.
    writeFileSync(databasePath, "");
    runningDurableRow(piDir, "t-gone", DEAD_PID);

    const reconciled = await reconcileUnadmittedDurableTasks({
      piDir,
      sessionId: "sess-me",
      recoveredTaskIds: new Set(),
      databasePath,
      isProcessAlive: () => false,
      models: () => fauxModels(),
    });
    assert.deepEqual(reconciled, ["t-gone"], "a free lock cannot rescue a dead pid");
    assert.equal(readTaskSessionHistory(piDir).find((e) => e.id === "t-gone")?.status, "failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unknown liveness verdict leaves the absent-pid rule in charge, and SDK rows are never probed", async () => {
  const { root, piDir, databasePath } = fixture("pi-task-durable-liveness-reconcile-other-");
  try {
    writeFileSync(databasePath, "");
    // No pid at all: the liveness verdict is `unknown`, so the rules that were
    // there before this change decide — they reconcile an owner-less durable
    // row, and this change must not alter that (verified against the pre-change
    // source: the same row reconciled to ["t-no-pid"]).
    upsertTaskSessionHistory(piDir, {
      id: "t-no-pid", status: "running", background: true, backend: "durable",
      agentType: "general", description: "no pid", sessionName: "task-t-no-pid",
      startedAt: Date.now(), piDir, dir: join(piDir, "artifacts"),
      ownerSessionId: "sess-me", durableRequestId: "pi-task:t-no-pid",
    });
    // A live pid keeps a durable row, lock or no lock, exactly as before.
    runningDurableRow(piDir, "t-live-pid", 4242);
    // An SDK row is not this function's business and keeps pid semantics.
    upsertTaskSessionHistory(piDir, {
      id: "t-sdk", status: "running", background: true, backend: "sdk",
      agentType: "general", description: "sdk", sessionName: "task-t-sdk",
      startedAt: Date.now(), piDir, dir: join(piDir, "artifacts"),
      ownerSessionId: "sess-me", ownerPid: DEAD_PID,
    });

    const reconciled = await reconcileUnadmittedDurableTasks({
      piDir,
      sessionId: "sess-me",
      recoveredTaskIds: new Set(),
      databasePath,
      isProcessAlive: (pid) => pid === 4242,
      models: () => fauxModels(),
    });
    assert.deepEqual(reconciled, ["t-no-pid"], "only the owner-less durable row");
    const history = readTaskSessionHistory(piDir);
    assert.equal(history.find((e) => e.id === "t-live-pid")?.status, "running");
    assert.equal(history.find((e) => e.id === "t-sdk")?.status, "running", "SDK rows keep pid semantics");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Wiring site 3: lost-completion-notice replay ────────────────────────────

const NOW = 1_800_000_000_000;

function lostRow(overrides: Partial<TaskSessionHistoryEntry> = {}): TaskSessionHistoryEntry {
  return {
    id: "t-lost",
    agentType: "scout",
    description: "research",
    sessionName: "task-t-lost",
    startedAt: NOW - 60_000,
    piDir: "/pi",
    dir: "/pi/artifacts",
    status: "done",
    background: true,
    backend: "durable",
    ownerSessionId: "sess-1",
    ownerPid: DEAD_PID,
    completedAt: NOW - 30_000,
    ...overrides,
  } as TaskSessionHistoryEntry;
}

function findLost(
  history: TaskSessionHistoryEntry[],
  ownerLiveness?: (entry: TaskSessionHistoryEntry) => "alive" | "dead" | "unknown" | undefined,
) {
  return findLostCompletionNotices({
    history,
    sessionId: "sess-1",
    persisted: () => new Set(),
    now: NOW,
    isProcessAlive: () => false,
    ...(ownerLiveness !== undefined ? { ownerLiveness } : {}),
  });
}

test("a lost-notice candidate whose durable store a live process holds is left to that process", () => {
  // The pid says dead; the lock says a live process owns the store, so the
  // notice is that process's to deliver.
  assert.deepEqual(findLost([lostRow()], () => "alive"), []);
  // The same row with no second opinion replays, exactly as before.
  assert.deepEqual(findLost([lostRow()]).map((entry) => entry.id), ["t-lost"]);
});

test("a lost-notice candidate with a dead liveness verdict is replayed", () => {
  assert.deepEqual(findLost([lostRow()], () => "dead").map((entry) => entry.id), ["t-lost"]);
});

test("a terminal or SDK row never consults the durable liveness verdict", () => {
  for (const backend of ["sdk", "tmux", "herdr"] as const) {
    const consulted: string[] = [];
    assert.deepEqual(
      findLost([lostRow({ backend })], (entry) => {
        consulted.push(entry.id);
        return "alive";
      }).map((entry) => entry.id),
      ["t-lost"],
      `${backend} keeps pid-only semantics`,
    );
    assert.deepEqual(consulted, [], `${backend} is never probed`);
  }
});

test("the lost-notice liveness resolver probes a real held store and reports alive", async () => {
  const { root, piDir, databasePath } = fixture("pi-task-durable-liveness-lost-notice-");
  const holder = await holdStore(databasePath);
  try {
    const store = "durable/liveness.sqlite";
    mkdirSync(dirname(join(piDir, store)), { recursive: true });
    // The store the resolver probes is the one recorded on the row.
    writeFileSync(join(piDir, store), "");
    await kill(holder);
    const movedHolder = await holdStore(join(piDir, store));
    try {
      const history = [lostRow({ piDir, dir: join(piDir, "artifacts"), durableStore: store })];
      const verdicts = await resolveLostNoticeDurableLiveness({
        history,
        sessionId: "sess-1",
        piDir,
        now: NOW,
        isProcessAlive: () => false,
      });
      assert.equal(verdicts.get("t-lost"), "alive");
      // End to end: the replay list is empty because the owner was proved alive.
      assert.deepEqual(
        findLostCompletionNotices({
          history,
          sessionId: "sess-1",
          persisted: () => new Set(),
          now: NOW,
          isProcessAlive: () => false,
          ownerLiveness: (entry) => verdicts.get(entry.id),
        }),
        [],
      );
    } finally {
      await kill(movedHolder);
    }
  } finally {
    await kill(holder);
    rmSync(root, { recursive: true, force: true });
  }
});
