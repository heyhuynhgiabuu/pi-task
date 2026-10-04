import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { CURRENT_SESSION_VERSION, SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionEntry, SessionHeader } from "@earendil-works/pi-coding-agent";
import { StringDecoder } from "node:string_decoder";
import type {
  AssistantMessage,
  JsonObject,
  JsonValue,
} from "@earendil-works/pi-ai";
import type { TranscriptItem } from "./transcript.js";

export const TASK_TRANSCRIPT_VIEW_ENTRY = "pi-task-transcript-view";

export interface TaskTranscriptSessionViewOptions {
  taskId: string;
  cwd: string;
  sessionDir: string;
  parentSessionPath: string;
  parentSessionId: string;
  model: Pick<AssistantMessage, "api" | "provider" | "model">;
  items: readonly TranscriptItem[];
}

export interface TaskTranscriptViewLink {
  taskId: string;
  parentSessionPath: string;
  parentSessionId: string;
}

export type TaskTranscriptSessionViewError =
  | { kind: "empty-transcript" }
  | { kind: "invalid-parent-session"; message: string }
  | { kind: "session-write-failed"; message: string };

export type TaskTranscriptSessionViewResult =
  | { ok: true; sessionPath: string }
  | { ok: false; error: TaskTranscriptSessionViewError };

const TERMINAL_SEQUENCE_RE =
  /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\)|[PX^_][\s\S]*?\u001B\\|[@-_])|\u009B[0-?]*[ -/]*[@-~]|\u009D[^\u0007\u009C]*(?:\u0007|\u009C)|[\u0090\u0098\u009E\u009F][\s\S]*?(?:\u009C|\u001B\\)/g;
const TERMINAL_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const MAX_SESSION_BYTES = 128 * 1024 * 1024;
const MAX_SESSION_LINE_BYTES = 16 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSessionHeader(value: unknown): value is SessionHeader {
  if (!isRecord(value)) return false;
  return (
    value.type === "session" &&
    value.version === CURRENT_SESSION_VERSION &&
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    typeof value.cwd === "string" &&
    value.cwd.trim().length > 0 &&
    typeof value.timestamp === "string" &&
    Number.isFinite(Date.parse(value.timestamp)) &&
    (value.parentSession === undefined || typeof value.parentSession === "string")
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isTextBlock(value: unknown): boolean {
  return isRecord(value) && value.type === "text" && typeof value.text === "string" &&
    (value.textSignature === undefined || typeof value.textSignature === "string");
}

function isImageBlock(value: unknown): boolean {
  return isRecord(value) && value.type === "image" &&
    typeof value.data === "string" && typeof value.mimeType === "string";
}

function isUserContent(value: unknown): boolean {
  return typeof value === "string" ||
    (Array.isArray(value) && value.every((block) => isTextBlock(block) || isImageBlock(block)));
}

function isUsage(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.cost)) return false;
  const cost = value.cost;
  const usageNumbers = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"];
  const costNumbers = ["input", "output", "cacheRead", "cacheWrite", "total"];
  return usageNumbers.every((key) => isFiniteNumber(value[key])) &&
    costNumbers.every((key) => isFiniteNumber(cost[key])) &&
    (value.cacheWrite1h === undefined || isFiniteNumber(value.cacheWrite1h)) &&
    (value.reasoning === undefined || isFiniteNumber(value.reasoning));
}

function isAssistantContent(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.every((block) => {
    if (!isRecord(block)) return false;
    if (block.type === "text") return isTextBlock(block);
    if (block.type === "thinking") {
      return typeof block.thinking === "string" &&
        (block.thinkingSignature === undefined || typeof block.thinkingSignature === "string") &&
        (block.redacted === undefined || typeof block.redacted === "boolean");
    }
    if (block.type === "toolCall") {
      return typeof block.id === "string" && block.id.length > 0 &&
        typeof block.name === "string" && block.name.length > 0 &&
        isJsonObject(block.arguments) &&
        (block.thoughtSignature === undefined || typeof block.thoughtSignature === "string") &&
        (block.namespace === undefined || typeof block.namespace === "string");
    }
    return false;
  });
}

function isTextImageContent(value: unknown): boolean {
  return Array.isArray(value) && value.every((block) => isTextBlock(block) || isImageBlock(block));
}

function isConversationMessage(message: Record<string, unknown>): boolean {
  if (!isFiniteNumber(message.timestamp)) return false;
  if (message.role === "user") return isUserContent(message.content);
  if (message.role === "assistant") {
    return isAssistantContent(message.content) &&
      typeof message.api === "string" && message.api.length > 0 &&
      typeof message.provider === "string" && message.provider.length > 0 &&
      typeof message.model === "string" && message.model.length > 0 &&
      isUsage(message.usage) &&
      ["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"]
        .includes(String(message.stopReason));
  }
  return false;
}

