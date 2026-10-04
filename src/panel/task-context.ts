/**
 * Composition of the live child panel's chrome: the compact task/status row
 * that sits directly above the editor, and the footer line under it.
 *
 * Every field is optional and comes from data the panel actually has — the
 * task record, the child's live durable agent state, or the child session's own
 * `model_change`/`thinking_level_change` metadata. Unknown metadata is omitted
 * rather than guessed (a child with no recorded model shows no model).
 */

import { homedir } from "node:os";

import { visibleWidth } from "@earendil-works/pi-tui";

import { formatMs } from "../helpers.js";

export interface TaskContextInfo {
  taskId: string;
  agentType: string;
  description?: string;
  /** Terminal status; `running`/undefined while the child is active. */
  status?: string;
  /** Live phase label ("Running websearch…") when the child is active. */
  phaseLabel?: string;
  backend?: string;
  runtime?: string;
  /** Effective child working directory. */
  cwd?: string;
  /** `provider/modelId` recorded for the child, when one is known. */
  model?: string;
  thinkingLevel?: string;
  elapsedMs: number;
  toolUses: number;
  /** 1-based position of this child among the session's tasks. */
  taskIndex?: number;
  taskCount?: number;
}

/**
 * Model name without its provider prefix, as pi's own footer shows it
 * (`state.model.id`, not `provider/id`). Keeps any slashes inside the model id.
 */
function shortModel(model: string): string {
  const separator = model.indexOf("/");
  return separator === -1 ? model : model.slice(separator + 1);
}

/** `~/...` for a cwd inside the home directory, as pi's own footer does. */
function shortenCwd(cwd: string): string {
  const home = homedir();
  if (!home) return cwd;
  if (cwd === home) return "~";
  return cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
}

function statusWord(status: string | undefined): string | undefined {
  if (!status) return undefined;
  return status === "aborted" ? "cancelled" : status;
}

/**
 * The compact row above the editor: which task is shown, what it is doing, and
 * how far it has got. `includePhase` is false while the working indicator is
 * embedded in the editor's top border, so the phase is not stated twice.
 */
export function taskStatusLine(
  info: TaskContextInfo,
  options: { includePhase?: boolean } = {},
): string {
  const segments: string[] = [];
  if (info.taskIndex !== undefined && info.taskCount !== undefined && info.taskCount > 1) {
    segments.push(`task ${info.taskIndex}/${info.taskCount}`);
  }
  const identity = info.description
    ? `${info.agentType} — ${info.description}`
    : info.agentType;
  segments.push(identity);
  const phase = options.includePhase ? info.phaseLabel : undefined;
  const state = phase ?? statusWord(info.status);
  if (state) segments.push(state);
  segments.push(formatMs(info.elapsedMs));
  segments.push(`${info.toolUses} ${info.toolUses === 1 ? "tool" : "tools"}`);
  return segments.join(" · ");
}

/**
 * Footer segments in priority order: the first ones survive a narrow terminal.
 * Only recorded facts appear — backend, cwd, model, thinking level.
 */
export function taskFooterSegments(info: TaskContextInfo): string[] {
  const runtime = info.runtime && info.runtime !== "pi" ? info.runtime : undefined;
  const backend = [info.backend, runtime].filter(Boolean).join("/");
  return [
    `#${info.taskId}`,
    backend || undefined,
    info.cwd ? shortenCwd(info.cwd) : undefined,
    info.model ? shortModel(info.model) : undefined,
    info.thinkingLevel ? `thinking ${info.thinkingLevel}` : undefined,
  ].filter((segment): segment is string => Boolean(segment));
}

/**
 * Footer rows, in priority order (the caller drops from the end when the
 * terminal is short): the child's recorded facts, then the key hints. A wide
 * terminal gets one compact line; a narrower one keeps the facts intact and
 * moves the hints to their own row rather than truncating either.
 */
export function footerRows(
  segments: readonly string[],
  keys: string,
  width: number,
): string[] {
  const facts = segments.join(" \u00b7 ");
  if (!facts) return [keys];
  const oneLine = `${facts} \u00b7 ${keys}`;
  if (visibleWidth(oneLine) <= width) return [oneLine];
  return [facts, keys];
}
