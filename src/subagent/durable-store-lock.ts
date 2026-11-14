/**
 * One Pi process owns a durable store at a time.
 *
 * pi-durable has no cross-process locking ("One process owns a storage at a
 * time"): its scheduler reservations are in memory, so a second process that
 * opens the same SQLite file resumes — and reruns — work the first process is
 * still running. This lock is taken before the storage is opened and held for
 * the harness's lifetime (in practice, until the process exits).
 *
 * Same technique as chord's `processLock`: an abstract socket (Linux) or named
 * pipe (Windows) vanishes with its process; elsewhere a socket file nobody
 * accepts on is stale and taken over. Unlike `processLock`, the server is
 * unref'd so holding the lock never keeps the process alive, it answers probes
 * with the holder's pid so the error can name it, and the socket file lives
 * next to the store (never under TMPDIR, which differs between processes).
 * Locks are re-entrant within one process (counted), because a harness can be
 * reopened while the previous instance is still closing.
 */

import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { basename, dirname, join } from "node:path";

import { isProcessAliveOrUnknown } from "../process.js";

export class DurableStoreLockedError extends Error {
  constructor(
    readonly databasePath: string,
    readonly holderPid: number | undefined,
  ) {
    super(
      holderPid === process.pid
        ? // The holder is this very process, so another instance of this module holds the store.
          // Probed with Pi 1.4.0's jiti (not with a live /reload): an ESM `.js` file in a
          // `"type": "module"` package, which is how pi-task is published (`dist/index.js`), is
          // handed to Node's native `import()`, so a `/reload` of the same path returns the module
          // Node already has and the lock registry and harness cache survive it; the lock is
          // re-entrant and this branch is not reached. A TypeScript-source load (`-e src/index.ts`)
          // is re-run on every reload and does reach it. So does a separate copy at another path:
          // the package installed from two places (npm and a local path) or its source switched
          // in settings. The refusal is deliberate: a second harness on the same store would treat
          // the running turn as interrupted and run it again.
          `Durable task store ${databasePath} is held by another copy of pi-task loaded in this process, ` +
            "most likely from a different location (for example after the package source was changed in settings " +
            "and reloaded). A reload cannot hand a store between two copies. If pi-task is listed twice in settings, " +
            "remove one entry, then restart Pi to use the durable backend again. To run new tasks without durable now: " +
            "set \"taskBackend\": \"sdk\" in settings and /reload, or start Pi with PI_TASK_BACKEND=sdk " +
            "(the environment variable wins over the setting); a durable task that already exists stays on durable."
        : `Durable task store ${databasePath} is owned by another Pi process` +
            `${holderPid !== undefined ? ` (pid ${holderPid})` : ""}. ` +
            "Only one Pi process can own a durable store at a time, and it keeps the store until it exits; " +
            "exit that Pi process or use another backend (PI_TASK_BACKEND=sdk).",
    );
    this.name = "DurableStoreLockedError";
  }
}

export function isDurableStoreLockedError(error: unknown): error is DurableStoreLockedError {
  return error instanceof Error && error.name === "DurableStoreLockedError";
}

type HeldLock = { server: Server; socketFile?: string };
type HeldEntry = { users: number; ready: Promise<HeldLock> };

const held = new Map<string, HeldEntry>();

/** Socket files of held locks, removed on exit (`close()` never runs then). */
const socketFiles = new Set<string>();
let exitHandlerInstalled = false;

function removeSocketFilesOnExit(): void {
  for (const file of socketFiles) {
    try {
      unlinkSync(file);
    } catch {
      // Already gone.
    }
  }
}

/** Lock `databasePath` for this process; resolves to an idempotent release. */
export async function acquireDurableStoreLock(databasePath: string): Promise<() => void> {
  const directory = dirname(databasePath);
  mkdirSync(directory, { recursive: true });
  const key = join(realpathSync(directory), basename(databasePath));

  let entry = held.get(key);
  if (!entry) {
    const created: HeldEntry = { users: 0, ready: listenExclusively(key) };
    created.ready.catch(() => {
      if (held.get(key) === created) held.delete(key);
    });
    held.set(key, created);
    entry = created;
  }
  // Concurrent acquires in this process share one listen attempt.
  entry.users++;
  let lock: HeldLock;
  try {
    lock = await entry.ready;
  } catch (error) {
    entry.users--;
    throw error;
  }
  const acquired = entry;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    acquired.users--;
    if (acquired.users > 0 || held.get(key) !== acquired) return;
    held.delete(key);
    if (lock.socketFile) socketFiles.delete(lock.socketFile);
    lock.server.close();
  };
}

