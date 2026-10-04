import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import {
  findJsonlSessionByName,
  readRegistry,
  updateRegistry,
  upsertTaskSessionHistory,
  writeRegistry,
} from "../conversation.js";
import {
  assessTaskResult,
  completionDeliveryOptions,
  parseResultXml,
  structuredResultPayload,
  unrecognizedStatusWarning,
  type ParsedResult,
} from "../helpers.js";
import { createSyncHerdrControl } from "../subagent/herdr.js";
import { killAgentPaneStrict } from "../subagent/tmux.js";
import { isStaleExtensionCtxError } from "../stale-ctx.js";
import type {
  BackgroundTask,
  CompletionDeliveryOutcome,
  RegistryEntry,
} from "../types.js";

function closeTaskResource(task: BackgroundTask): void {
  if (task.handle?.backend === "herdr") {
    if (
      task.handle.foregroundProcessGroupId === undefined
    ) {
      throw new Error("HerdR cleanup requires persisted agent identity");
    }
    createSyncHerdrControl().close(task.handle);
  } else if (task.paneId) {
    killAgentPaneStrict(task.paneId, task.originalPane);
  }
}

/**
 * Per-process idempotency guard: one execution completes at most once. A task
 * id may be intentionally reused by `resume`, so the execution start time is
 * part of the key rather than treating the durable id as globally unique.
 */
const completedTaskKeys = new Set<string>();

export function completionDeliveryId(id: string, startedAt: number): string {
  return `${id}\u0000${startedAt}`;
}

/**
 * Send one completion notice. Pi's `sendMessage` throws synchronously when the
 * extension ctx is stale after a session replacement; that is a deliberate
 * suppression, not a dispatch failure, so report it as `"suppressed"` for the
 * delivery queue. Any other error is a real failure the queue must retry.
 */
export function sendCompletionNotice(
  pi: Pick<ExtensionAPI, "sendMessage">,
  message: Parameters<ExtensionAPI["sendMessage"]>[0],
): CompletionDeliveryOutcome | void {
  try {
    pi.sendMessage(
      message,
      completionDeliveryOptions(process.env.PI_TASK_COMPLETION_DELIVERY),
    );
  } catch (error) {
    if (isStaleExtensionCtxError(error)) return "suppressed";
    throw error;
  }
}

export interface CompletionDeliveryQueue {
  enqueue(
    deliveryId: string,
    delivery: () => CompletionDeliveryOutcome | void,
    onPersisted?: () => void,
  ): void;
  acknowledgePersisted(deliveryId: string): void;
  hasPending(): boolean;
  pendingDeliveryIds(): readonly string[];
  cancelPending(deliveryId: string): boolean;
  setPersistedDeliveryIdsReader(
    reader:
      | ((pendingDeliveryIds: ReadonlySet<string>) => ReadonlySet<string>)
      | undefined,
  ): void;
  dispose(): void;
}