function isSessionMessage(message: unknown): boolean {
  if (!isRecord(message) || !isFiniteNumber(message.timestamp)) return false;
  if (message.role === "user" || message.role === "assistant") {
    return isConversationMessage(message);
  }
  if (message.role === "system") {
    const contentIsValid = typeof message.content === "string" ||
      (Array.isArray(message.content) && message.content.every(isTextBlock));
    const sections = message.sections === undefined ||
      (isRecord(message.sections) && Object.values(message.sections).every(
        (section) => typeof section === "string" || section === null,
      ));
    const toolsAdded = message.toolsAdded === undefined ||
      (Array.isArray(message.toolsAdded) && message.toolsAdded.every((tool) =>
        isRecord(tool) && typeof tool.name === "string" && typeof tool.description === "string" &&
        isJsonObject(tool.parameters),
      ));
    const toolsRemoved = message.toolsRemoved === undefined ||
      (Array.isArray(message.toolsRemoved) && message.toolsRemoved.every(
        (tool) => isRecord(tool) && typeof tool.name === "string",
      ));
    return contentIsValid && sections && toolsAdded && toolsRemoved;
  }
  if (message.role === "toolResult") {
    return typeof message.toolCallId === "string" && message.toolCallId.length > 0 &&
      typeof message.toolName === "string" && message.toolName.length > 0 &&
      isTextImageContent(message.content) && typeof message.isError === "boolean" &&
      (message.details === undefined || isJsonValue(message.details)) &&
      (message.usage === undefined || isUsage(message.usage));
  }
  if (message.role === "custom") {
    return typeof message.customType === "string" && message.customType.length > 0 &&
      isUserContent(message.content) && typeof message.display === "boolean" &&
      (message.details === undefined || isJsonValue(message.details));
  }
  if (message.role === "bashExecution") {
    return typeof message.command === "string" && typeof message.output === "string" &&
      (message.exitCode === undefined || isFiniteNumber(message.exitCode)) &&
      typeof message.cancelled === "boolean" && typeof message.truncated === "boolean";
  }
  if (message.role === "branchSummary") {
    return typeof message.summary === "string" &&
      (message.fromId === null || typeof message.fromId === "string");
  }
  if (message.role === "compactionSummary") {
    return typeof message.summary === "string" && isFiniteNumber(message.tokensBefore);
  }
  return false;
}

function isSessionEntry(value: unknown): value is SessionEntry {
  if (
    !isRecord(value) ||
    value.type === "session" ||
    typeof value.type !== "string" ||
    typeof value.id !== "string" || value.id.trim().length === 0 ||
    (value.parentId !== null && typeof value.parentId !== "string") ||
    typeof value.timestamp !== "string" || !Number.isFinite(Date.parse(value.timestamp))
  ) {
    return false;
  }
  switch (value.type) {
    case "message":
      return isSessionMessage(value.message);
    case "thinking_level_change":
      return typeof value.thinkingLevel === "string";
    case "model_change":
      return typeof value.provider === "string" && typeof value.modelId === "string";
    case "usage":
      return typeof value.kind === "string" && typeof value.provider === "string" &&
        typeof value.model === "string" && isUsage(value.usage) &&
        (value.note === undefined || typeof value.note === "string");
    case "compaction":
      return typeof value.summary === "string" &&
        typeof value.firstKeptEntryId === "string" &&
        isFiniteNumber(value.tokensBefore) &&
        (value.details === undefined || isJsonValue(value.details)) &&
        (value.usage === undefined || isUsage(value.usage)) &&
        (value.fromHook === undefined || typeof value.fromHook === "boolean") &&
        (value.systemMessage === undefined || isSessionMessage(value.systemMessage));
    case "branch_summary":
      return typeof value.fromId === "string" && typeof value.summary === "string" &&
        (value.details === undefined || isJsonValue(value.details)) &&
        (value.usage === undefined || isUsage(value.usage)) &&
        (value.fromHook === undefined || typeof value.fromHook === "boolean");
    case "custom":
      return typeof value.customType === "string" &&
        (value.data === undefined || isJsonValue(value.data));
    case "custom_message":
      return typeof value.customType === "string" && isUserContent(value.content) &&
        typeof value.display === "boolean" &&
        (value.details === undefined || isJsonValue(value.details));
    case "context_edit":
      return typeof value.targetId === "string" &&
        (value.replacement === null ||
          (isRecord(value.replacement) &&
            (isUserContent(value.replacement.content) || isAssistantContent(value.replacement.content))));
    case "label":
      return typeof value.targetId === "string" &&
        (value.label === undefined || typeof value.label === "string");
    case "session_info":
      return value.name === undefined || typeof value.name === "string";
    default:
      // Forward compatibility: Pi's own reader JSON-parses every line and
      // ignores entry kinds it does not know, and migration is version-based,
      // so a newer entry kind never triggers a rewrite. The shared envelope
      // (non-empty type/id, null-or-string parentId, parseable timestamp) was
      // already validated above, so accept it instead of refusing the whole
      // parent session until this validator is extended.
      return true;
  }
}

