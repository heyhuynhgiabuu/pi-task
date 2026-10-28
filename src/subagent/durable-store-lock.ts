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

export class DurableStoreLockedError extends Error {
  constructor(
    readonly databasePath: string,
    readonly holderPid: number | undefined,
  ) {
    super(
      `Durable task store ${databasePath} is owned by another Pi process` +
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

async function listenExclusively(key: string): Promise<HeldLock> {
  const hash = createHash("sha256").update(`pi-task-durable:${key}`).digest("hex").slice(0, 32);
  const usesFile = process.platform !== "win32" && process.platform !== "linux" && process.platform !== "android";
  const address = process.platform === "win32"
    ? `\\\\.\\pipe\\pi-task-durable-${hash}`
    : usesFile
      ? socketFilePath(key, hash)
      : `\0pi-task-durable-${hash}`;
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
