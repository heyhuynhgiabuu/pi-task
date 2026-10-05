import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import { readTaskSessionHistory } from "../conversation.js";
import type { DurableRuntimeModelRegistry } from "../subagent/durable.js";
import { readDurableTaskHistoryTranscriptForOwner } from "../subagent/durable.js";
import type { TaskSessionHistoryEntry } from "../types.js";
import type { ChildUsageMetadata } from "../panel/child-metadata.js";
import type { DurableChildAgent } from "../panel/durable-transcript.js";
import { readTaskSessionFile, type TranscriptItem } from "../panel/transcript.js";

/** Immutable transcript data needed to browse one persisted child. */
export interface AgentHistoryTranscript {
  items: TranscriptItem[];
  cwd?: string;
  agent?: DurableChildAgent;
  metadata?: ChildUsageMetadata;
}

/**
 * Load a persisted child transcript only when its current history record is
 * attributed to the requested parent session. SDK/terminal readers use the
 * recorded JSONL ref exactly; no project-wide search or session-name fallback
 * is allowed. Durable reads delegate to the existing byOwner-checked reader.
 */
export async function readPersistedAgentHistoryTranscript(
  piDir: string,
  ownerSessionId: string,
  selected: TaskSessionHistoryEntry,
  options: { modelRegistry?: DurableRuntimeModelRegistry } = {},
): Promise<AgentHistoryTranscript | undefined> {
  if (!ownerSessionId || !selected.id) return undefined;
  const entry = readTaskSessionHistory(piDir).find((candidate) => candidate.id === selected.id);
  if (!entry || entry.ownerSessionId !== ownerSessionId) return undefined;

  if (entry.backend === "durable") {
    if (entry.runtime === "claude") return undefined;
    const historical = await readDurableTaskHistoryTranscriptForOwner(
      piDir,
      ownerSessionId,
      entry.id,
      options,
    );
    const current = readTaskSessionHistory(piDir).find((candidate) => candidate.id === entry.id);
    if (
      !current ||
      current.ownerSessionId !== ownerSessionId ||
      current.backend !== "durable" ||
      current.runtime === "claude" ||
      current.conversationId !== entry.conversationId
    ) return undefined;
    return historical.items.length > 0
      ? {
          items: historical.items,
          cwd: historical.agent.cwd ?? current.cwd,
          agent: historical.agent,
          metadata: historical.metadata,
        }
      : undefined;
  }

  // Claude's native JSONL is not a Pi session transcript; do not misparse it
  // into fabricated or partial Pi content. The history row remains selectable
  // and the caller reports this transcript as unavailable.
  if (entry.runtime === "claude") return undefined;
  const sessionRef = entry.sessionRef;
  if (typeof sessionRef !== "string" || !sessionRef || !isAbsolute(sessionRef)) return undefined;
  try {
    if (!existsSync(sessionRef) || !statSync(sessionRef).isFile()) return undefined;
    const parsed = readTaskSessionFile(sessionRef);
    if (!parsed.found || parsed.items.length === 0) return undefined;
    const current = readTaskSessionHistory(piDir).find((candidate) => candidate.id === entry.id);
    if (
      !current ||
      current.ownerSessionId !== ownerSessionId ||
      current.backend !== entry.backend ||
      current.runtime === "claude" ||
      current.sessionRef !== sessionRef
    ) return undefined;
    const recordedName = typeof entry.sessionName === "string" ? entry.sessionName : undefined;
    const parsedName = parsed.sessionInfo?.sessionName;
    if (recordedName && parsedName && recordedName !== parsedName) return undefined;
    return {
      items: parsed.items,
      cwd: entry.cwd ?? parsed.sessionInfo?.cwd,
      ...(parsed.childMetadata === undefined ? {} : { metadata: parsed.childMetadata }),
    };
  } catch {
    return undefined;
  }
}
