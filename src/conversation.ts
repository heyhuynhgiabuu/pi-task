import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isTerminalHandle, type TerminalHandle } from "./subagent/terminalBackend.js";
import type { RegistryEntry, TaskSessionHistoryEntry } from "./types.js";

const ARTIFACTS_DIR = "artifacts";
const TASK_SESSIONS_REGISTRY = "task-sessions.json";
const TASK_REGISTRY = "task-registry.json";
const TASK_SESSION_HISTORY = "task-session-history.json";

export interface TaskSessionRegistryEntry {
  task_id: string;
  updated_at: string;
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function readJsonFile<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback;
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
    return parsed as T;
  } catch {
    return fallback;
  }
}

function writeJsonFile(file: string, value: unknown): void {
  ensureDir(dirname(file));
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

export function normalizeConversationId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80);
  return normalized.length > 0 ? normalized : undefined;
}

function getArtifactDir(piDir: string): string {
  return join(piDir, ARTIFACTS_DIR);
}

function getTaskSessionsRegistryPath(piDir: string): string {
  return join(getArtifactDir(piDir), TASK_SESSIONS_REGISTRY);
}

export function readTaskSessionsRegistry(
  piDir: string,
): Record<string, TaskSessionRegistryEntry> {
  const raw = readJsonFile<Record<string, unknown>>(
    getTaskSessionsRegistryPath(piDir),
    {},
  );
  const out: Record<string, TaskSessionRegistryEntry> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    if (typeof record.task_id !== "string") continue;
    out[key] = {
      task_id: record.task_id,
      updated_at:
        typeof record.updated_at === "string"
          ? record.updated_at
          : new Date(0).toISOString(),
    };
  }
  return out;
}

export function writeTaskSessionsRegistry(
  piDir: string,
  registry: Record<string, TaskSessionRegistryEntry>,
): void {
  writeJsonFile(getTaskSessionsRegistryPath(piDir), registry);
}

function getRegistryPath(piDir: string): string {
  return join(piDir, TASK_REGISTRY);
}

export function migrateRegistryEntry(entry: Record<string, unknown> | RegistryEntry): RegistryEntry {
  const migrated: Record<string, unknown> = { ...(entry as unknown as Record<string, unknown>) };
  const legacyPaneId = migrated.paneId;
  const existingHandle = migrated.handle;

  if (!isTerminalHandle(existingHandle)) {
    if (typeof legacyPaneId === "string" && legacyPaneId.length > 0) {
      migrated.handle = { backend: "tmux", resourceId: legacyPaneId } satisfies TerminalHandle;
    } else {
      delete migrated.handle;
    }
  }

  if (isTerminalHandle(migrated.handle)) {
    migrated.backend = migrated.handle.backend;
  }
  delete migrated.paneId;
  return migrated as unknown as RegistryEntry;
}

export function readRegistry(piDir: string): RegistryEntry[] {
  const parsed = readJsonFile<unknown>(getRegistryPath(piDir), []);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    .map((entry) => migrateRegistryEntry(entry));
}

export function writeRegistry(piDir: string, entries: RegistryEntry[]): void {
  writeJsonFile(getRegistryPath(piDir), entries.map((entry) => migrateRegistryEntry(entry)));
}

function getTaskSessionHistoryPath(piDir: string): string {
  return join(piDir, TASK_SESSION_HISTORY);
}

export function readTaskSessionHistory(piDir: string): TaskSessionHistoryEntry[] {
  const parsed = readJsonFile<unknown>(getTaskSessionHistoryPath(piDir), []);
  if (!Array.isArray(parsed)) return [];
  // The history file is persisted state: drop corrupt elements (null,
  // non-objects) at this single ingest point so every consumer is safe.
  return parsed.filter(
    (entry): entry is TaskSessionHistoryEntry =>
      Boolean(entry) && typeof entry === "object",
  );
}

function writeTaskSessionHistory(
  piDir: string,
  entries: TaskSessionHistoryEntry[],
): void {
  writeJsonFile(getTaskSessionHistoryPath(piDir), entries);
}

export function upsertTaskSessionHistory(
  piDir: string,
  entry: TaskSessionHistoryEntry,
): void {
  const entries = readTaskSessionHistory(piDir);
  const idx = entries.findIndex((existing) => existing.id === entry.id);
  if (idx >= 0) {
    entries[idx] = { ...entries[idx], ...entry };
  } else {
    entries.push(entry);
  }
  writeTaskSessionHistory(piDir, entries);
}