interface QueuedCompletionDelivery {
  deliveryId: string;
  deliver: () => CompletionDeliveryOutcome | void;
  attempts: number;
  nextAttemptAt: number;
  dispatched: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function persistedCompletionDeliveryId(entry: unknown): string | undefined {
  if (
    !isRecord(entry) ||
    entry.type !== "custom_message" ||
    entry.customType !== "task-complete" ||
    !isRecord(entry.details)
  ) {
    return undefined;
  }
  const deliveryId = entry.details.completion_delivery_id;
  return typeof deliveryId === "string" && deliveryId.length > 0
    ? deliveryId
    : undefined;
}

/** Test seam for the filesystem stat used to detect same-inode file mutation. */
export interface PersistedCompletionScannerOptions {
  fstat?: (fd: number) => {
    isFile(): boolean;
    size: bigint;
    dev: bigint;
    ino: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
  };
}

export type PersistedCompletionDeliveryScanner = (
  sessionPath: string | undefined,
  revalidateIds?: ReadonlySet<string>,
) => ReadonlySet<string>;

/** Scan Pi's append-only session JSONL and verify cached IDs after file mutation. */
export function createPersistedCompletionDeliveryScanner(
  options: PersistedCompletionScannerOptions = {},
): PersistedCompletionDeliveryScanner {
  const statFile = options.fstat ?? ((fd: number) => fstatSync(fd, { bigint: true }));
  interface PersistedDeliveryLine {
    offset: number;
    byteLength: number;
    digest: string;
  }

  const CHECKPOINT_BYTES = 256;
  let currentPath: string | undefined;
  let fileIdentity: string | undefined;
  let fileVersion: string | undefined;
  let offset = 0;
  let pendingStartOffset = 0;
  let pending = "";
  let decoder = new StringDecoder("utf8");
  let checkpoint: Uint8Array = new Uint8Array(0);
  const deliveryIds = new Set<string>();
  const persistedLines = new Map<string, PersistedDeliveryLine>();

  const reset = (sessionPath: string) => {
    currentPath = sessionPath;
    fileIdentity = undefined;
    fileVersion = undefined;
    offset = 0;
    pendingStartOffset = 0;
    pending = "";
    decoder = new StringDecoder("utf8");
    checkpoint = new Uint8Array(0);
    deliveryIds.clear();
    persistedLines.clear();
  };

  const digestRange = (
    fd: number,
    start: number,
    byteLength: number,
  ): string | undefined => {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let readOffset = 0;
    while (readOffset < byteLength) {
      const bytesRead = readSync(
        fd,
        buffer,
        0,
        Math.min(buffer.length, byteLength - readOffset),
        start + readOffset,
      );
      if (bytesRead === 0) return undefined;
      hash.update(buffer.subarray(0, bytesRead));
      readOffset += bytesRead;
    }
    return hash.digest("hex");
  };

  const readRange = (fd: number, start: number, byteLength: number): Buffer | undefined => {
    const buffer = Buffer.allocUnsafe(byteLength);
    let readOffset = 0;
    while (readOffset < byteLength) {
      const bytesRead = readSync(
        fd,
        buffer,
        readOffset,
        byteLength - readOffset,
        start + readOffset,
      );
      if (bytesRead === 0) return undefined;
      readOffset += bytesRead;
    }
    return buffer;
  };

  const hasPersistedLineBoundaries = (
    fd: number,
    persistedLine: PersistedDeliveryLine,
  ): boolean => {
    if (persistedLine.offset > 0) {
      const precedingByte = readRange(fd, persistedLine.offset - 1, 1);
      if (precedingByte?.[0] !== 0x0a) return false;
    }
    const followingByte = readRange(
      fd,
      persistedLine.offset + persistedLine.byteLength,
      1,
    );
    return followingByte?.[0] === 0x0a;
  };

  /** True when the cached line still matches the file bytes and both delimiters. */
  const isPersistedLineIntact = (
    fd: number,
    persistedLine: PersistedDeliveryLine,
  ): boolean =>
    digestRange(fd, persistedLine.offset, persistedLine.byteLength) ===
      persistedLine.digest && hasPersistedLineBoundaries(fd, persistedLine);

  const inspectLine = (line: string, lineOffset: number) => {
    if (
      !line.includes('"customType"') ||
      !line.includes('"completion_delivery_id"')
    ) {
      return;
    }
    try {
      const entry: unknown = JSON.parse(line);
      const deliveryId = persistedCompletionDeliveryId(entry);
      if (!deliveryId) return;
      deliveryIds.add(deliveryId);
      persistedLines.set(deliveryId, {
        offset: lineOffset,
        byteLength: Buffer.byteLength(line, "utf8"),
        digest: createHash("sha256").update(line, "utf8").digest("hex"),
      });
    } catch {
      // Ignore malformed lines; only a valid persisted custom entry can ack.
    }
  };

  return (sessionPath, revalidateIds) => {
    if (!sessionPath?.trim()) return new Set<string>();
    if (currentPath !== sessionPath) reset(sessionPath);

    let fd: number | undefined;
    try {
      fd = openSync(sessionPath, "r");
      const stats = statFile(fd);
      if (!stats.isFile() || stats.size > BigInt(Number.MAX_SAFE_INTEGER)) {
        return new Set<string>();
      }
      const size = Number(stats.size);
      const identity = `${stats.dev}:${stats.ino}`;
      if (fileIdentity !== undefined && fileIdentity !== identity) reset(sessionPath);
      fileIdentity = identity;
      if (size < offset) reset(sessionPath);

      if (checkpoint.length > 0 && offset >= checkpoint.length) {
        const currentTail = readRange(fd, offset - checkpoint.length, checkpoint.length);
        if (!currentTail?.equals(checkpoint)) reset(sessionPath);
      }
      const version = `${stats.mtimeNs}:${stats.ctimeNs}`;
      if (fileVersion !== undefined && fileVersion !== version) {
        for (const persistedLine of persistedLines.values()) {
          if (!isPersistedLineIntact(fd, persistedLine)) {
            reset(sessionPath);
            break;
          }
        }
      }
      // Re-read the caller's pending entries even when the timestamps look
      // unchanged: a same-size in-place rewrite inside one coarse timestamp
      // tick would otherwise leave a stale ID acknowledged. The cost stays
      // proportional to the pending notices, not the whole cache.
      if (revalidateIds !== undefined && revalidateIds.size > 0) {
        for (const deliveryId of revalidateIds) {
          const persistedLine = persistedLines.get(deliveryId);
          if (persistedLine && !isPersistedLineIntact(fd, persistedLine)) {
            reset(sessionPath);
            break;
          }
        }
      }
      fileIdentity = identity;
      fileVersion = version;

      const buffer = Buffer.allocUnsafe(64 * 1024);
      while (offset < size) {
        const bytesRead = readSync(
          fd,
          buffer,
          0,
          Math.min(buffer.length, size - offset),
          offset,
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
        pending += decoder.write(buffer.subarray(0, bytesRead));
        let newline = pending.indexOf("\n");
        while (newline !== -1) {
          const lineWithNewline = pending.slice(0, newline + 1);
          const line = pending.slice(0, newline);
          inspectLine(line, pendingStartOffset);
          pendingStartOffset += Buffer.byteLength(lineWithNewline, "utf8");
          pending = pending.slice(newline + 1);
          newline = pending.indexOf("\n");
        }
      }
      const checkpointLength = Math.min(CHECKPOINT_BYTES, offset);
      checkpoint = checkpointLength === 0
        ? new Uint8Array(0)
        : readRange(fd, offset - checkpointLength, checkpointLength) ?? new Uint8Array(0);
    } catch {
      // A cached ID is not current persistence evidence when this read failed.
      return new Set<string>();
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // Read errors are handled above; close is best effort.
        }
      }
    }
    return deliveryIds;
  };
}