/** Validate the complete parent JSONL without writes before Pi opens it. */
export function readPersistedPiSessionId(
  sessionPath: string,
  expectedSessionId?: string,
): string | undefined {
  let fd: number | undefined;
  try {
    if (!sessionPath.trim()) return undefined;
    fd = openSync(sessionPath, "r");
    const stats = fstatSync(fd, { bigint: true });
    if (
      !stats.isFile() ||
      stats.size === 0n ||
      stats.size > BigInt(MAX_SESSION_BYTES)
    ) {
      return undefined;
    }
    const size = Number(stats.size);
    const finalByte = Buffer.allocUnsafe(1);
    if (readSync(fd, finalByte, 0, 1, size - 1) !== 1 || finalByte[0] !== 0x0a) {
      return undefined;
    }

    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let scannedBytes = 0;
    let pending = "";
    let sessionId: string | undefined;
    let hasConversationMessage = false;
    let invalid = false;

    const inspectLine = (line: string): void => {
      if (!line.trim()) return;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        invalid = true;
        return;
      }
      if (!sessionId) {
        if (!isSessionHeader(entry)) {
          invalid = true;
          return;
        }
        sessionId = entry.id;
        return;
      }
      if (!isSessionEntry(entry)) {
        invalid = true;
        return;
      }
      if (
        entry.type === "message" &&
        (entry.message.role === "user" || entry.message.role === "assistant")
      ) {
        hasConversationMessage = true;
      }
    };

    const consume = (text: string): void => {
      pending += text;
      if (Buffer.byteLength(pending, "utf8") > MAX_SESSION_LINE_BYTES) {
        invalid = true;
        return;
      }
      let newline = pending.indexOf("\n");
      while (newline !== -1 && !invalid) {
        inspectLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    };

    while (scannedBytes < size && !invalid) {
      const bytesRead = readSync(
        fd,
        buffer,
        0,
        Math.min(buffer.length, size - scannedBytes),
        scannedBytes,
      );
      if (bytesRead === 0) break;
      scannedBytes += bytesRead;
      consume(decoder.write(buffer.subarray(0, bytesRead)));
    }
    consume(decoder.end());

    const finalStats = fstatSync(fd, { bigint: true });
    if (
      invalid ||
      pending.length > 0 ||
      !sessionId ||
      !hasConversationMessage ||
      finalStats.dev !== stats.dev ||
      finalStats.ino !== stats.ino ||
      finalStats.size !== stats.size ||
      finalStats.mtimeNs !== stats.mtimeNs ||
      finalStats.ctimeNs !== stats.ctimeNs
    ) {
      return undefined;
    }
    if (expectedSessionId !== undefined && sessionId !== expectedSessionId) return undefined;
    return sessionId;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // File validation already failed or completed; closing is best effort.
      }
    }
  }
}

export function hasTaskTranscriptViewMarker(entries: readonly SessionEntry[]): boolean {
  return entries.some(
    (entry) => entry.type === "custom" && entry.customType === TASK_TRANSCRIPT_VIEW_ENTRY,
  );
}

function stripTerminalControls(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(TERMINAL_SEQUENCE_RE, "")
    .replace(TERMINAL_CONTROL_RE, "");
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value).every(isJsonValue);
}

function isJsonObject(value: unknown): value is JsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(isJsonValue)
  );
}

function sanitizeJsonValue(value: JsonValue): JsonValue {
  if (typeof value === "string") return stripTerminalControls(value);
  if (Array.isArray(value)) return value.map(sanitizeJsonValue);
  if (value === null || typeof value !== "object") return value;
  const sanitized: JsonObject = {};
  for (const [key, nested] of Object.entries(value)) {
    sanitized[stripTerminalControls(key)] = sanitizeJsonValue(nested);
  }
  return sanitized;
}

function toolArguments(value: Record<string, unknown>): JsonObject {
  try {
    const serialized = JSON.stringify(value);
    if (!serialized) return {};
    const parsed: unknown = JSON.parse(serialized);
    return isJsonObject(parsed) ? (sanitizeJsonValue(parsed) as JsonObject) : {};
  } catch {
    return {};
  }
}

function assistantMessage(
  options: TaskTranscriptSessionViewOptions,
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
  at: number,
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    ...options.model,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: at,
    ...(errorMessage ? { errorMessage } : {}),
  };
}

