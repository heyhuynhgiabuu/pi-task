/**
 * Best-effort, atomic, throttled JSON snapshot writer for durable child
 * transcripts. The detached `rex-view` process tails this file instead of
 * opening a socket or reading SQLite directly.
 */

import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ChildUsageMetadata } from "./child-metadata.js";
import type { DurableChildAgent } from "./durable-transcript.js";
import type { TranscriptItem } from "./transcript.js";
import type { BackgroundTask } from "../types.js";

export const LIVE_SNAPSHOT_FILENAME = "live-transcript.json";
export const LIVE_SNAPSHOT_THROTTLE_MS = 200;
/** `write` and `edit` arguments carry whole files; the mirror prints 120 characters of them. */
const LIVE_SNAPSHOT_MAX_ARG_CHARS = 4_000;

export interface LiveTranscriptSnapshot {
  version: 1;
  taskId: string;
  agentType: string;
  description: string;
  status: string;
  revision: number;
  updatedAt: number;
  cwd?: string;
  model?: string;
  /** Pid of the parent Pi process, so the viewer can tell when it exited. */
  ownerPid?: number;
  items: TranscriptItem[];
}

export function liveSnapshotPath(taskDir: string, taskId: string): string {
  return join(taskDir, "sessions", taskId, LIVE_SNAPSHOT_FILENAME);
}

export function buildLiveSnapshot(
  taskId: string,
  // `finished` is a snapshot-only status for an outcome pi-task never recorded.
  task: Pick<BackgroundTask, "agentType" | "description" | "cwd"> & { status?: string },
  items: readonly TranscriptItem[],
  revision: number,
  agent?: DurableChildAgent,
  metadata?: ChildUsageMetadata,
  updatedAt = Date.now(),
  ownerPid?: number,
): LiveTranscriptSnapshot {
  const model = agent?.model ?? metadata?.model;
  return {
    version: 1,
    taskId,
    agentType: task.agentType,
    description: task.description,
    status: task.status ?? "running",
    revision,
    updatedAt,
    ...(task.cwd ? { cwd: task.cwd } : {}),
    ...(model ? { model } : {}),
    ...(ownerPid === undefined ? {} : { ownerPid }),
    items: items.map(capSnapshotItemArgs),
  };
}

function capSnapshotItemArgs(item: TranscriptItem): TranscriptItem {
  if (item.type !== "tool") return item;
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item.args ?? {})) {
    args[key] =
      typeof value === "string" && value.length > LIVE_SNAPSHOT_MAX_ARG_CHARS
        ? `${value.slice(0, LIVE_SNAPSHOT_MAX_ARG_CHARS)}… (+${value.length - LIVE_SNAPSHOT_MAX_ARG_CHARS} chars)`
        : value;
  }
  return { ...item, args };
}

let tempSeq = 0;

function writeAtomicJsonBestEffort(filePath: string, data: unknown): void {
  const tmpPath = `${filePath}.tmp-${process.pid}-${++tempSeq}`;
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(tmpPath, JSON.stringify(data), "utf8");
    renameSync(tmpPath, filePath);
  } catch {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup; never throw into the task execution path.
    }
  }
}

interface WriterEntry {
  lastWriteAt?: number;
  pending?: LiveTranscriptSnapshot;
  timer?: ReturnType<typeof setTimeout>;
}

export interface LiveSnapshotWriterOptions {
  throttleMs?: number;
  now?: () => number;
  writeAtomic?: (filePath: string, snapshot: LiveTranscriptSnapshot) => void;
}

export class LiveSnapshotWriter {
  private readonly throttleMs: number;
  private readonly now: () => number;
  private readonly writeAtomic: (filePath: string, snapshot: LiveTranscriptSnapshot) => void;
  private readonly entries = new Map<string, WriterEntry>();

  constructor(options: LiveSnapshotWriterOptions = {}) {
    this.throttleMs = options.throttleMs ?? LIVE_SNAPSHOT_THROTTLE_MS;
    this.now = options.now ?? (() => Date.now());
    this.writeAtomic = options.writeAtomic ?? writeAtomicJsonBestEffort;
  }

  /** Stop tracking a path: a pending trailing write is cancelled and never lands. */
  forget(filePath: string): void {
    const entry = this.entries.get(filePath);
    if (!entry) return;
    this.clearTimer(entry);
    entry.pending = undefined;
    this.entries.delete(filePath);
  }

  schedule(filePath: string, snapshot: LiveTranscriptSnapshot): void {
    let entry = this.entries.get(filePath);
    if (!entry) {
      entry = {};
      this.entries.set(filePath, entry);
    }
    const current = this.now();
    const elapsed = entry.lastWriteAt === undefined ? this.throttleMs : current - entry.lastWriteAt;
    if (elapsed >= this.throttleMs) {
      this.clearTimer(entry);
      entry.pending = undefined;
      this.writeNow(filePath, entry, snapshot, current);
      return;
    }
    entry.pending = snapshot;
    if (!entry.timer) {
      const waitMs = Math.max(0, this.throttleMs - elapsed);
      entry.timer = setTimeout(() => {
        entry.timer = undefined;
        const pending = entry.pending;
        entry.pending = undefined;
        if (pending) {
          this.writeNow(filePath, entry, pending, this.now());
        }
      }, waitMs);
      entry.timer.unref?.();
    }
  }

  flush(filePath: string, snapshot: LiveTranscriptSnapshot): void {
    let entry = this.entries.get(filePath);
    if (!entry) {
      entry = {};
      this.entries.set(filePath, entry);
    }
    this.clearTimer(entry);
    entry.pending = undefined;
    this.writeNow(filePath, entry, snapshot, this.now());
  }

  flushPending(filePath: string): void {
    const entry = this.entries.get(filePath);
    if (!entry?.pending) return;
    const pending = entry.pending;
    entry.pending = undefined;
    this.clearTimer(entry);
    this.writeNow(filePath, entry, pending, this.now());
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      this.clearTimer(entry);
      entry.pending = undefined;
    }
    this.entries.clear();
  }

  private clearTimer(entry: WriterEntry): void {
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
  }

  private writeNow(
    filePath: string,
    entry: WriterEntry,
    snapshot: LiveTranscriptSnapshot,
    timestamp: number,
  ): void {
    entry.lastWriteAt = timestamp;
    try {
      this.writeAtomic(filePath, snapshot);
    } catch {
      // Never throw into the caller even if an injected writer throws.
    }
  }
}