function lockHash(key: string): string {
  return createHash("sha256").update(`pi-task-durable:${key}`).digest("hex").slice(0, 32);
}

/** Whether the lock of this platform survives as a socket file (else abstract/pipe). */
const LOCKS_WITH_SOCKET_FILE =
  process.platform !== "win32" && process.platform !== "linux" && process.platform !== "android";

function lockAddress(key: string, hash: string): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\pi-task-durable-${hash}`
    : LOCKS_WITH_SOCKET_FILE
      ? socketFilePath(key, hash)
      : `\0pi-task-durable-${hash}`;
}

async function listenExclusively(key: string): Promise<HeldLock> {
  const hash = lockHash(key);
  const usesFile = LOCKS_WITH_SOCKET_FILE;
  const address = lockAddress(key, hash);
  const server = createServer((socket) => {
    socket.end(JSON.stringify({ pid: process.pid }));
  });
  try {
    await listen(server, address);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    const holder = await probeHolder(address);
    if (!usesFile || holder.alive) throw new DurableStoreLockedError(key, holder.pid);
    await takeOverStaleSocket(server, address, key);
  }
  server.unref();
  if (!usesFile) return { server };
  socketFiles.add(address);
  if (!exitHandlerInstalled) {
    exitHandlerInstalled = true;
    process.once("exit", removeSocketFilesOnExit);
  }
  return { server, socketFile: address };
}

/** A guard older than this was left by a process that died mid-takeover. */
const STALE_TAKEOVER_MS = 10_000;

/**
 * Replace a stale socket file. Deciding it is stale and deleting it happen
 * under an exclusive guard file, re-probing first: otherwise two processes
 * that both saw it stale could each delete the other's fresh socket.
 */
async function takeOverStaleSocket(server: Server, address: string, key: string): Promise<void> {
  const guard = `${address}.takeover`;
  try {
    writeFileSync(guard, String(process.pid), { flag: "wx" });
  } catch {
    try {
      if (Date.now() - statSync(guard).mtimeMs > STALE_TAKEOVER_MS) rmSync(guard, { force: true });
    } catch {
      // The other process finished its takeover meanwhile.
    }
    throw new DurableStoreLockedError(key, undefined);
  }
  try {
    const holder = await probeHolder(address);
    if (holder.alive) throw new DurableStoreLockedError(key, holder.pid);
    rmSync(address, { force: true });
    try {
      await listen(server, address);
    } catch (error) {
      // Another process bound the freed path first: it owns the store now.
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
        throw new DurableStoreLockedError(key, undefined);
      }
      throw error;
    }
  } finally {
    rmSync(guard, { force: true });
  }
}

function listen(server: Server, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(address, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

/** sun_path holds 104 bytes on macOS and the BSDs, including the NUL. */
const MAX_SOCKET_PATH_BYTES = 103;

/** Next to the store when it fits sun_path, else a fixed per-user directory. */
function socketFilePath(key: string, hash: string): string {
  const preferred = `${key}.lock`;
  if (Buffer.byteLength(preferred) <= MAX_SOCKET_PATH_BYTES) return preferred;
  const directory = `/tmp/pi-task-${process.getuid?.() ?? 0}`;
  mkdirSync(directory, { mode: 0o700, recursive: true });
  return join(directory, `durable-${hash}.lock`);
}

/** What the store's lock socket answered, or `undefined` when it said nothing. */
export type DurableLockHolder = { alive: boolean; pid?: number };

/**
 * What the store lock proves about a durable row's owner process. `unknown`
 * means neither signal could decide, so the caller keeps its own semantics.
 */
export type DurableOwnerLiveness = "alive" | "dead" | "unknown";

/**
 * Probe a durable store's lock without acquiring it. A holder that accepts a
 * connection proves a live process owns the store; `alive: false` means the
 * lock is free (the owner never took it, or left it stale). `undefined` means
 * the probe could not speak — no lock address (a missing/unresolvable store
 * directory) or a probe that threw — so the caller must fall back to the pid.
 */
export async function probeDurableStoreHolder(
  databasePath: string,
): Promise<DurableLockHolder | undefined> {
  try {
    const directory = dirname(databasePath);
    const key = join(realpathSync(directory), basename(databasePath));
    return await probeHolder(lockAddress(key, lockHash(key)));
  } catch {
    // An unreadable directory or a failed probe is no evidence either way.
    return undefined;
  }
}

/**
 * Combine one store's lock probe with a row's recorded pid into a single
 * liveness verdict. Pure, so a caller that has many rows in one store probes
 * the lock once and decides each row from it.
 *
 * The lock outranks the pid, which is the point: a pid is recycled, so after a
 * reboot a dead owner's pid can name an unrelated live process, and a live
 * owner's recorded pid can look dead. Only the lock states who owns the store
 * now:
 *
 * - the row's pid is this process: `alive` — it is ours.
 * - a foreign live process holds the store: `alive`, whatever the pid says.
 * - this process holds the store: the pid decides. Our own hold says nothing
 *   about a foreign row's owner (we took the store for our own work), and
 *   calling such a row alive would block its recovery forever.
 * - the lock is free: the pid decides — the owner may be alive and between
 *   taking its receipt and opening the store, so a free lock is not proof of
 *   death on its own.
 * - no pid at all: `unknown`, leaving each caller's existing absent-pid rule in
 *   charge (those rules are conservative; this must not loosen them).
 *
 * `unknown` therefore only ever arises from an absent pid, and a probe that
 * could not speak leaves the pid as the only signal, exactly as before.
 */
export function durableOwnerLivenessOf(input: {
  /** The store's lock probe, or undefined when the lock could not be probed. */
  holder: DurableLockHolder | undefined;
  /** The pid recorded with the row; absent means it was never recorded. */
  ownerPid?: number | undefined;
  /** Pid probe, so callers keep their own seam (and tests their stub). */
  isProcessAlive?: (pid: number) => boolean;
  /** The deciding process; overridden by tests that simulate another one. */
  selfPid?: number;
}): DurableOwnerLiveness {
  const selfPid = input.selfPid ?? process.pid;
  if (input.ownerPid === undefined) return "unknown";
  if (input.ownerPid === selfPid) return "alive";
  if (input.holder?.alive === true && input.holder.pid !== selfPid) return "alive";
  return (input.isProcessAlive ?? isProcessAliveOrUnknown)(input.ownerPid) ? "alive" : "dead";
}

/**
 * Is the process that owns a durable task's row still alive? Probes the store's
 * lock (a live foreign holder is proof of life) and falls back to the pid. See
 * {@link durableOwnerLivenessOf} for the precedence, and prefer probing once per
 * store when a caller decides many rows.
 *
 * Best-effort by construction: an unknown store path or a throwing probe leaves
 * today's pid behaviour untouched, and non-durable rows never reach this.
 */
export async function durableOwnerLiveness(input: {
  /** Absolute store path; unknown means the lock cannot speak. */
  databasePath?: string | undefined;
  ownerPid?: number | undefined;
  isProcessAlive?: (pid: number) => boolean;
  selfPid?: number;
}): Promise<DurableOwnerLiveness> {
  const holder = input.databasePath === undefined
    ? undefined
    : await probeDurableStoreHolder(input.databasePath);
  return durableOwnerLivenessOf({ ...input, holder });
}

/** Connect to the lock socket: accepted means a live holder. */
function probeHolder(address: string): Promise<{ alive: boolean; pid?: number }> {
  return new Promise((resolve) => {
    let data = "";
    let accepted = false;
    const socket = connect(address);
    const finish = (result: { alive: boolean; pid?: number }) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    // A holder that accepts but never answers is still alive.
    const timer = setTimeout(() => finish({ alive: true }), 1000);
    socket.on("connect", () => {
      accepted = true;
    });
    socket.on("data", (chunk) => {
      data += chunk.toString();
    });
    socket.on("end", () => {
      let pid: number | undefined;
      try {
        const parsed = JSON.parse(data) as { pid?: unknown };
        if (typeof parsed.pid === "number") pid = parsed.pid;
      } catch {
        // A holder that answers garbage is still a holder.
      }
      finish({ alive: true, pid });
    });
    socket.on("error", () => finish({ alive: accepted }));
  });
}