/** Mark both durable sibling records after a comparison report is delivered. */
export function markComparisonGroupDelivered(
  piDir: string,
  taskIds: readonly string[],
): void {
  const ids = new Set(taskIds);
  const entries = readTaskSessionHistory(piDir);
  let changed = false;
  const updated = entries.map((entry) => {
    if (!ids.has(entry.id) || entry.comparisonDelivered === true) return entry;
    changed = true;
    return { ...entry, comparisonDelivered: true };
  });
  if (changed) writeTaskSessionHistory(piDir, updated);
}

export function findTaskSessionHistory(
  piDir: string,
  taskId: string,
): TaskSessionHistoryEntry | undefined {
  return readTaskSessionHistory(piDir).find((entry) => entry.id === taskId);
}

export interface TaskSessionRefSubject {
  id: string;
  sessionName: string;
  agentType: string;
  sessionRef?: string;
}

/**
 * Resolve a usable transcript path for a task record before handing it to
 * `pi --session`. A stale or missing ref is re-discovered by session name and
 * repaired in durable history — only the ref is written; status and other
 * recorded metadata keep their values.
 */
export function repairTaskSessionRef<T extends TaskSessionRefSubject>(
  piDir: string,
  entry: T,
): T {
  if (entry.sessionRef && existsSync(entry.sessionRef)) return entry;
  // Discover by task id, never by session name: probe roots are id-scoped
  // directories, and a session-name collision (one conversation re-spawned
  // under a new task id) must not adopt the other task's transcript.
  const discovered = findJsonlSessionByName(piDir, entry.id, entry.agentType);
  if (!discovered?.sessionRef) {
    // Nothing discoverable: a stale ref must not survive (existence guards
    // downstream key on sessionRef truthiness and would wave a dead path
    // through to a silent fresh-session resume).
    return { ...entry, sessionRef: undefined } as T;
  }
  const current = findTaskSessionHistory(piDir, entry.id);
  if (current) {
    upsertTaskSessionHistory(piDir, { ...current, sessionRef: discovered.sessionRef });
  }
  return { ...entry, sessionRef: discovered.sessionRef } as T;
}


function sessionFileMatches(file: string, sessionName: string): boolean {
  try {
    const content = readFileSync(file, "utf-8");
    return (
      content.includes(`\"name\":\"${sessionName}\"`) ||
      content.includes(`\"name\": \"${sessionName}\"`)
    );
  } catch {
    return false;
  }
}

export function findJsonlSessionByName(
  piDir: string,
  idOrSessionName: string,
  agentType?: string,
): TaskSessionHistoryEntry | null {
  // Records from older versions can miss fields the type promises
  // (validated here, not in readTaskSessionHistory, because absence is
  // field-specific): require id/sessionName, treat a missing dir as "no
  // recorded root" so the fallback probes take over instead of
  // join(undefined) throwing and killing the whole lookup.
  const history = readTaskSessionHistory(piDir).filter(
    (entry): entry is TaskSessionHistoryEntry =>
      typeof entry.id === "string" &&
      typeof entry.sessionName === "string" &&
      (entry.id === idOrSessionName || entry.sessionName === idOrSessionName) &&
      (!agentType || entry.agentType === agentType),
  );

  for (const historyEntry of history) {
    // Probe the artifact root recorded on the entry first, then the current
    // task layout (issue #21: writers use <piDir>/artifacts/tasks/sessions),
    // then the pre-task-ui legacy root.
    const taskDirs = [
      typeof historyEntry.dir === "string"
        ? join(historyEntry.dir, "sessions", historyEntry.id)
        : undefined,
      join(getArtifactDir(piDir), "tasks", "sessions", historyEntry.id),
      join(getArtifactDir(piDir), "sessions", historyEntry.id),
    ].filter((dir): dir is string => dir !== undefined);
    const uniqueDirs = taskDirs.filter((dir, index) => taskDirs.indexOf(dir) === index);

    for (const taskDir of uniqueDirs) {
      if (!existsSync(taskDir)) continue;
      let files: string[];
      try {
        files = readdirSync(taskDir).filter((name) => name.endsWith(".jsonl"));
      } catch {
        // An unreadable directory must not abort the lookup.
        continue;
      }
      const sessionRef = files
        .map((name) => join(taskDir, name))
        .find((file) => sessionFileMatches(file, historyEntry.sessionName));
      if (!sessionRef) continue;

      return {
        ...historyEntry,
        sessionRef,
      };
    }
  }
  return null;
}