function appendTranscript(session: SessionManager, options: TaskTranscriptSessionViewOptions): number {
  let count = 0;
  for (const item of options.items) {
    const at = timestamp(item.timestamp);
    if (item.type === "user") {
      if (!item.text.trim()) continue;
      session.appendMessage({
        role: "user",
        content: [{ type: "text", text: stripTerminalControls(item.text) }],
        timestamp: at,
      });
      count++;
      continue;
    }
    if (item.type === "assistant") {
      const content: AssistantMessage["content"] = [];
      const thinking = item.thinking ? stripTerminalControls(item.thinking) : "";
      const text = stripTerminalControls(item.text);
      if (thinking.trim()) content.push({ type: "thinking", thinking });
      if (text.trim()) content.push({ type: "text", text });
      if (content.length === 0) continue;
      session.appendMessage(assistantMessage(options, content, "stop", at));
      count++;
      continue;
    }
    if (item.type === "tool") {
      const toolCallId = stripTerminalControls(item.toolCallId) || `pi-task-${randomUUID()}`;
      const toolName = stripTerminalControls(item.name) || "tool";
      session.appendMessage(
        assistantMessage(
          options,
          [
            {
              type: "toolCall",
              id: toolCallId,
              name: toolName,
              arguments: toolArguments(item.args),
            },
          ],
          "toolUse",
          at,
        ),
      );
      const result = stripTerminalControls(
        item.result ??
          (item.inProgress ? "Still running when this transcript snapshot was opened." : ""),
      );
      session.appendMessage({
        role: "toolResult",
        toolCallId,
        toolName,
        content: result ? [{ type: "text", text: result }] : [],
        isError: item.isError ?? false,
        timestamp: at,
      });
      count += 2;
      continue;
    }
    session.appendMessage(
      assistantMessage(options, [], "error", at, stripTerminalControls(item.text)),
    );
    count++;
  }
  return count;
}

export function createTaskTranscriptSessionView(
  options: TaskTranscriptSessionViewOptions,
): TaskTranscriptSessionViewResult {
  if (options.items.length === 0) {
    return { ok: false, error: { kind: "empty-transcript" } };
  }
  const parentSessionId = readPersistedPiSessionId(
    options.parentSessionPath,
    options.parentSessionId,
  );
  if (!parentSessionId) {
    return {
      ok: false,
      error: {
        kind: "invalid-parent-session",
        message: "The parent path is missing or is not a valid saved Pi session.",
      },
    };
  }
  try {
    const session = SessionManager.create(options.cwd, options.sessionDir, {
      parentSession: options.parentSessionPath,
    });
    const sessionId = session.getHeader()?.id;
    if (!sessionId) {
      return {
        ok: false,
        error: { kind: "session-write-failed", message: "Pi did not create a session header" },
      };
    }
    session.appendCustomEntry(TASK_TRANSCRIPT_VIEW_ENTRY, {
      taskId: options.taskId,
      sessionId,
      parentSessionPath: options.parentSessionPath,
      parentSessionId,
    });
    if (appendTranscript(session, options) === 0) {
      return { ok: false, error: { kind: "empty-transcript" } };
    }
    session.appendSessionInfo(`Subagent transcript snapshot: ${options.taskId}`);
    const sessionPath = session.getSessionFile();
    if (!sessionPath) {
      return {
        ok: false,
        error: {
          kind: "session-write-failed",
          message: "Pi did not create a transcript session file",
        },
      };
    }
    if (readPersistedPiSessionId(sessionPath, sessionId) !== sessionId) {
      return {
        ok: false,
        error: {
          kind: "session-write-failed",
          message: "Pi did not persist a valid transcript session",
        },
      };
    }
    return { ok: true, sessionPath };
  } catch (error) {
    return {
      ok: false,
      error: {
        kind: "session-write-failed",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export function findTaskTranscriptViewLink(
  entries: readonly SessionEntry[],
  viewHeader: Pick<SessionHeader, "id" | "parentSession"> | null,
): TaskTranscriptViewLink | undefined {
  if (!viewHeader?.id || !viewHeader.parentSession) return undefined;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== TASK_TRANSCRIPT_VIEW_ENTRY) {
      continue;
    }
    if (!isRecord(entry.data)) continue;
    const { taskId, sessionId, parentSessionPath, parentSessionId } = entry.data;
    if (
      typeof taskId !== "string" ||
      taskId.trim().length === 0 ||
      sessionId !== viewHeader.id ||
      typeof parentSessionPath !== "string" ||
      parentSessionPath !== viewHeader.parentSession ||
      typeof parentSessionId !== "string" ||
      parentSessionId.trim().length === 0
    ) {
      continue;
    }
    if (readPersistedPiSessionId(parentSessionPath, parentSessionId) !== parentSessionId) {
      continue;
    }
    return { taskId, parentSessionPath, parentSessionId };
  }
  return undefined;
}