/** Acknowledge only IDs found in persisted custom session entries. */
export function acknowledgePersistedCompletionDeliveries(
  queue: CompletionDeliveryQueue,
  entries: readonly unknown[],
): void {
  for (const entry of entries) {
    const deliveryId = persistedCompletionDeliveryId(entry);
    if (deliveryId) queue.acknowledgePersisted(deliveryId);
  }
}

/**
 * Debounce completion notifications so several tasks settling in one polling
 * window do not each independently interrupt the parent session.
 */
export function createCompletionDeliveryQueue(windowMs = 200): CompletionDeliveryQueue {
  const initialWindowMs = Math.max(0, windowMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let persistenceTimer: ReturnType<typeof setTimeout> | undefined;
  let persistedDeliveryIdsReader:
    | ((pendingDeliveryIds: ReadonlySet<string>) => ReadonlySet<string>)
    | undefined;
  const pending = new Map<string, QueuedCompletionDelivery>();
  const persistedCallbacks = new Map<string, () => void>();
  let flush: () => void = () => {};

  const acknowledgePersisted = (deliveryId: string) => {
    if (!pending.delete(deliveryId)) return;
    const onPersisted = persistedCallbacks.get(deliveryId);
    persistedCallbacks.delete(deliveryId);
    try {
      onPersisted?.();
    } catch {
      // Persistence callbacks cannot block unrelated completion notices.
    }
  };

  const scanPersistedDeliveries = () => {
    if (!persistedDeliveryIdsReader || pending.size === 0) return;
    try {
      // Pass the pending IDs so the scanner can re-read exactly those entries
      // even when the file's timestamps look unchanged.
      for (const deliveryId of persistedDeliveryIdsReader(new Set(pending.keys()))) {
        if (pending.has(deliveryId)) acknowledgePersisted(deliveryId);
      }
    } catch {
      // A temporary read failure must not release the session guard.
    }
  };

  const cancelPending = (deliveryId: string): boolean => {
    if (!pending.delete(deliveryId)) return false;
    persistedCallbacks.delete(deliveryId);
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (persistenceTimer !== undefined && pending.size === 0) {
      clearTimeout(persistenceTimer);
      persistenceTimer = undefined;
    }
    scheduleDeliveryFlush();
    return true;
  };

  function scheduleDeliveryFlush(): void {
    if (timer !== undefined) return;
    const retryable = [...pending.values()].filter((delivery) => !delivery.dispatched);
    if (retryable.length === 0) return;
    const nextAttemptAt = Math.min(...retryable.map((delivery) => delivery.nextAttemptAt));
    timer = setTimeout(flush, Math.max(0, nextAttemptAt - Date.now()));
    timer.unref?.();
  }

  const schedulePersistenceCheck = () => {
    if (persistenceTimer !== undefined || pending.size === 0 || !persistedDeliveryIdsReader) {
      return;
    }
    persistenceTimer = setTimeout(() => {
      persistenceTimer = undefined;
      scanPersistedDeliveries();
      schedulePersistenceCheck();
    }, 25);
    persistenceTimer.unref?.();
  };

  flush = () => {
    timer = undefined;
    // A replay may already be present in the saved JSONL after a crash that
    // occurred between Pi's append and our acknowledgement callback.
    scanPersistedDeliveries();
    const now = Date.now();
    for (const delivery of [...pending.values()]) {
      if (delivery.dispatched || delivery.nextAttemptAt > now) continue;
      try {
        const outcome = delivery.deliver();
        if (outcome === "suppressed") {
          cancelPending(delivery.deliveryId);
          continue;
        }
        delivery.dispatched = true;
      } catch {
        delivery.attempts += 1;
        const delay = Math.min(5_000, 50 * 2 ** Math.min(delivery.attempts - 1, 7));
        delivery.nextAttemptAt = Date.now() + delay;
      }
    }
    scheduleDeliveryFlush();
    schedulePersistenceCheck();
  };

  return {
    enqueue(deliveryId, deliver, onPersisted) {
      if (!deliveryId.trim() || pending.has(deliveryId)) return;
      pending.set(deliveryId, {
        deliveryId,
        deliver,
        attempts: 0,
        nextAttemptAt: Date.now() + initialWindowMs,
        dispatched: false,
      });
      if (onPersisted) persistedCallbacks.set(deliveryId, onPersisted);
      scheduleDeliveryFlush();
      schedulePersistenceCheck();
    },
    acknowledgePersisted,
    hasPending() {
      return pending.size > 0;
    },
    pendingDeliveryIds() {
      return [...pending.keys()];
    },
    cancelPending,
    setPersistedDeliveryIdsReader(reader) {
      persistedDeliveryIdsReader = reader;
      scanPersistedDeliveries();
      schedulePersistenceCheck();
    },
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      if (persistenceTimer !== undefined) clearTimeout(persistenceTimer);
      timer = undefined;
      persistenceTimer = undefined;
      pending.clear();
      persistedCallbacks.clear();
      persistedDeliveryIdsReader = undefined;
    },
  };
}

export type CompletionPhase = "done" | "cancelled" | "timeout" | "failed";

export type ComparisonSettledHook = (
  id: string,
  task: BackgroundTask,
  parsed: ParsedResult,
  phase: CompletionPhase,
) => boolean;

export interface CompleteTaskOptions {
  pi: ExtensionAPI;
  id: string;
  task: BackgroundTask;
  content: string;
  phase: CompletionPhase;
  piDir: string;
  resourceCloser?: (task: BackgroundTask) => void;
  deliveryGuard?: () => boolean;
  onComparisonSettled?: ComparisonSettledHook;
  writeRegistryFn?: (piDir: string, entries: RegistryEntry[]) => void;
  deliveryQueue?: CompletionDeliveryQueue;
}

export function completeTask({
  pi,
  id,
  task,
  content,
  phase,
  piDir,
  resourceCloser = closeTaskResource,
  deliveryGuard,
  onComparisonSettled,
  writeRegistryFn = writeRegistry,
  deliveryQueue,
}: CompleteTaskOptions): { cleanupSucceeded: boolean } {
  const key = completionDeliveryId(id, task.startedAt);
  if (completedTaskKeys.has(key)) {
    // Already fully processed in this process: never re-deliver or re-close.
    return { cleanupSucceeded: true };
  }
  const parsed = parseResultXml(content);
  const assessment = assessTaskResult(parsed);
  const durationMs = Date.now() - task.startedAt;
  // Record the terminal phase on the live task so panel rows (and the
  // finished-linger) render the correct status/icon instead of defaulting
  // failed/timeout/cancelled to a green "done".
  task.status = phase;
  // Discover by task id, never session name: probe roots are id-scoped, so
  // a session-name collision cannot stamp another task's transcript here.
  const completedSessionRef = findJsonlSessionByName(
    piDir,
    id,
    task.agentType,
  )?.sessionRef;

  const allEntries = readRegistry(piDir);
  const priorEntry = allEntries.find((entry) => entry.id === id);
  const entries = allEntries.filter((entry) => entry.id !== id);
  const cleanupEntry: RegistryEntry = {
    id,
    agentType: task.agentType,
    description: task.description,
    sessionName: task.sessionName,
    runtime: task.runtime,
    ...(task.claudeSessionId !== undefined
      ? { claudeSessionId: task.claudeSessionId }
      : {}),
    startedAt: task.startedAt,
    handle: task.handle,
    paneId: task.paneId,
    piDir,
    dir: task.dir,
    cwd: task.cwd,
    conversationId: task.conversationId,
    sessionRef: completedSessionRef,
    cleanupPending: true,
    cleanupPhase: phase,
    comparisonGroupId: task.comparisonGroupId,
    comparisonModel: task.comparisonModel,
    comparisonDescription: task.comparisonDescription,
    comparisonIndex: task.comparisonIndex,
    comparisonDelivered: task.comparisonDelivered,
    ...(task.comparisonPartialDelivered !== undefined ||
    priorEntry?.comparisonPartialDelivered !== undefined
      ? {
          comparisonPartialDelivered:
            task.comparisonPartialDelivered ?? priorEntry?.comparisonPartialDelivered,
        }
      : {}),
    ...(task.ownerSessionId !== undefined || priorEntry?.ownerSessionId !== undefined
      ? { ownerSessionId: task.ownerSessionId ?? priorEntry?.ownerSessionId }
      : {}),
    ...(task.ownerLeafId !== undefined || priorEntry?.ownerLeafId !== undefined
      ? {
          ownerLeafId:
            task.ownerLeafId !== undefined ? task.ownerLeafId : priorEntry?.ownerLeafId,
        }
      : {}),
    ...(priorEntry?.ownerPid !== undefined ? { ownerPid: priorEntry.ownerPid } : {}),
  };
  // Keep a terminal cleanup receipt durable across a crash between the
  // state write and backend close. Restore retries it and removes it only
  // after close succeeds. This write runs BEFORE the history upsert: if the
  // registry is unreadable, no terminal phase is recorded at all, so a
  // poll-error retry can never rewrite a recorded done/timeout as failed.
  if (writeRegistryFn === writeRegistry) {
    updateRegistry(piDir, (currentEntries) => {
      const currentEntry = currentEntries.find((entry) => entry.id === id);
      const ownerSessionId = currentEntry?.ownerSessionId ?? priorEntry?.ownerSessionId;
      const ownerLeafId =
        currentEntry?.ownerLeafId !== undefined
          ? currentEntry.ownerLeafId
          : priorEntry?.ownerLeafId;
      const ownerPid = currentEntry?.ownerPid ?? priorEntry?.ownerPid;
      return [
        ...currentEntries.filter((entry) => entry.id !== id),
        {
          ...cleanupEntry,
          ...(ownerSessionId !== undefined ? { ownerSessionId } : {}),
          ...(ownerLeafId !== undefined ? { ownerLeafId } : {}),
          ...(ownerPid !== undefined ? { ownerPid } : {}),
        },
      ];
    });
  } else {
    writeRegistryFn(piDir, [...entries, cleanupEntry]);
  }

  upsertTaskSessionHistory(piDir, {
    id,
    agentType: task.agentType,
    description: task.description,
    sessionName: task.sessionName,
    runtime: task.runtime,
    ...(task.claudeSessionId !== undefined
      ? { claudeSessionId: task.claudeSessionId }
      : {}),
    startedAt: task.startedAt,
    paneId: task.paneId,
    handle: task.handle,
    piDir,
    dir: task.dir,
    cwd: task.cwd,
    conversationId: task.conversationId,
    sessionRef: completedSessionRef,
    status: phase,
    reportedStatus: assessment.reportedStatus,
    rawStatus: assessment.rawStatus,
    resultValid: assessment.valid,
    completedAt: Date.now(),
    background: true,
    comparisonGroupId: task.comparisonGroupId,
    comparisonModel: task.comparisonModel,
    comparisonDescription: task.comparisonDescription,
    comparisonIndex: task.comparisonIndex,
    comparisonDelivered: task.comparisonDelivered,
    ...(task.comparisonPartialDelivered !== undefined ||
    priorEntry?.comparisonPartialDelivered !== undefined
      ? {
          comparisonPartialDelivered:
            task.comparisonPartialDelivered ?? priorEntry?.comparisonPartialDelivered,
        }
      : {}),
    ...(task.ownerSessionId !== undefined || priorEntry?.ownerSessionId !== undefined
      ? { ownerSessionId: task.ownerSessionId ?? priorEntry?.ownerSessionId }
      : {}),
    ...(task.ownerLeafId !== undefined || priorEntry?.ownerLeafId !== undefined
      ? {
          ownerLeafId:
            task.ownerLeafId !== undefined ? task.ownerLeafId : priorEntry?.ownerLeafId,
        }
      : {}),
    ...(priorEntry?.ownerPid !== undefined ? { ownerPid: priorEntry.ownerPid } : {}),
  });

  let cleanupSucceeded = true;
  try {
    resourceCloser(task);
  } catch {
    cleanupSucceeded = false;
  }
  // Terminal state is durable and the resource is closed (or its close is
  // recorded as pending): mark settled BEFORE the best-effort removal write
  // so a failed removal can never trigger a retry that re-closes a resource
  // (herdr close is not idempotent).
  completedTaskKeys.add(key);
  if (cleanupSucceeded) {
    try {
      if (writeRegistryFn === writeRegistry) {
        updateRegistry(piDir, (currentEntries) =>
          currentEntries.filter((entry) => entry.id !== id),
        );
      } else {
        writeRegistryFn(piDir, entries);
      }
    } catch {
      // The cleanupPending receipt written above stays durable and restore
      // retries cleanup (missing panes are tolerated and clear the receipt).
    }
  }

  const summaryText = parsed.summary?.trim()
    ? parsed.summary.trim()
    : content.replace(/\s+/g, " ").trim().slice(0, 240);
  const warning = unrecognizedStatusWarning(assessment);

  if (onComparisonSettled && onComparisonSettled(id, task, parsed, phase)) {
    return { cleanupSucceeded };
  }

  // pi-subtask delivery-guard pattern: skip the in-conversation result
  // when the conversation that spawned the task is no longer the one we
  // are in. The result stays durable in task-session history and the
  // child session file either way.
  if (deliveryGuard && !deliveryGuard()) {
    return { cleanupSucceeded };
  }

  const deliver = (): CompletionDeliveryOutcome | void => {
    if (deliveryGuard && !deliveryGuard()) return "suppressed";
    return sendCompletionNotice(pi, {
      customType: "task-complete",
      content: `Background task ${id} (${task.agentType}) ${phase}.\n\n${warning ? warning + "\n\n" : ""}${summaryText}`,
      display: true,
      details: {
        task_id: id,
        agent_type: task.agentType,
        description: task.description,
        phase,
        execution_phase: phase,
        status: assessment.reportedStatus,
        reported_status: assessment.reportedStatus,
        raw_status: assessment.rawStatus,
        result_valid: assessment.valid,
        result: content,
        summary: parsed.summary,
        findings: parsed.findings,
        evidence: parsed.evidence,
        files: parsed.files,
        caveats: parsed.caveats,
        next_steps: parsed.next_steps,
        confidence: parsed.confidence,
        duration_ms: durationMs,
        tool_uses: task.toolUses,
        turn_count: task.turns,
        background: true,
        structured_result: structuredResultPayload(assessment),
        full_output: parsed.raw.trim() || content.trim(),
        completion_delivery_id: key,
      },
    });
  };
  if (deliveryQueue) deliveryQueue.enqueue(key, deliver);
  else deliver();

  return { cleanupSucceeded };
}
