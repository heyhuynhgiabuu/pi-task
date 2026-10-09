/**
 * The durable execution backend (PI_TASK_BACKEND=durable): subagent work runs
 * as pi-durable conversations over SQLite, so it survives the parent process
 * dying — the property the SDK backend lacks and the terminal backends only
 * get from tmux/HerdR panes.
 *
 * pi-durable and chord are OPTIONAL peers: every import here is dynamic, so
 * environments that never select this backend never load them. See
 * `spike-pi-durable-backend.md` for the spike that validated this design.
 */

import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";

import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { readTaskSessionHistory } from "../conversation.js";
import { isStaleExtensionCtxError } from "../stale-ctx.js";
import { DurableTranscript, type DurableChildHistoryTranscript } from "../panel/durable-transcript.js";
import { createTaskFastModeModelMatcher } from "../fast-mode.js";
import {
  classifyModelFailover,
  failoverExhaustedError,
  planModelChain,
} from "../model-failover.js";
import type { AgentModelSpec } from "../helpers.js";
import { parseToolList, resolveAgentToolAllowlist } from "../agent-tools.js";
import {
	adaptAgentTool,
	loadDurableParentToolBridge,
	loadParentExtensionTools,
} from "./durable-parent-tools.js";
import type {
  ChildBuiltinCommand,
  ChildBuiltinCommandResult,
  ChildHistoryOption,
  ChildHistoryPickerData,
  ChildSessionInfo,
  TaskSessionHistoryEntry,
} from "../types.js";

/** The subset of the pi-durable module the backend uses. */
type DurableModule = typeof import("@earendil-works/pi-durable");

type DurableHarness = import("@earendil-works/pi-durable").Harness;
type ChordContext = import("@earendil-works/chord").Context;
type ConversationId = import("@earendil-works/pi-durable").ConversationId;
type EntryId = import("@earendil-works/pi-durable").EntryId;
type ConversationRetryPolicy = import("@earendil-works/pi-durable").ConversationRetryPolicy;

type DurableRunRecord =
  | { taskId: string; status: "admitting"; ownerPid?: number }
  | {
      taskId: string;
      status: "running";
      steeringRequestIds: string[];
      strandedSteeringReason?: string;
    }
  | { taskId: string; status: "done"; answer: EntryId; usageJson?: string }
  | {
      taskId: string;
      status: "failed";
      reason: string;
      /** Harness submission verdict (`model_error`, `no_model`, ...) when known. */
      submissionReason?: string;
      /** Provider/harness detail for a model failure, when known. */
      detail?: string;
      /** The failed input was a steering successor: never advance the model chain. */
      steering?: boolean;
    }
  | { taskId: string; status: "cancelled"; reason: string };

type DurableRunState = {
  byRequestId: Record<string, DurableRunRecord>;
  activeByTask: Record<string, string>;
};

/** Pi's request-time-authenticated model surface used by durable runs. */
export type DurableRuntimeModelRegistry = Pick<
  import("@earendil-works/pi-coding-agent").ExtensionContext["modelRegistry"],
  "getAll" | "find" | "streamSimple"
>;

/** Test seam: build the harness model registry instead of createModels(). */
export type DurableModelsFactory = (
  durable: DurableModule,
) => import("@earendil-works/pi-ai").Models;

export interface DurableHarnessHandle {
  harness: DurableHarness;
  module: DurableModule;
  context: ChordContext;
  models: import("@earendil-works/pi-ai").Models;
  /** The live registry; later opens may install additional extensions. */
  registry: import("@earendil-works/pi-durable").Registry;
  /** The harness-wide registrations; each conversation selects its own subset in pi.agent. */
  toolRegistrations: readonly import("@earendil-works/pi-durable").ToolRegistration[];
  /** Read-only lookup of an exact conversation-scoped submission identity. */
  hasSubmission(conversationId: ConversationId, requestId: string): Promise<boolean>;
  /** Owner key -> child conversation id, durable across restarts. */
  children: import("@earendil-works/pi-durable").SessionDocToken<{
    byOwner: Record<string, { conversationId: ConversationId }>;
  }>;
  /** Request-scoped steering admissions and replay-stable outcomes. */
  runsDoc: import("@earendil-works/pi-durable").ConversationDocToken<DurableRunState>;
  /** The built-in per-conversation spend ledger (`pi.usage`). */
  usageDoc: import("@earendil-works/pi-durable").ConversationDocToken<
    import("@earendil-works/pi-durable").UsageState
  >;
}

type RuntimeModelRegistryRef = {
  current: DurableRuntimeModelRegistry | undefined;
};

/** Mutable fast-mode switch, refreshed per open like the model registry. */
type RuntimeFastRef = {
  current: boolean;
};

type CachedHarness = {
  promise: Promise<DurableHarnessHandle>;
  runtimeModelRegistry: RuntimeModelRegistryRef;
  runtimeFast: RuntimeFastRef;
};

const harnessCache = new Map<string, CachedHarness>();

type RetrySettingsSource = () => Partial<ConversationRetryPolicy>;
/** Until the extension registers its source, pi-durable keeps its own defaults. */
let retrySettingsSource: RetrySettingsSource = () => ({});

/**
 * The parent's live retry policy for durable generation. pi-durable reads it at
 * every attempt, so a cached or resumed harness follows the current settings
 * without reopening.
 */
export function setDurableRetrySettingsSource(source: RetrySettingsSource): void {
  retrySettingsSource = source;
}

/**
 * The live source behind `setDurableRetrySettingsSource`. A stale extension ctx
 * (after a reload) keeps the last policy this source read, so a child that
 * outlives its extension instance does not silently regain default retries.
 * Before any successful read, Pi's defaults apply.
 */
export function retrySettingsSourceFrom(
  readSettings: () => Record<string, unknown> | undefined,
): RetrySettingsSource {
  let lastGood: Partial<ConversationRetryPolicy> = {};
  return () => {
    try {
      lastGood = durableRetryFromSettings(readSettings());
    } catch (error) {
      if (!isStaleExtensionCtxError(error)) throw error;
    }
    return lastGood;
  };
}

/**
 * Pi's `retry` settings in pi-durable's policy shape. settings.json is
 * user-edited, so only well-typed keys are taken; absent keys keep pi-durable's
 * defaults, which match Pi's own.
 */
export function durableRetryFromSettings(
  settings: Record<string, unknown> | undefined,
): Partial<ConversationRetryPolicy> {
  const retry = settings?.retry;
  if (typeof retry !== "object" || retry === null || Array.isArray(retry)) return {};
  const record = retry as Record<string, unknown>;
  const count = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  const policy: Partial<ConversationRetryPolicy> = {};
  if (typeof record.enabled === "boolean") policy.enabled = record.enabled;
  for (const key of ["maxRetries", "baseDelayMs", "maxAgentDelayMs"] as const) {
    const value = count(record[key]);
    if (value !== undefined) policy[key] = value;
  }
  return policy;
}

/**
 * pi-durable 1.0.0 uses this Models subset for generation and compaction.
 * The bridge reads the latest Pi registry, so a registry-less control open
 * cannot pin later work to the standalone fallback.
 */
/** Test seam + durable wiring: build the harness model registry instead of createModels(). */
export function createPiRuntimeModels(
  registryRef: RuntimeModelRegistryRef,
  fallback: import("@earendil-works/pi-ai").Models | undefined,
  useFastMode?: (model: { provider: string; id?: string }) => boolean,
): import("@earendil-works/pi-ai").Models {
  type Models = import("@earendil-works/pi-ai").Models;
  const fallbackModels = (): Models => {
    if (!fallback) throw new Error("No Pi runtime model registry is configured");
    return fallback;
  };
  // OpenCode providers reject requests without `x-opencode-session` (400
  // MissingSessionID) and pi-durable generation calls streamSimple without a
  // session id. Give each harness open a stable routing id for opencode's
  // routing affinity. The value must be a plain UUID: opencode validates the
  // header and rejects a decorated id (`pi-task-durable-<uuid>` came back as
  // `400 {"model":"deepseek-flash"}` while the same model works in the parent,
  // whose header is Pi's bare session UUID).
  const routingSessionId = randomUUID();
  const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const withProviderOptions = (
    model: { provider: string; id?: string; api?: string },
    options: object | undefined,
  ): object | undefined => {
    let adapted = options ? { ...(options as Record<string, unknown>) } : undefined;

    // pi-ai 1.0.0's Codex `streamSimple` maps reasoning effort but leaves the
    // Responses API summary at `auto`. Request a provider-generated detailed
    // summary so text can populate ThinkingContent; keep effort unchanged and
    // preserve any caller payload hook and explicit non-auto summary. Fast mode
    // rides the same hook: the child cannot run the parent's provider-request
    // hook, so it mirrors the parent's priority service tier here.
    if (model.api === "openai-codex-responses") {
      const originalHook = adapted?.onPayload;
      adapted = {
        ...adapted,
        onPayload: async (payload: unknown, payloadModel: unknown) => {
          const callerResult =
            typeof originalHook === "function"
              ? await (
                  originalHook as (
                    payload: unknown,
                    model: unknown,
                  ) => unknown | Promise<unknown>
                )(payload, payloadModel)
              : undefined;
          const body = asRecord(callerResult === undefined ? payload : callerResult);
          if (!body) return callerResult;

          let next = body;
          let changed = false;
          if (useFastMode?.(model)) {
            next = { ...next, service_tier: "priority" };
            changed = true;
          }

          const reasoning = asRecord(next.reasoning);
          if (reasoning) {
            const effort = reasoning.effort;
            const summary = reasoning.summary;
            if (
              typeof effort === "string" &&
              effort !== "none" &&
              effort !== "off" &&
              (summary === undefined || summary === "auto")
            ) {
              next = { ...next, reasoning: { ...reasoning, summary: "detailed" } };
              changed = true;
            }
          }
          return changed ? next : callerResult;
        },
      };
    }

    if (model.provider.startsWith("opencode")) {
      const sessionId =
        typeof adapted?.sessionId === "string" ? adapted.sessionId : routingSessionId;
      adapted = { ...adapted, sessionId };
    }
    return adapted;
  };
  const adapter: Pick<
    Models,
    "getAllModels" | "getModel" | "streamSimple" | "completeSimple" | "fetchDeferred" | "cancelDeferred"
  > = {
    getAllModels: (provider) => {
      const registry = registryRef.current;
      if (!registry) return fallbackModels().getAllModels(provider);
      const models = registry.getAll();
      return provider ? models.filter((model) => model.provider === provider) : models;
    },
    getModel: (provider, modelId) => {
      const registry = registryRef.current;
      return registry
        ? registry.find(provider, modelId)
        : fallbackModels().getModel(provider, modelId);
    },
    streamSimple: (model, context, options) => {
      const registry = registryRef.current;
      const affinity = withProviderOptions(model, options);
      return registry
        ? registry.streamSimple(model, context, affinity)
        : fallbackModels().streamSimple(model, context, affinity);
    },
    completeSimple: (model, context, options) => {
      const registry = registryRef.current;
      const affinity = withProviderOptions(model, options);
      return registry
        ? registry.streamSimple(model, context, affinity).result()
        : fallbackModels().completeSimple(model, context, affinity);
    },
    fetchDeferred: async (model, handle, options) => {
      if (registryRef.current) {
        throw new Error(
          "Deferred model responses are not exposed by Pi's extension ModelRegistry.",
        );
      }
      return fallbackModels().fetchDeferred(model, handle, options);
    },
    cancelDeferred: async (model, handle, options) => {
      if (registryRef.current) {
        throw new Error(
          "Deferred model cancellation is not exposed by Pi's extension ModelRegistry.",
        );
      }
      return fallbackModels().cancelDeferred(model, handle, options);
    },
  };
  // This cast stays at the adapter boundary: pi-durable 1.0.0 calls only the
  // six Models methods implemented above for generation and compaction.
  return adapter as unknown as Models;
}

export function durableOwnerKey(taskId: string): string {
  return `pi-task:${taskId}`;
}

/** Resolve frontmatter permissions against the tools this durable harness installs. */
async function durableToolRegistrations(
  handle: DurableHarnessHandle,
  input: {
    tools?: string | string[];
    disallowedTools?: string[];
    readonly?: boolean;
    parentExtensionToolSources?: Record<string, string>;
  },
): Promise<import("@earendil-works/pi-durable").ToolRegistration[]> {
  const available = new Map(handle.toolRegistrations.map((tool) => [tool.name, tool]));
  // Containment holds by construction: the child only ever receives names from
  // `available`, minus the deny list. Names the durable harness cannot host
  // (extension-runtime tools such as codemode or peer) fail open and are
  // dropped by the allowlist intersection below — pi-runtime parity, where CLI
  // children also lack tools their runtime does not register. `readonly`
  // matches the documented CLI contract (README): it denies
  // write/edit/apply_patch, not bash, and explicit write/edit on a readonly
  // agent is a frontmatter contradiction that fails closed.
  const explicitlyRequestedMutators = parseToolList(input.tools).filter((name) =>
    input.readonly && ["write", "edit"].includes(name),
  );
  if (explicitlyRequestedMutators.length > 0) {
    throw new Error(
      `Agent has readonly: true but tools requests mutating durable tool: ${explicitlyRequestedMutators[0]}. ` +
        "Remove readonly: or drop the mutating tool from tools:.",
    );
  }

  const disallowedTools = [
    ...parseToolList(input.disallowedTools),
    ...(input.readonly ? ["write", "edit", "apply_patch"] : []),
  ];
  // Without an explicit allowlist the durable surface stays the four CodingTools:
  // resolveAgent composes every installed extension when `tools` is unset, so
  // leaving it unset would silently widen the default surface to the bridge.
  const requestedNames = (
    parseToolList(input.tools).length > 0
      ? parseToolList(input.tools)
      : ["read", "write", "edit", "bash"]
  ).filter((name) => !disallowedTools.includes(name));
  // Host requested parent extension tools whose registration modules are known:
  // the module is re-invoked against a capture shim (never the live parent API)
  // and only names the policy asked for are hosted. A module that fails to load
  // fails open like every other unhostable name: the child loses the tool.
  const bridged: import("@earendil-works/pi-durable").ToolRegistration[] = [];
  for (const [name, entryPath] of Object.entries(input.parentExtensionToolSources ?? {})) {
    if (available.has(name) || !requestedNames.includes(name)) continue;
    try {
      const tool = (await loadParentExtensionTools(entryPath)).get(name);
      if (tool) {
        // Network-backed tools are not idempotent: keep the default "unsafe" replay.
        bridged.push(adaptAgentTool(tool, { replaySafe: false }));
      }
    } catch {
      // Fail open; the allowlist mapping below simply drops the name.
    }
  }
  if (bridged.length > 0) {
    // The conversation resolves its stored tool names against the live registry
    // snapshot on every turn, so the bridge must be installed there, not only
    // passed in the per-run list. install() REPLACES the extension by name, so
    // merge with what earlier runs bridged: a later, narrower run must never
    // evict tools a still-running child already selected.
    const bridgedName = "pi-task-parent-extension-tools";
    const merged = new Map<
      string,
      import("@earendil-works/pi-durable").ToolRegistration
    >();
    for (const tool of handle.registry.snapshot().extension(bridgedName)?.tools ?? []) {
      merged.set(tool.name, tool);
    }
    for (const tool of bridged) merged.set(tool.name, tool);
    handle.registry.install(handle.module.defineExtension({
      name: bridgedName,
      tools: [...merged.values()],
    }));
    for (const tool of bridged) available.set(tool.name, tool);
  }
  const allowedNames = resolveAgentToolAllowlist({
    tools: parseToolList(input.tools).length > 0 ? input.tools : ["read", "write", "edit", "bash"],
    disallowedTools,
    parentToolNames: [...available.keys()],
  });
  return allowedNames.map((name) => {
    const tool = available.get(name);
    if (!tool) throw new Error(`Durable backend tool policy resolved unavailable tool: ${name}`);
    return tool;
  });
}

/** A Pi tool-call id makes each explicit task_id follow-up replay-safe. */
export function durableRequestId(taskId: string, toolCallId?: string): string {
  if (!toolCallId) return durableOwnerKey(taskId);
  return `pi-task:${encodeURIComponent(taskId)}:call:${encodeURIComponent(toolCallId)}`;
}

function taskIdFromRequestId(requestId: unknown): string | undefined {
  if (typeof requestId !== "string" || !requestId.startsWith("pi-task:")) return undefined;
  const suffix = requestId.slice("pi-task:".length);
  const callMarker = suffix.indexOf(":call:");
  if (callMarker < 0) return suffix || undefined;
  const encodedTaskId = suffix.slice(0, callMarker);
  if (!encodedTaskId) return undefined;
  try {
    return decodeURIComponent(encodedTaskId);
  } catch {
    return undefined;
  }
}

export function durableDatabasePath(piDir: string): string {
  return join(piDir, "durable", "tasks.sqlite");
}

export type DurableDatabasePathInspection =
  | { kind: "present" }
  | { kind: "missing" }
  | { kind: "unreadable"; error: unknown };

/** Distinguish a genuinely absent store from a path that cannot be inspected. */
export function inspectDurableDatabasePath(
  databasePath: string,
): DurableDatabasePathInspection {
  try {
    statSync(databasePath);
    return { kind: "present" };
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return { kind: "missing" };
    }
    return { kind: "unreadable", error };
  }
}

export class DurableTaskCancelledError extends Error {
  readonly kind = "cancelled" as const;

  constructor(message = "Durable subagent was cancelled.") {
    super(message);
    this.name = "DurableTaskCancelledError";
  }
}

/**
 * Open (once per database) the harness that runs durable subagent tasks.
 * `modelRegistry` is Pi's live model/auth bridge; later opens refresh the
 * cached bridge. `models` remains a test seam and `createModels()` a fallback.
 */
export async function openDurableHarness(
  piDir: string,
  options: {
    databasePath?: string;
    models?: DurableModelsFactory;
    modelRegistry?: DurableRuntimeModelRegistry;
    /** Mirror the parent's fast mode onto Codex requests (durable children run no extensions). */
    fast?: boolean;
  } = {},
): Promise<DurableHarnessHandle> {
  const databasePath = options.databasePath ?? durableDatabasePath(piDir);
  const cached = harnessCache.get(databasePath);
  if (cached) {
    if (options.modelRegistry) cached.runtimeModelRegistry.current = options.modelRegistry;
    if (options.fast !== undefined) cached.runtimeFast.current = options.fast;
    return cached.promise;
  }
  const runtimeModelRegistry: RuntimeModelRegistryRef = {
    current: options.modelRegistry,
  };
  const runtimeFast: RuntimeFastRef = { current: options.fast === true };
  const promise = (async () => {
    const [durable, sqlite, chordContext] = await Promise.all([
      import("@earendil-works/pi-durable"),
      import("@earendil-works/pi-durable/storage/sqlite/node"),
      import("@earendil-works/chord/context"),
    ]);
    const { NodeExecutionEnv } = await import("@earendil-works/pi-durable/env/node");
    const { CodingTools } = await import("@earendil-works/pi-durable/tools");
    const fallbackModels =
      options.models || options.modelRegistry
        ? undefined
        : (await import("@earendil-works/pi-ai/models")).createModels();
    const matchesFastModel = createTaskFastModeModelMatcher();
    const models = options.models
      ? options.models(durable)
      : createPiRuntimeModels(
          runtimeModelRegistry,
          fallbackModels,
          (model) => runtimeFast.current && matchesFastModel(model),
        );
    const registry = durable.createRegistry();
    registry.install(CodingTools);
    const parentToolBridge = await loadDurableParentToolBridge();
    if (parentToolBridge) registry.install(durable.defineExtension({
      name: parentToolBridge.name,
      tools: parentToolBridge.tools,
    }));
    const storage = await sqlite.openNodeSqliteStorage(databasePath);
    const harness = await durable.Harness.open(
      storage,
      {
        models,
        registry,
        settings: { get retry() { return retrySettingsSource(); } },
        env: ({ cwd }: { cwd?: string }) =>
          new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }),
      },
      chordContext.BACKGROUND_CONTEXT,
    );
    // Continue any work interrupted by a previous process.
    harness.resume();
    const children = durable.defineDoc<{
      byOwner: Record<string, { conversationId: ConversationId }>;
    }>({
      kind: "pi-task.children",
      version: 1,
      scope: "session",
      initial: () => ({ byOwner: {} }),
    });
    const runsDoc = durable.defineDoc<DurableRunState>({
      kind: "pi-task.run-lifecycle",
      version: 1,
      scope: "conversation",
      history: "latest",
      fork: "current",
      initial: () => ({ byRequestId: {}, activeByTask: {} }),
    });
    const context = chordContext.BACKGROUND_CONTEXT as ChordContext;
    return {
      harness,
      module: durable,
      context,
      models,
      registry,
      hasSubmission: async (conversationId: ConversationId, requestId: string) =>
        (await storage.submissionByRequest(conversationId, requestId, context)) !== undefined,
      children,
      runsDoc,
      usageDoc: durable.UsageDoc,
      toolRegistrations: [
        ...(CodingTools.tools ?? []),
        ...(parentToolBridge?.tools ?? []),
      ],
    };
  })();
  harnessCache.set(databasePath, { promise, runtimeModelRegistry, runtimeFast });
  return promise;
}

/** Find-before-create in one atomic commit (pi-durable example 22 pattern). */
async function findOrCreateChild(
  handle: DurableHarnessHandle,
  ownerKey: string,
  configure?: {
    model?: { provider: string; modelId: string };
    cwd?: string;
    thinkingLevel?: DurableThinkingLevel;
    tools?: readonly import("@earendil-works/pi-durable").ToolRegistration[];
  },
): Promise<ConversationId> {
  const root = await handle.harness.root(handle.context);
  return root.commit(async (tx) => {
    const map = await tx.doc(handle.children);
    const existing = map.byOwner[ownerKey];
    if (existing !== undefined) return existing.conversationId;
    // Raw creation copies no agent (ownerless has no owner to copy from), so
    // the child is configured explicitly.
    const created = await tx.createConversation({
      ownership: { kind: "ownerless" },
    });
    await handle.module.configure(tx, created.id, {
      ...(configure?.model !== undefined ? { model: configure.model } : {}),
      ...(configure?.cwd !== undefined ? { cwd: configure.cwd } : {}),
      ...(configure?.thinkingLevel !== undefined
        ? { thinkingLevel: configure.thinkingLevel }
        : {}),
      ...(configure?.tools !== undefined ? { tools: configure.tools } : {}),
    });
    map.byOwner[ownerKey] = { conversationId: created.id };
    return created.id;
  }, handle.context);
}

/**
 * The child conversation of a task, resolved through the durable mapping, or
 * undefined when this task never started one.
 */
async function findChild(
  handle: DurableHarnessHandle,
  taskId: string,
): Promise<import("@earendil-works/pi-durable").Conversation | undefined> {
  const root = await handle.harness.root(handle.context);
  const childId = await root.commit(async (tx) => {
    const map = await tx.doc(handle.children);
    // The draft is a transaction overlay: read primitives inside the commit —
    // nested tracked objects throw "settled overlay" after it settles.
    const child = map.byOwner[durableOwnerKey(taskId)];
    return child === undefined ? undefined : child.conversationId;
  }, handle.context);
  if (childId === undefined) return undefined;
  return handle.harness.conversation(childId, handle.context);
}

/**
 * True while this task's run still owns the child conversation: the request
 * is admitting, or it is running with a live, non-terminal harness task. This
 * is the admission predicate `configureActiveDurableChild` applies atomically
 * with its change; compact re-checks it before admitting a task of its own.
 */
async function durableChildRunActive(
  handle: DurableHarnessHandle,
  conversation: import("@earendil-works/pi-durable").Conversation,
  taskId: string,
): Promise<boolean> {
  return conversation.commit(async (tx) => {
    const runs = await tx.doc(handle.runsDoc, conversation.id);
    const requestId = runs.activeByTask[taskId];
    const run = requestId ? runs.byRequestId[requestId] : undefined;
    if (!run || run.taskId !== taskId) return false;
    if (run.status === "admitting") return true;
    if (run.status !== "running") return false;
    const live = await tx.doc(handle.module.LiveDoc, conversation.id);
    if (!live.run) return false;
    const task = await tx.task(live.run.taskId);
    return !!task && !task.abortRequested &&
      task.state.status !== "completing" && task.state.status !== "terminal";
  }, handle.context);
}

/** Apply an agent change only while this task still owns its child run. */
async function configureActiveDurableChild(
  handle: DurableHarnessHandle,
  conversation: import("@earendil-works/pi-durable").Conversation,
  taskId: string,
  change: import("@earendil-works/pi-durable").AgentChange,
): Promise<boolean> {
  return conversation.commit(async (tx) => {
    const runs = await tx.doc(handle.runsDoc, conversation.id);
    const requestId = runs.activeByTask[taskId];
    const run = requestId ? runs.byRequestId[requestId] : undefined;
    if (!run || run.taskId !== taskId) return false;
    if (run.status === "admitting") {
      await handle.module.configure(tx, conversation.id, change);
      return true;
    }
    if (run.status !== "running") return false;
    const live = await tx.doc(handle.module.LiveDoc, conversation.id);
    if (!live.run) return false;
    const task = await tx.task(live.run.taskId);
    if (
      !task ||
      task.abortRequested ||
      task.state.status === "completing" ||
      task.state.status === "terminal"
    ) return false;
    await handle.module.configure(tx, conversation.id, change);
    return true;
  }, handle.context);
}

export type DurableAdmissionState =
  | { kind: "admitted" }
  | {
      kind: "unadmitted";
      reason: "storage-missing" | "child-missing" | "submission-missing";
    }
  | { kind: "unknown"; reason: "request-id-missing" | "storage-unreadable" };

/** Check the exact current durable request without creating child state. */
export async function inspectDurableTaskAdmission(
  piDir: string,
  taskId: string,
  requestId: string | undefined,
  options: {
    databasePath?: string;
    models?: DurableModelsFactory;
    modelRegistry?: DurableRuntimeModelRegistry;
  } = {},
): Promise<DurableAdmissionState> {
  const databasePath = options.databasePath ?? durableDatabasePath(piDir);
  const storage = inspectDurableDatabasePath(databasePath);
  if (storage.kind === "missing") {
    return { kind: "unadmitted", reason: "storage-missing" };
  }
  if (storage.kind === "unreadable") {
    return { kind: "unknown", reason: "storage-unreadable" };
  }
  if (!requestId) return { kind: "unknown", reason: "request-id-missing" };

  const handle = await openDurableHarness(piDir, { ...options, databasePath });
  const children = await handle.harness.snapshot(handle.children, handle.context);
  const childId = children?.byOwner[durableOwnerKey(taskId)]?.conversationId;
  if (childId === undefined) return { kind: "unadmitted", reason: "child-missing" };
  if (!(await handle.hasSubmission(childId, requestId))) {
    return { kind: "unadmitted", reason: "submission-missing" };
  }
  return { kind: "admitted" };
}

/**
 * Release an admission-only reservation after recovery has proved its owner
 * process is gone. This must not be used to resolve an in-flight admission.
 */
export async function releaseUnadmittedDurableRun(
  piDir: string,
  taskId: string,
  requestId: string,
  ownerPid: number,
  options: {
    databasePath?: string;
    models?: DurableModelsFactory;
    modelRegistry?: DurableRuntimeModelRegistry;
  } = {},
): Promise<boolean> {
  const handle = await openDurableHarness(piDir, options);
  const conversation = await findChild(handle, taskId);
  if (!conversation) return true;
  const observed = await handle.harness.snapshot(
    handle.runsDoc,
    conversation.id,
    handle.context,
  );
  const reservation = observed?.byRequestId[requestId];
  if (!reservation) return true;
  if (
    reservation.taskId !== taskId ||
    reservation.status !== "admitting" ||
    reservation.ownerPid !== ownerPid
  ) return false;

  return conversation.commit(async (tx) => {
    const runs = await tx.doc(handle.runsDoc, conversation.id);
    const current = runs.byRequestId[requestId];
    if (!current) return true;
    if (
      current.taskId !== taskId ||
      current.status !== "admitting" ||
      current.ownerPid !== ownerPid
    ) return false;
    if (await tx.submissionByRequest(conversation.id, requestId)) return false;
    const live = await tx.doc(handle.module.LiveDoc, conversation.id);
    if (live.run) return false;
    delete runs.byRequestId[requestId];
    if (runs.activeByTask[taskId] === requestId) delete runs.activeByTask[taskId];
    return true;
  }, handle.context);
}

const THINKING_LEVELS = new Set<import("@earendil-works/pi-ai").ModelThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/** Resolve the complete model ID before interpreting an optional legacy thinking suffix. */
/**
 * Pi's canonical thinking levels: the values `pi.agent.thinkingLevel` accepts.
 * A durable conversation that stores none runs at the harness default, which
 * for a model whose `thinkingLevelMap.off` maps to a provider effort can send
 * an effort the provider rejects (for example `"disable"`).
 */
export type DurableThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/** Normalize agent frontmatter `thinking`; anything unrecognized is left unset. */
export function parseDurableThinkingLevel(
  value: string | undefined,
): DurableThinkingLevel | undefined {
  const normalized = value?.trim().toLowerCase();
  switch (normalized) {
    case "off":
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return normalized;
    default:
      return undefined;
  }
}

function parseAgentModel(
  model: string | undefined,
  models: Pick<import("@earendil-works/pi-ai").Models, "getAllModels" | "getModel">,
): { provider: string; modelId: string } | undefined {
  if (!model) return undefined;
  const separator = model.indexOf("/");
  if (separator < 0) {
    const match = models.getAllModels().find(
      (candidate) => candidate.id === model || candidate.name === model,
    );
    if (!match) {
      throw new Error(`Model "${model}" is not available in the model registry`);
    }
    return { provider: match.provider, modelId: match.id };
  }
  if (separator === 0) {
    throw new Error(`Model "${model}" is not available in the model registry`);
  }
  const provider = model.slice(0, separator);
  const requestedModelId = model.slice(separator + 1);
  if (!requestedModelId) {
    throw new Error(`Model "${model}" is not available in the model registry`);
  }

  // Model IDs may contain slashes (for example, openrouter/anthropic/model).
  // Prefer a registered full ID over interpreting its final segment as thinking.
  if (models.getModel(provider, requestedModelId)) {
    return { provider, modelId: requestedModelId };
  }

  const thinkingSeparator = requestedModelId.lastIndexOf("/");
  const thinkingLevel = requestedModelId.slice(thinkingSeparator + 1);
  if (
    thinkingSeparator > 0 &&
    THINKING_LEVELS.has(thinkingLevel as import("@earendil-works/pi-ai").ModelThinkingLevel)
  ) {
    return {
      provider,
      modelId: requestedModelId.slice(0, thinkingSeparator),
    };
  }
  return { provider, modelId: requestedModelId };
}

/** The harness default: the first registered chat model, when one exists. */
function defaultModelRef(handle: DurableHarnessHandle): {
  provider: string;
  modelId: string;
} | undefined {
  const first = handle.models.getAllModels()[0];
  return first ? { provider: first.provider, modelId: first.id } : undefined;
}

/** Spend of one durable child conversation, summed from its `pi.usage` ledger. */
export interface DurableUsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Provider-computed cost when known; 0 otherwise. */
  costTotal: number;
}

export interface DurableUsage {
  /** Per `provider/modelId`. */
  models: Record<string, DurableUsageTotals>;
  /** Per tool name. */
  tools: Record<string, DurableUsageTotals>;
  /** The child conversation's whole spend. */
  totals: DurableUsageTotals;
}

export interface DurableRunResult {
  conversationId: string;
  answer: string;
  usage: DurableUsage;
}

/** Sum one `pi.usage` bucket into plain totals, inside the commit. */
function bucketTotals(
  bucket: Record<string, import("@earendil-works/pi-ai").Usage>,
): Record<string, DurableUsageTotals> {
  const totals: Record<string, DurableUsageTotals> = {};
  for (const [key, usage] of Object.entries(bucket)) {
    totals[key] = {
      inputTokens: usage.input,
      outputTokens: usage.output,
      totalTokens: usage.totalTokens,
      costTotal: usage.cost?.total ?? 0,
    };
  }
  return totals;
}

function sumTotals(entries: DurableUsageTotals[]): DurableUsageTotals {
  return entries.reduce(
    (sum, entry) => ({
      inputTokens: sum.inputTokens + entry.inputTokens,
      outputTokens: sum.outputTokens + entry.outputTokens,
      totalTokens: sum.totalTokens + entry.totalTokens,
      costTotal: sum.costTotal + entry.costTotal,
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0, costTotal: 0 },
  );
}

/**
 * The child conversation's spend ledger, read as plain data inside one commit
 * (drafts are transaction overlays and die after settle).
 */
async function readConversationUsage(
  handle: DurableHarnessHandle,
  conversationId: ConversationId,
): Promise<DurableUsage> {
  const root = await handle.harness.root(handle.context);
  return root.commit(async (tx) => {
    const state = await tx.doc(handle.usageDoc, conversationId);
    return durableUsageFromBuckets(
      state.models as Record<string, import("@earendil-works/pi-ai").Usage>,
      state.tools as Record<string, import("@earendil-works/pi-ai").Usage>,
    );
  }, handle.context);
}

function durableUsageFromBuckets(
  models: Record<string, import("@earendil-works/pi-ai").Usage>,
  tools: Record<string, import("@earendil-works/pi-ai").Usage>,
): DurableUsage {
  const modelTotals = bucketTotals(models);
  const toolTotals = bucketTotals(tools);
  return {
    models: modelTotals,
    tools: toolTotals,
    totals: sumTotals([
      ...Object.values(modelTotals),
      ...Object.values(toolTotals),
    ]),
  };
}

function parseDurableUsage(value: string | undefined): DurableUsage | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const candidate = parsed as Record<string, unknown>;
    const isTotals = (entry: unknown): entry is DurableUsageTotals =>
      typeof entry === "object" && entry !== null &&
      ["inputTokens", "outputTokens", "totalTokens", "costTotal"].every((key) =>
        typeof (entry as Record<string, unknown>)[key] === "number"
      );
    const isBucket = (entry: unknown): entry is Record<string, DurableUsageTotals> =>
      typeof entry === "object" && entry !== null &&
      Object.values(entry).every(isTotals);
    if (
      !isBucket(candidate.models) ||
      !isBucket(candidate.tools) ||
      !isTotals(candidate.totals)
    ) return undefined;
    return candidate as unknown as DurableUsage;
  } catch {
    return undefined;
  }
}

type DurableSubmissionRecord = import("@earendil-works/pi-durable").SubmissionRecord;

type DurableRunReservation = DurableRunRecord | { status: "busy" };

function isTerminalDurableRun(record: DurableRunRecord): record is Extract<
  DurableRunRecord,
  { status: "done" | "failed" | "cancelled" }
> {
  return record.status === "done" || record.status === "failed" || record.status === "cancelled";
}

function copyDurableRunRecord(record: DurableRunRecord): DurableRunRecord {
  return record.status === "running"
    ? { ...record, steeringRequestIds: [...record.steeringRequestIds] }
    : { ...record };
}

function describeUnansweredSubmission(record: DurableSubmissionRecord): string {
  if (record.status !== "unanswered") return record.status;
  const detail = record.detail === undefined
    ? ""
    : typeof record.detail === "string"
      ? `: ${record.detail}`
      : `: ${JSON.stringify(record.detail)}`;
  return `${record.reason}${detail}`;
}

/**
 * Reserve one parent request before it can accept any transcript steering.
 * An optional `configure` change is applied in the same commit that admits
 * the request, so a failover resubmit can never run under the previous
 * model/thinking level (and a reused child is re-pointed at the frontmatter
 * primary at admission).
 */
async function reserveDurableRun(
  handle: DurableHarnessHandle,
  conversation: import("@earendil-works/pi-durable").Conversation,
  taskId: string,
  requestId: string,
  configure?: {
    model?: { provider: string; modelId: string };
    thinkingLevel?: DurableThinkingLevel;
    tools?: readonly import("@earendil-works/pi-durable").ToolRegistration[];
  },
): Promise<DurableRunReservation> {
  return conversation.commit(async (tx) => {
    const runs = await tx.doc(handle.runsDoc, conversation.id);
    const existing = runs.byRequestId[requestId];
    if (existing && existing.taskId !== taskId) {
      throw new Error(`Durable request ${requestId} belongs to a different task.`);
    }
    if (existing && isTerminalDurableRun(existing)) return copyDurableRunRecord(existing);

    const activeRequestId = runs.activeByTask[taskId];
    if (activeRequestId && activeRequestId !== requestId) {
      const active = runs.byRequestId[activeRequestId];
      if (active?.status === "admitting" || active?.status === "running") {
        return { status: "busy" };
      }
      delete runs.activeByTask[taskId];
    }
    const live = await tx.doc(handle.module.LiveDoc, conversation.id);
    if (live.run && activeRequestId !== requestId) return { status: "busy" };
    if (existing?.status === "admitting" && existing.ownerPid !== process.pid) {
      runs.byRequestId[requestId] = { ...existing, ownerPid: process.pid };
    }

    if (!existing) {
      runs.byRequestId[requestId] = { taskId, status: "admitting", ownerPid: process.pid };
    }
    runs.activeByTask[taskId] = requestId;
    const current = runs.byRequestId[requestId]!;
    if (
      current.status === "admitting" &&
      (configure?.model !== undefined ||
        configure?.thinkingLevel !== undefined ||
        configure?.tools !== undefined)
    ) {
      await handle.module.configure(tx, conversation.id, {
        ...(configure?.model !== undefined ? { model: configure.model } : {}),
        ...(configure?.thinkingLevel !== undefined
          ? { thinkingLevel: configure.thinkingLevel }
          : {}),
        ...(configure?.tools !== undefined ? { tools: configure.tools } : {}),
      });
    }
    return copyDurableRunRecord(current);
  }, handle.context);
}

/** Mark an admitted request steerable only after its initial submission exists. */
async function activateDurableRun(
  handle: DurableHarnessHandle,
  conversation: import("@earendil-works/pi-durable").Conversation,
  taskId: string,
  requestId: string,
): Promise<DurableRunRecord> {
  return conversation.commit(async (tx) => {
    const runs = await tx.doc(handle.runsDoc, conversation.id);
    const current = runs.byRequestId[requestId];
    if (!current || current.taskId !== taskId) {
      throw new Error(`Durable request ${requestId} lost its lifecycle reservation.`);
    }
    if (isTerminalDurableRun(current)) return copyDurableRunRecord(current);
    if (current.status === "admitting") {
      const submission = await tx.submissionByRequest(conversation.id, requestId);
      if (!submission) throw new Error(`Durable request ${requestId} was not admitted.`);
      const activeRequestId = runs.activeByTask[taskId];
      if (activeRequestId && activeRequestId !== requestId) {
        throw new Error(`Durable task ${taskId} already has an active request.`);
      }
      runs.byRequestId[requestId] = {
        taskId,
        status: "running",
        steeringRequestIds: [],
      };
      runs.activeByTask[taskId] = requestId;
    }
    return copyDurableRunRecord(runs.byRequestId[requestId]!);
  }, handle.context);
}

/** Recover a committed admission before exposing controls such as steering. */
async function promoteRecoveredDurableRun(
  handle: DurableHarnessHandle,
  conversation: import("@earendil-works/pi-durable").Conversation,
  taskId: string,
  requestId: string,
): Promise<DurableRunRecord | undefined> {
  return conversation.commit(async (tx) => {
    const runs = await tx.doc(handle.runsDoc, conversation.id);
    const current = runs.byRequestId[requestId];
    if (!current || current.taskId !== taskId) return undefined;
    if (current.status !== "admitting") return copyDurableRunRecord(current);
    const submission = await tx.submissionByRequest(conversation.id, requestId);
    if (!submission) return undefined;
    const activeRequestId = runs.activeByTask[taskId];
    if (activeRequestId && activeRequestId !== requestId) {
      const active = runs.byRequestId[activeRequestId];
      if (active?.status === "admitting" || active?.status === "running") return undefined;
      delete runs.activeByTask[taskId];
    }
    const running: DurableRunRecord = {
      taskId,
      status: "running",
      steeringRequestIds: [],
    };
    runs.byRequestId[requestId] = running;
    runs.activeByTask[taskId] = requestId;
    return running;
  }, handle.context);
}

/**
 * Wait for a parent request and every steering admission attached to it. The
 * final no-run check, request snapshot, and outcome write share one transaction;
 * after that point the steering guard cannot admit another input for this run.
 */
async function settleDurableRun(
  handle: DurableHarnessHandle,
  conversation: import("@earendil-works/pi-durable").Conversation,
  taskId: string,
  requestId: string,
): Promise<DurableRunRecord> {
  for (;;) {
    await conversation.waitForIdle(handle.context);
    const result = await conversation.commit(async (tx) => {
      const runs = await tx.doc(handle.runsDoc, conversation.id);
      const current = runs.byRequestId[requestId];
      if (!current || current.taskId !== taskId) {
        return { kind: "terminal" as const, record: {
          taskId,
          status: "failed" as const,
          reason: `Durable request ${requestId} has no lifecycle record.`,
        } };
      }
      if (isTerminalDurableRun(current)) {
        return { kind: "terminal" as const, record: copyDurableRunRecord(current) };
      }

      const live = await tx.doc(handle.module.LiveDoc, conversation.id);
      if (live.run) return { kind: "busy" as const };

      const initial = await tx.submissionByRequest(conversation.id, requestId);
      if (current.status === "admitting") {
        if (!initial) {
          const failed: DurableRunRecord = {
            taskId,
            status: "failed",
            reason: `Durable request ${requestId} was not admitted before recovery.`,
          };
          runs.byRequestId[requestId] = failed;
          if (runs.activeByTask[taskId] === requestId) delete runs.activeByTask[taskId];
          return { kind: "terminal" as const, record: failed };
        }
      }
      const steeringIds = current.status === "running"
        ? [...current.steeringRequestIds]
        : [];
      const requestIds = [requestId, ...steeringIds];
      const submissions = await Promise.all(
        requestIds.map((id) => tx.submissionByRequest(conversation.id, id)),
      );
      const missing = requestIds.find((_id, index) => submissions[index] === undefined);
      if (missing) {
        const failed: DurableRunRecord = {
          taskId,
          status: "failed",
          reason: `Accepted durable submission ${missing} is missing.`,
        };
        runs.byRequestId[requestId] = failed;
        if (runs.activeByTask[taskId] === requestId) delete runs.activeByTask[taskId];
        return { kind: "terminal" as const, record: failed };
      }
      const records = submissions as DurableSubmissionRecord[];
      const queuedIds = records
        .filter((record) => record.status === "queued")
        .map((record) => record.id);
      if (queuedIds.length > 0) {
        const strandedSteeringReason =
          current.status === "running" && current.strandedSteeringReason
            ? current.strandedSteeringReason
            : "Accepted durable input remained queued after its run ended and was withdrawn.";
        runs.byRequestId[requestId] = current.status === "running"
          ? { ...current, strandedSteeringReason }
          : {
              taskId,
              status: "running",
              steeringRequestIds: [],
              strandedSteeringReason,
            };
        return { kind: "withdraw" as const, ids: queuedIds };
      }

      const placed = records.find((record) => record.status === "placed");
      if (placed) {
        const failed: DurableRunRecord = {
          taskId,
          status: "failed",
          reason: `Durable submission ${placed.requestId ?? placed.id} was placed without an active run.`,
        };
        runs.byRequestId[requestId] = failed;
        if (runs.activeByTask[taskId] === requestId) delete runs.activeByTask[taskId];
        return { kind: "terminal" as const, record: failed };
      }

      const aborted = records.find(
        (record) => record.status === "unanswered" && record.reason === "aborted",
      );
      const failedSubmission = records.find(
        (record) => record.status === "unanswered" && record.reason !== "aborted",
      );
      let terminal: DurableRunRecord;
      if (aborted && !(current.status === "running" && current.strandedSteeringReason && aborted.requestId !== requestId)) {
        terminal = {
          taskId,
          status: "cancelled",
          reason: `Durable submission ${aborted.requestId ?? aborted.id} was aborted.`,
        };
      } else if (failedSubmission) {
        const steering = failedSubmission.requestId !== undefined &&
          failedSubmission.requestId !== requestId;
        terminal = {
          taskId,
          status: "failed",
          reason: `durable subagent failed: ${describeUnansweredSubmission(failedSubmission)}`,
          submissionReason: failedSubmission.reason,
          ...(typeof failedSubmission.detail === "string"
            ? { detail: failedSubmission.detail }
            : {}),
          ...(steering ? { steering: true } : {}),
        };
      } else if (current.status === "running" && current.strandedSteeringReason) {
        terminal = { taskId, status: "failed", reason: current.strandedSteeringReason };
      } else {
        const answer = [...records].reverse().find(
          (record): record is Extract<DurableSubmissionRecord, { status: "done" }> =>
            record.status === "done",
        )?.answer;
        if (!answer) {
          terminal = {
            taskId,
            status: "failed",
            reason: "Durable submissions settled without an assistant answer.",
          };
        } else {
          const usageState = await tx.doc(handle.usageDoc, conversation.id);
          terminal = {
            taskId,
            status: "done",
            answer,
            usageJson: JSON.stringify(durableUsageFromBuckets(
              usageState.models as Record<string, import("@earendil-works/pi-ai").Usage>,
              usageState.tools as Record<string, import("@earendil-works/pi-ai").Usage>,
            )),
          };
        }
      }
      runs.byRequestId[requestId] = terminal;
      if (runs.activeByTask[taskId] === requestId) delete runs.activeByTask[taskId];
      return { kind: "terminal" as const, record: terminal };
    }, handle.context);

    if (result.kind === "busy") continue;
    if (result.kind === "terminal") return result.record;
    for (const id of result.ids) {
      const pending = await handle.harness.submission(id, handle.context);
      if (pending) await pending.abort(handle.context);
    }
  }
}

/** One planned model attempt in a durable failover chain. */
interface DurableAttemptPlan {
  /** Display label: resolved `provider/modelId` or the raw frontmatter spec. */
  label: string;
  ref?: { provider: string; modelId: string };
  /** Resolution failure (unknown/unparseable model); no submission was made. */
  error?: Error;
  thinkingLevel?: DurableThinkingLevel;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * The ordered attempt plan for one durable run. A frontmatter `models:` list
 * yields one attempt per distinct resolvable model; legacy callers keep the
 * single explicit/session/default model. Resolution failures are captured so
 * a broken primary can still fall over to a working fallback, and are thrown
 * before any child state exists when no chain was configured.
 */
function buildDurableAttempts(
  input: {
    model?: string;
    sessionModel?: { provider: string; modelId: string };
    modelSpecs?: AgentModelSpec[];
    thinkingLevel?: DurableThinkingLevel;
  },
  handle: DurableHarnessHandle,
): DurableAttemptPlan[] {
  const specs = planModelChain(input.modelSpecs);
  if (specs.length > 0) {
    const attempts: DurableAttemptPlan[] = [];
    const seen = new Set<string>();
    for (const spec of specs) {
      let ref: { provider: string; modelId: string } | undefined;
      let error: Error | undefined;
      try {
        ref = parseAgentModel(spec.model, handle.models);
      } catch (cause) {
        error = toError(cause);
      }
      const key = ref ? `${ref.provider}/${ref.modelId}` : `unresolved:${spec.model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      attempts.push({
        label: ref ? `${ref.provider}/${ref.modelId}` : spec.model,
        ...(ref !== undefined ? { ref } : {}),
        ...(error !== undefined ? { error } : {}),
        thinkingLevel: parseDurableThinkingLevel(spec.thinking) ?? input.thinkingLevel,
      });
    }
    return attempts;
  }
  const label =
    input.model ??
    (input.sessionModel
      ? `${input.sessionModel.provider}/${input.sessionModel.modelId}`
      : "default model");
  try {
    const ref = parseAgentModel(input.model, handle.models) ??
      input.sessionModel ??
      defaultModelRef(handle);
    return [
      {
        label,
        ...(ref !== undefined ? { ref } : {}),
        thinkingLevel: input.thinkingLevel,
      },
    ];
  } catch (cause) {
    return [{ label, error: toError(cause), thinkingLevel: input.thinkingLevel }];
  }
}

/**
 * Request id for a fallback attempt. It keeps the `pi-task:<taskId>:call:`
 * shape so legacy recovery can still attribute the submission to its task.
 */
function durableFallbackRequestId(
  baseRequestId: string,
  taskId: string,
  index: number,
): string {
  if (baseRequestId.startsWith("pi-task:") && baseRequestId.includes(":call:")) {
    return `${baseRequestId}:fallback:${index}`;
  }
  return durableRequestId(taskId, `fallback-${index}`);
}

/** Run a durable subagent: find-before-create, exactly-once by task id. */
export async function runDurableTask(input: {
  piDir: string;
  taskId: string;
  task: string;
  cwd?: string;
  /** Explicit agent model ("provider/model"). */
  model?: string;
  /** Structured current-session fallback; avoids lossy provider/model serialization. */
  sessionModel?: { provider: string; modelId: string };
  databasePath?: string;
  models?: DurableModelsFactory;
  modelRegistry?: DurableRuntimeModelRegistry;
  /** Stable parent tool-call id: replays the same submission, new calls resume the same child. */
  requestId?: string;
  /** Agent frontmatter thinking level; without it the child runs at the harness default. */
  thinkingLevel?: DurableThinkingLevel;
  /** Agent frontmatter allowlist; unsupported requested tools fail before child admission. */
  tools?: string | string[];
  /** Agent frontmatter deny list. */
  disallowedTools?: string[];
  /** Parent extension module entry paths by tool name, for bridgeable research tools. */
  parentExtensionToolSources?: Record<string, string>;
  /** Add bash/write/edit/apply_patch to the deny list, even with explicit tools. */
  readonly?: boolean;
  /**
   * Ordered frontmatter models. Each model is attempted at most once per run;
   * only a clear provider/model failure advances to the next entry.
   */
  modelSpecs?: AgentModelSpec[];
  /** Called with each attempt's request id before it is submitted (recovery identity). */
  onRequestId?: (requestId: string) => void;
  /** Mirror the parent's fast mode onto the child's Codex requests. */
  fast?: boolean;
  /** Called once the submission is durably admitted, before it settles. */
  onSubmitted?: (conversationId: string) => void;
  /** Best-effort committed ledger for a failed/cancelled run; never persisted in pi-task history. */
  onTerminalUsage?: (usage: DurableUsage) => void;
  /** Initial committed state for a live durable transcript view. */
  onSnapshot?: (snapshot: import("@earendil-works/pi-durable").SnapshotEvent) => void;
  /** One committed batch from the child conversation's event stream. */
  onEvents?: (events: readonly import("@earendil-works/pi-durable").AgentEvent[]) => void;
  /** Live events are best-effort; report a watch/callback failure without failing the task. */
  onWatchError?: (error: unknown) => void;
  signal?: AbortSignal;
}): Promise<DurableRunResult> {
  const handle = await openDurableHarness(input.piDir, {
    databasePath: input.databasePath,
    models: input.models,
    modelRegistry: input.modelRegistry,
    fast: input.fast,
  });
  const toolRegistrations = await durableToolRegistrations(handle, input);
  const attempts = buildDurableAttempts(input, handle);
  // Legacy (non-chain) callers fail on an invalid explicit model before any
  // child state exists, exactly as before failover existed.
  if (!input.modelSpecs?.length && attempts[0]?.error) throw attempts[0].error;
  const primary = attempts.find((attempt) => attempt.ref !== undefined);
  if (!primary && attempts.every((attempt) => attempt.error === undefined)) {
    // Do not persist an owner mapping for an ownerless conversation when no
    // model can possibly submit the initial durable request. Once a submission
    // exists, recovery remains conservative and never replays it here.
    throw new Error("No model available for durable subagent execution");
  }
  const childId = await findOrCreateChild(
    handle,
    durableOwnerKey(input.taskId),
    {
      model: primary?.ref,
      cwd: input.cwd,
      thinkingLevel: primary?.thinkingLevel,
      tools: toolRegistrations,
    },
  );
  const conversation = (await handle.harness.conversation(childId, handle.context))!;
  let eventStream: import("@earendil-works/pi-durable").AgentEventStream | undefined;
  const reportWatchError = (error: unknown) => {
    try {
      input.onWatchError?.(error);
    } catch {
      // A presentation failure must not replace the durable task's outcome.
    }
  };
  if (input.onSnapshot || input.onEvents) {
    try {
      eventStream = await handle.module.watchEvents(
        handle.harness,
        childId,
        handle.context,
      );
      input.onSnapshot?.(eventStream.snapshot);
      if (input.onEvents) {
        eventStream.start(async (events) => {
          try {
            input.onEvents?.(events);
          } catch (error) {
            reportWatchError(error);
          }
        });
      }
    } catch (error) {
      reportWatchError(error);
      if (eventStream) {
        try {
          await eventStream.stop();
        } catch (stopError) {
          reportWatchError(stopError);
        }
        eventStream = undefined;
      }
    }
  }

  let submissionAdmitted = false;
  let conversationIdle = false;
  let abortRequested = false;
  let abortPromise: Promise<void> | undefined;
  let abortFailure: unknown;
  const requestAbort = () => {
    abortRequested = true;
    if (!submissionAdmitted || abortPromise) return;
    abortPromise = conversation.abort(handle.context).catch((error: unknown) => {
      abortFailure = error;
    });
  };
  const onAbort = () => requestAbort();
  input.signal?.addEventListener("abort", onAbort, { once: true });

  const baseRequestId = input.requestId ?? durableOwnerKey(input.taskId);
  let firstError: Error | undefined;
  const trail: string[] = [];
  /**
   * Record a failed attempt. Returns (and lets the loop advance) only when
   * the failure is a clear model/provider error and another model remains;
   * otherwise it throws the original error, or the original error plus the
   * attempt trail once a fallback was actually used.
   */
  const failAttempt = (
    attempt: DurableAttemptPlan,
    failure: Error,
    canFallback: boolean,
    hasNext: boolean,
  ): void => {
    firstError ??= failure;
    trail.push(`${attempt.label}: ${failure.message}`);
    if (canFallback && hasNext) return;
    if (trail.length > 1 && firstError) throw failoverExhaustedError(firstError, trail);
    throw failure;
  };
  /**
   * Whether a failed attempt may advance the chain. Beyond the classifier,
   * two approved exclusions apply to fresh failures: a steering successor's
   * failure is not a model failure to retry, and an explicit `/model` change
   * owns its failure instead of the frontmatter chain. Replayed terminal
   * records skip the live-model check so a completed chain still replays.
   */
  const classifyFailure = async (
    attempt: DurableAttemptPlan,
    record: {
      reason: string;
      submissionReason?: string;
      detail?: string;
      steering?: boolean;
    },
    checkCurrentModel: boolean,
  ): Promise<boolean> => {
    if (record.steering) return false;
    if (!classifyModelFailover({
      submissionReason: record.submissionReason,
      message: record.detail ?? record.reason,
    }).fallback) return false;
    if (!checkCurrentModel || !attempt.ref) return true;
    try {
      const agent = await conversation.agent(handle.context);
      if (
        agent.model &&
        (agent.model.provider !== attempt.ref.provider ||
          agent.model.modelId !== attempt.ref.modelId)
      ) {
        return false;
      }
    } catch {
      // Unreadable agent state cannot prove the failure belongs to this model.
      return false;
    }
    return true;
  };
  try {
    for (let index = 0; index < attempts.length; index++) {
      const attempt = attempts[index]!;
      if (abortRequested || input.signal?.aborted) throw new DurableTaskCancelledError();
      if (!attempt.ref) {
        const failure = attempt.error ?? new Error(
          input.model !== undefined || input.sessionModel !== undefined
            ? `Model "${attempt.label}" is not available in the model registry`
            : "No model available for durable subagent execution",
        );
        failAttempt(attempt, failure, true, index + 1 < attempts.length);
        continue;
      }
      const requestId = index === 0
        ? baseRequestId
        : durableFallbackRequestId(baseRequestId, input.taskId, index);
      input.onRequestId?.(requestId);
      conversationIdle = false;
      const reservation = await reserveDurableRun(
        handle,
        conversation,
        input.taskId,
        requestId,
        {
          model: attempt.ref,
          ...(attempt.thinkingLevel !== undefined
            ? { thinkingLevel: attempt.thinkingLevel }
            : {}),
          tools: toolRegistrations,
        },
      );
      if (abortRequested || input.signal?.aborted) {
        if (reservation.status === "admitting") {
          const released = await releaseUnadmittedDurableRun(
            input.piDir,
            input.taskId,
            requestId,
            process.pid,
            {
              databasePath: input.databasePath,
              models: input.models,
              modelRegistry: input.modelRegistry,
            },
          );
          if (!released && await handle.hasSubmission(childId, requestId)) {
            submissionAdmitted = true;
            requestAbort();
            if (abortPromise) await abortPromise;
            if (abortFailure !== undefined) {
              throw new Error("durable subagent cancellation failed", { cause: abortFailure });
            }
          }
        }
        throw new DurableTaskCancelledError();
      }
      if (reservation.status === "busy") {
        throw new Error(`Durable task ${input.taskId} already has another active request.`);
      }
      if (isTerminalDurableRun(reservation)) {
        input.onSubmitted?.(String(childId));
        if (reservation.status === "cancelled") {
          throw new DurableTaskCancelledError(reservation.reason);
        }
        if (reservation.status === "failed") {
          const failure = new Error(reservation.reason);
          failAttempt(
            attempt,
            failure,
            await classifyFailure(attempt, reservation, false),
            index + 1 < attempts.length,
          );
          continue;
        }
        const answer = await settledAnswerText(handle, conversation, reservation.answer);
        const usage = parseDurableUsage(reservation.usageJson) ??
          await readConversationUsage(handle, childId);
        return { conversationId: String(childId), answer, usage };
      }

      let submission: import("@earendil-works/pi-durable").Submission;
      try {
        submission = await conversation.submit({
          type: "input",
          content: input.task,
          requestId,
        }, handle.context);
      } catch (error) {
        await conversation.commit(async (tx) => {
          const runs = await tx.doc(handle.runsDoc, conversation.id);
          const current = runs.byRequestId[requestId];
          if (current?.status === "admitting") {
            const admitted = await tx.submissionByRequest(conversation.id, requestId);
            if (!admitted) {
              delete runs.byRequestId[requestId];
              if (runs.activeByTask[input.taskId] === requestId) {
                delete runs.activeByTask[input.taskId];
              }
            }
          }
        }, handle.context);
        throw error;
      }
      submissionAdmitted = true;
      if (abortRequested || input.signal?.aborted) requestAbort();
      const activated = await activateDurableRun(
        handle,
        conversation,
        input.taskId,
        requestId,
      );
      input.onSubmitted?.(String(childId));
      if (isTerminalDurableRun(activated)) {
        conversationIdle = true;
        if (activated.status === "cancelled") {
          throw new DurableTaskCancelledError(activated.reason);
        }
        if (activated.status === "failed") {
          const failure = new Error(activated.reason);
          failAttempt(
            attempt,
            failure,
            await classifyFailure(attempt, activated, false),
            index + 1 < attempts.length,
          );
          continue;
        }
        const answer = await settledAnswerText(handle, conversation, activated.answer);
        const usage = parseDurableUsage(activated.usageJson) ??
          await readConversationUsage(handle, childId);
        return { conversationId: String(childId), answer, usage };
      }

      await submission.wait(handle.context);
      const settledRun = await settleDurableRun(
        handle,
        conversation,
        input.taskId,
        requestId,
      );
      conversationIdle = true;
      if (input.signal?.aborted && abortFailure !== undefined) {
        throw new Error("durable subagent cancellation failed", { cause: abortFailure });
      }
      if (settledRun.status === "cancelled") {
        throw new DurableTaskCancelledError(settledRun.reason);
      }
      if (settledRun.status === "failed") {
        const failure = new Error(settledRun.reason);
        failAttempt(
          attempt,
          failure,
          await classifyFailure(attempt, settledRun, true),
          index + 1 < attempts.length,
        );
        continue;
      }
      if (settledRun.status !== "done") {
        throw new Error("Durable task lifecycle did not reach a terminal outcome.");
      }
      const answer = await settledAnswerText(handle, conversation, settledRun.answer);
      const usage = parseDurableUsage(settledRun.usageJson) ??
        await readConversationUsage(handle, childId);
      return { conversationId: String(childId), answer, usage };
    }
    throw new Error("Durable task lifecycle did not reach a terminal outcome.");
  } catch (error) {
    try {
      if (submissionAdmitted && !conversationIdle) {
        await conversation.waitForIdle(handle.context);
        conversationIdle = true;
      }
    } catch {
      // Usage remains best-effort when the conversation cannot be observed idle.
    }
    try {
      if (abortPromise) await abortPromise;
      input.onTerminalUsage?.(await readConversationUsage(handle, childId));
    } catch {
      // A receipt enrichment failure must not replace the original task outcome.
    }
    throw error;
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
    try {
      if (submissionAdmitted && !conversationIdle) {
        await conversation.waitForIdle(handle.context);
      }
    } finally {
      if (abortPromise) await abortPromise;
      if (eventStream) {
        try {
          await eventStream.stop();
        } catch (error) {
          reportWatchError(error);
        }
      }
    }
  }
}

/** Read the assistant text out of a settled submission's answer entry. */
async function settledAnswerText(
  handle: DurableHarnessHandle,
  conversation: import("@earendil-works/pi-durable").Conversation,
  answer: EntryId,
): Promise<string> {
  const entry = await conversation.commit(
    (tx) => tx.entry(handle.module.AssistantEntry, answer),
    handle.context,
  );
  const message = entry?.model?.[0] as
    | { content: { type: string; text?: string }[] }
    | undefined;
  return (message?.content ?? [])
    .flatMap((c) => (c.type === "text" && c.text ? [c.text] : []))
    .join("");
}

/** Queue a steering message on the child conversation of a running task. */
export async function steerDurableTask(
  piDir: string,
  taskId: string,
  text: string,
  options: {
    databasePath?: string;
    modelRegistry?: DurableRuntimeModelRegistry;
  } = {},
): Promise<string | null> {
  const handle = await openDurableHarness(piDir, options);
  const conversation = await findChild(handle, taskId);
  if (!conversation) return `No durable child conversation for task ${taskId}.`;

  // The public submit({ whenBusy: "steer" }) also admits input while idle. For
  // transcript steering, admission and the active-run check must share a commit
  // so a settled task cannot acquire an untracked successor.
  const requestId = durableRequestId(taskId, `steer-${randomUUID()}`);
  const admitted = await conversation.commit(async (tx) => {
    const runs = await tx.doc(handle.runsDoc, conversation.id);
    const activeRequestId = runs.activeByTask[taskId];
    const activeRun = activeRequestId
      ? runs.byRequestId[activeRequestId]
      : undefined;
    if (!activeRun || activeRun.status !== "running") return false;
    const live = await tx.doc(handle.module.LiveDoc, conversation.id);
    if (!live.run) return false;
    const runTask = await tx.task(live.run.taskId);
    if (
      !runTask ||
      runTask.abortRequested ||
      runTask.state.status === "completing" ||
      runTask.state.status === "terminal"
    ) {
      return false;
    }
    const inbox = await tx.doc(handle.module.InboxDoc, conversation.id);
    const submission = await tx.createSubmission({
      conversationId: conversation.id,
      requestId,
      type: "input",
      status: "queued",
    });
    inbox.items.push({ id: submission.id, mode: "steer", content: text });
    activeRun.steeringRequestIds.push(requestId);
    return true;
  }, handle.context);
  return admitted ? null : `Durable task ${taskId} is no longer running; steering was not admitted.`;
}

function durableThinkingLevels(
  model: import("@earendil-works/pi-ai").Model<import("@earendil-works/pi-ai").Api> | undefined,
): DurableThinkingLevel[] {
  if (!model) return ["off"];
  // Pi's canonical rule: a non-reasoning model supports only `off`; `xhigh`
  // and `max` are accepted only when `thinkingLevelMap` explicitly maps them,
  // and every other level is accepted unless it is explicitly mapped to null.
  // Delegating keeps the durable clamp identical to the parent session's.
  return getSupportedThinkingLevels(model);
}

function durableModelForArgument(
  handle: DurableHarnessHandle,
  argument: string,
): import("@earendil-works/pi-ai").Model<import("@earendil-works/pi-ai").Api> | undefined {
  const separator = argument.indexOf("/");
  if (separator > 0) {
    const exact = handle.models.getModel(
      argument.slice(0, separator),
      argument.slice(separator + 1),
    );
    if (exact) return exact;
  }
  return handle.models.getAllModels().find(
    (candidate) => candidate.id === argument || candidate.name === argument,
  ) as import("@earendil-works/pi-ai").Model<import("@earendil-works/pi-ai").Api> | undefined;
}

type DurableHistoryEntry = TaskSessionHistoryEntry;

function historyOption(entry: DurableHistoryEntry): ChildHistoryOption {
  return {
    taskId: entry.id,
    agentType: entry.agentType,
    description: entry.description,
    sessionName: entry.sessionName,
    status: entry.status,
    ...(entry.cwd ? { cwd: entry.cwd } : {}),
    startedAt: entry.startedAt,
    ...(typeof entry.completedAt === "number" ? { completedAt: entry.completedAt } : {}),
  };
}

async function scopedDurableHistory(
  handle: DurableHarnessHandle,
  piDir: string,
  currentTaskId: string,
): Promise<{ current: DurableHistoryEntry; entries: DurableHistoryEntry[] }> {
  const history = readTaskSessionHistory(piDir);
  const current = history.find((entry) => entry.id === currentTaskId);
  if (!current || current.backend !== "durable" || current.runtime === "claude") {
    throw new Error(`No durable child history is attributed to task ${currentTaskId}.`);
  }
  const children = await handle.harness.snapshot(handle.children, handle.context);
  const mappedConversationId = (entry: DurableHistoryEntry): string | undefined => {
    if (entry.backend !== "durable" || entry.runtime === "claude") return undefined;
    const owned = children?.byOwner[durableOwnerKey(entry.id)];
    if (!owned || owned.conversationId === undefined) return undefined;
    const conversationId = String(owned.conversationId);
    // A missing legacy field may be recovered only from the task-id-specific
    // durable owner map. Any recorded value remains an assertion to verify.
    if (
      entry.conversationId !== undefined &&
      (typeof entry.conversationId !== "string" || entry.conversationId !== conversationId)
    ) return undefined;
    return conversationId;
  };
  const currentConversationId = mappedConversationId(current);
  // The current task must be a valid entrypoint, but owner session/leaf metadata
  // intentionally does not narrow this project-database browsing history.
  if (currentConversationId === undefined) {
    throw new Error(`Durable ownership metadata does not match task ${currentTaskId}.`);
  }
  const entries = history.flatMap((entry) => {
    const conversationId = mappedConversationId(entry);
    return conversationId === undefined ? [] : [{ ...entry, conversationId }];
  });
  return {
    current: { ...current, conversationId: currentConversationId },
    entries,
  };
}

/**
 * Read a selected durable task's transcript for browsing, verifying its
 * project task-history entry against the durable byOwner mapping. This is a
 * snapshot read only: no task is resumed, steered, or adopted into active maps.
 */
export async function readDurableTaskHistoryTranscript(
  piDir: string,
  currentTaskId: string,
  selectedTaskId: string,
  options: {
    databasePath?: string;
    models?: DurableModelsFactory;
    modelRegistry?: DurableRuntimeModelRegistry;
  } = {},
): Promise<DurableChildHistoryTranscript> {
  const handle = await openDurableHarness(piDir, options);
  const { entries } = await scopedDurableHistory(handle, piDir, currentTaskId);
  const selected = entries.find((entry) => entry.id === selectedTaskId);
  if (!selected?.conversationId) {
    throw new Error(`Durable child task ${selectedTaskId} is not in this task's attributed history.`);
  }
  const conversation = await handle.harness.conversation(selected.conversationId as unknown as ConversationId, handle.context);
  if (!conversation) throw new Error(`Durable child conversation for task ${selectedTaskId} is unavailable.`);
  const stream = await handle.module.watchEvents(handle.harness, conversation.id, handle.context);
  try {
    const transcript = new DurableTranscript(stream.snapshot);
    return {
      option: historyOption(selected),
      items: transcript.items(),
      agent: transcript.agentState(),
      metadata: transcript.usageMetadata(),
    };
  } finally {
    try {
      await stream.stop();
    } catch {
      // A static snapshot is already captured; watcher cleanup must not hide it.
    }
  }
}

/**
 * Read one durable child selected from /agents' parent-session-scoped history.
 * The owner check narrows the caller-facing list; the ordinary reader below is
 * still used with the selected task as its entrypoint, so its durable byOwner
 * mapping check remains authoritative and cannot be bypassed by this adapter.
 */
export async function readDurableTaskHistoryTranscriptForOwner(
  piDir: string,
  ownerSessionId: string,
  selectedTaskId: string,
  options: {
    databasePath?: string;
    models?: DurableModelsFactory;
    modelRegistry?: DurableRuntimeModelRegistry;
  } = {},
): Promise<DurableChildHistoryTranscript> {
  const selected = readTaskSessionHistory(piDir).find((entry) => entry.id === selectedTaskId);
  if (
    !ownerSessionId ||
    !selected ||
    selected.ownerSessionId !== ownerSessionId ||
    selected.backend !== "durable" ||
    selected.runtime === "claude"
  ) {
    throw new Error(`Durable child task ${selectedTaskId} is not attributed to this parent session.`);
  }
  return readDurableTaskHistoryTranscript(piDir, selectedTaskId, selectedTaskId, options);
}

/**
 * Run one child-scoped control against the durable child conversation. The
 * active-run check prevents a stale task row from mutating a settled child;
 * read-only session/history browsing remains available after settlement.
 */
export async function executeDurableChildBuiltinCommand(
  piDir: string,
  taskId: string,
  command: ChildBuiltinCommand,
  options: {
    databasePath?: string;
    models?: DurableModelsFactory;
    modelRegistry?: DurableRuntimeModelRegistry;
  } = {},
): Promise<ChildBuiltinCommandResult> {
  const info = (message: string): ChildBuiltinCommandResult => ({ level: "info", message });
  const failure = (message: string): ChildBuiltinCommandResult => ({ level: "error", message });
  try {
    const handle = await openDurableHarness(piDir, options);
    const conversation = await findChild(handle, taskId);
    if (!conversation) return failure(`No durable child conversation for task ${taskId}.`);

    const active = await durableChildRunActive(handle, conversation, taskId);
    if (!active && !(
      (command.name === "session" || command.name === "resume") && !command.argument
    )) {
      return failure(`Durable task ${taskId} is no longer active; its child transcript is read-only.`);
    }

    if (command.name === "resume") {
      if (command.argument) return failure("Use /resume without an argument to browse durable child history.");
      const { entries } = await scopedDurableHistory(handle, piDir, taskId);
      const historyPicker: ChildHistoryPickerData = {
        currentTaskId: taskId,
        sessions: entries
          .map(historyOption)
          .sort((left, right) => right.startedAt - left.startedAt || left.taskId.localeCompare(right.taskId)),
      };
      return {
        ...info("Choose a mapped durable child transcript from this project's database; execution and task ownership are unchanged."),
        historyPicker,
      };
    }

    const agent = await conversation.agent(handle.context);
    if (command.name === "model") {
      const models = handle.models.getAllModels().filter(
        (candidate) => candidate.type === undefined || candidate.type === "chat",
      );
      if (!command.argument) {
        const current = agent.model ? `${agent.model.provider}/${agent.model.modelId}` : "none";
        const choices = models.map((model) => `${model.provider}/${model.id}`);
        return {
          ...info(
            `Child model: ${current}. Set with /model <provider/model>. Available: ${choices.join(", ") || "none"}.`,
          ),
          selector: {
            kind: "model",
            models: models.map((model) => ({
              provider: model.provider,
              id: model.id,
              name: model.name || model.id,
            })),
            ...(agent.model
              ? { currentModel: { provider: agent.model.provider, id: agent.model.modelId } }
              : {}),
          },
        };
      }
      const model = durableModelForArgument(handle, command.argument);
      if (!model || (model.type !== undefined && model.type !== "chat")) {
        return failure(`Unknown child model "${command.argument}". Use /model to list available child models.`);
      }
      const modelRef = { provider: model.provider, modelId: model.id };
      const supportedLevels = durableThinkingLevels(model);
      const configured = await configureActiveDurableChild(
        handle,
        conversation,
        taskId,
        {
          model: modelRef,
          ...(!supportedLevels.includes(agent.thinkingLevel as DurableThinkingLevel)
            ? { thinkingLevel: "off" as const }
            : {}),
        },
      );
      if (!configured) {
        return failure(`Durable task ${taskId} settled before the child model change; its transcript is read-only.`);
      }
      return info(`Child model set to ${modelRef.provider}/${modelRef.modelId}.`);
    }

    if (command.name === "thinking") {
      const model = agent.model
        ? handle.models.getModel(agent.model.provider, agent.model.modelId)
        : undefined;
      const levels = durableThinkingLevels(model);
      if (!command.argument) {
        return {
          ...info(
            `Child thinking level: ${agent.thinkingLevel}. Available: ${levels.join(", ")}. Set with /thinking <level>.`,
          ),
          selector: {
            kind: "thinking",
            currentLevel: agent.thinkingLevel as DurableThinkingLevel,
            levels,
          },
        };
      }
      const level = parseDurableThinkingLevel(command.argument);
      if (!level || !levels.includes(level)) {
        return failure(
          `Unknown or unsupported child thinking level "${command.argument}". Available levels: ${levels.join(", ")}.`,
        );
      }
      const configured = await configureActiveDurableChild(
        handle,
        conversation,
        taskId,
        { thinkingLevel: level },
      );
      if (!configured) {
        return failure(`Durable task ${taskId} settled before the thinking-level change; its transcript is read-only.`);
      }
      return info(`Child thinking level set to ${level}.`);
    }

    if (command.name === "session") {
      const [context, usageState] = await Promise.all([
        conversation.context(handle.context),
        handle.harness.snapshot(handle.usageDoc, conversation.id, handle.context),
      ]);
      const counts = {
        scope: "current context" as const,
        userMessages: 0,
        assistantMessages: 0,
        toolCalls: 0,
        toolResults: 0,
        totalMessages: 0,
      };
      for (const message of context.messages) {
        counts.totalMessages++;
        if (message.role === "user") counts.userMessages++;
        else if (message.role === "assistant") {
          counts.assistantMessages++;
          if (Array.isArray(message.content)) {
            counts.toolCalls += message.content.filter((block) => block.type === "toolCall").length;
          }
        } else if (message.role === "toolResult") counts.toolResults++;
      }
      const usageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
      let usageEntries = 0;
      for (const bucket of [usageState?.models, usageState?.tools]) {
        for (const usage of Object.values(bucket ?? {})) {
          if (
            !usage ||
            ![usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.cost?.total]
              .every((value) => typeof value === "number" && Number.isFinite(value))
          ) continue;
          usageTotals.input += usage.input;
          usageTotals.output += usage.output;
          usageTotals.cacheRead += usage.cacheRead;
          usageTotals.cacheWrite += usage.cacheWrite;
          usageTotals.cost += usage.cost.total;
          usageEntries++;
        }
      }
      const model = agent.model
        ? `${agent.model.provider}/${agent.model.modelId}`
        : undefined;
      const sessionInfo: ChildSessionInfo = {
        sessionId: String(conversation.id),
        storagePath: options.databasePath ?? durableDatabasePath(piDir),
        ...(model ? { model } : {}),
        ...(agent.thinkingLevel ? { thinkingLevel: agent.thinkingLevel } : {}),
        ...(agent.cwd ? { cwd: agent.cwd } : {}),
        counts,
        ...(usageEntries > 0
          ? {
              tokens: {
                input: usageTotals.input,
                output: usageTotals.output,
                cacheRead: usageTotals.cacheRead,
                cacheWrite: usageTotals.cacheWrite,
                total: usageTotals.input + usageTotals.output + usageTotals.cacheRead + usageTotals.cacheWrite,
              },
              cost: usageTotals.cost,
            }
          : {}),
      };
      return { ...info(`Showing session information for durable child ${String(conversation.id)}.`), sessionInfo };
    }

    if (command.name === "compact") {
      // Conversation.compact() admits its task in a separate commit, so the
      // same admission predicate configure applies atomically is re-checked
      // here. A run that settles in the window is accepted: the manual
      // compaction is then conversation-owned, may finish after this view
      // closes, and its progress is not visible in the panel. Settlement waits
      // for conversation idle, so manual compaction can delay task completion.
      if (!(await durableChildRunActive(handle, conversation, taskId))) {
        return failure(`Durable task ${taskId} settled before the child compaction was admitted; its transcript is read-only.`);
      }
      await conversation.compact(command.argument || undefined, handle.context);
      return info(
        `Compaction admitted for durable child task ${taskId}; it may finish after this view closes, and its progress is not shown in the panel. Task completion may be delayed until compaction finishes.`,
      );
    }

    return failure(`/${command.name} is not implemented for durable child sessions.`);
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}

/** Abort the child conversation of a task; resolves once it is idle. */
export async function abortDurableTask(
  piDir: string,
  taskId: string,
  options: {
    databasePath?: string;
    modelRegistry?: DurableRuntimeModelRegistry;
  } = {},
): Promise<string | null> {
  const handle = await openDurableHarness(piDir, options);
  const conversation = await findChild(handle, taskId);
  if (!conversation) return `No durable child conversation for task ${taskId}.`;
  await conversation.abort(handle.context);
  return null;
}

/**
 * Resume durable parent-request lifecycles after a parent restart. Accepted
 * steering IDs live with their parent request, so discovery is only a starting
 * point: settlement re-reads the lifecycle atomically after each idle wait.
 * Fire-and-forget per request by design; failures are reported independently.
 */
export async function resumeDurableTasks(
  piDir: string,
  hooks: {
    onRecovered?: (taskId: string, output: string, usage: DurableUsage) => void;
    onFailed?: (taskId: string, reason: string, usage?: DurableUsage) => void;
    onCancelled?: (taskId: string, reason: string, usage?: DurableUsage) => void;
    /** Exclude already delivered or foreign-session request lifecycles. */
    shouldRecover?: (taskId: string, requestId: string, conversationId: string) => boolean;
    /** Exact parent request recorded in task history; used for legacy rows without a run doc. */
    requestIdForTask?: (taskId: string) => string | undefined;
    /** Return false to resume without exposing this task in the current session. */
    onActive?: (taskId: string, conversationId: string) => boolean | void;
    onSnapshot?: (
      taskId: string,
      snapshot: import("@earendil-works/pi-durable").SnapshotEvent,
    ) => void;
    onEvents?: (
      taskId: string,
      events: readonly import("@earendil-works/pi-durable").AgentEvent[],
    ) => void;
    onWatchError?: (taskId: string, error: unknown) => void;
    onSettled?: (taskId: string, status: "done" | "failed" | "cancelled") => void;
  } = {},
  options: {
    databasePath?: string;
    models?: DurableModelsFactory;
    modelRegistry?: DurableRuntimeModelRegistry;
    fast?: boolean;
  } = {},
): Promise<void> {
  const handle = await openDurableHarness(piDir, {
    databasePath: options.databasePath,
    models: options.models,
    modelRegistry: options.modelRegistry,
    fast: options.fast,
  });
  const inspection = await handle.harness.inspect(handle.context);
  const groups = new Map<
    string,
    { taskId: string; requestId: string; conversationId: ConversationId }
  >();
  const addGroup = (
    taskId: string,
    requestId: string,
    conversationId: ConversationId,
    record: DurableRunRecord,
  ) => {
    const conversationKey = String(conversationId);
    if (hooks.shouldRecover?.(taskId, requestId, conversationKey) === false) return;
    if (
      isTerminalDurableRun(record) &&
      !hooks.shouldRecover?.(taskId, requestId, conversationKey)
    ) return;
    groups.set(`${conversationKey}\u0000${requestId}`, {
      taskId,
      requestId,
      conversationId,
    });
  };

  const children = await handle.harness.snapshot(handle.children, handle.context);
  const knownRuns = new Set<string>();
  for (const [ownerKey, child] of Object.entries(children?.byOwner ?? {})) {
    if (!ownerKey.startsWith("pi-task:")) continue;
    const taskId = ownerKey.slice("pi-task:".length);
    const runState = await handle.harness.snapshot(
      handle.runsDoc,
      child.conversationId,
      handle.context,
    );
    const activeRequestId = runState?.activeByTask[taskId];
    for (const [requestId, record] of Object.entries(runState?.byRequestId ?? {})) {
      if (record.taskId !== taskId) continue;
      let recoverableRecord = record;
      if (record.status === "admitting") {
        const conversationKey = String(child.conversationId);
        if (hooks.shouldRecover?.(taskId, requestId, conversationKey) === false) {
          knownRuns.add(`${conversationKey}\u0000${taskId}`);
          continue;
        }
        const conversation = await handle.harness.conversation(
          child.conversationId,
          handle.context,
        );
        if (!conversation) continue;
        const promoted = await promoteRecoveredDurableRun(
          handle,
          conversation,
          taskId,
          requestId,
        );
        if (!promoted) continue;
        recoverableRecord = promoted;
      }
      if (
        recoverableRecord.status !== "admitting" && recoverableRecord.status !== "running" &&
        requestId !== activeRequestId &&
        !hooks.shouldRecover?.(taskId, requestId, String(child.conversationId))
      ) continue;
      knownRuns.add(`${String(child.conversationId)}\u0000${taskId}`);
      addGroup(taskId, requestId, child.conversationId, recoverableRecord);
    }
  }

  // Reconstruct a lifecycle for work admitted by an older host before the
  // request-scoped document existed. The exact request ID comes from history
  // where available; accepted steering remains limited to visible active IDs.
  const legacy = new Map<
    string,
    { taskId: string; conversationId: ConversationId; requestIds: string[] }
  >();
  for (const submission of inspection.submissions) {
    const taskId = taskIdFromRequestId(submission.requestId);
    if (!taskId) continue;
    const key = `${String(submission.conversationId)}\u0000${taskId}`;
    if (knownRuns.has(key)) continue;
    let group = legacy.get(key);
    if (!group) {
      group = { taskId, conversationId: submission.conversationId, requestIds: [] };
      legacy.set(key, group);
    }
    if (submission.requestId && !group.requestIds.includes(submission.requestId)) {
      group.requestIds.push(submission.requestId);
    }
  }
  for (const group of legacy.values()) {
    const requestId = hooks.requestIdForTask?.(group.taskId) ??
      group.requestIds.find((id) => !id.includes(":call:steer-")) ??
      durableOwnerKey(group.taskId);
    if (hooks.shouldRecover?.(group.taskId, requestId, String(group.conversationId)) === false) {
      continue;
    }
    const conversation = await handle.harness.conversation(group.conversationId, handle.context);
    if (!conversation) continue;
    const record = await conversation.commit(async (tx) => {
      const runs = await tx.doc(handle.runsDoc, group.conversationId);
      const existing = runs.byRequestId[requestId];
      if (existing && existing.status !== "admitting" && existing.status !== "running") {
        return copyDurableRunRecord(existing);
      }
      const steeringRequestIds = group.requestIds.filter((id) => id !== requestId);
      const running: DurableRunRecord = existing?.status === "running"
        ? {
            ...existing,
            steeringRequestIds: [...new Set([...existing.steeringRequestIds, ...steeringRequestIds])],
          }
        : { taskId: group.taskId, status: "running", steeringRequestIds };
      runs.byRequestId[requestId] = running;
      runs.activeByTask[group.taskId] = requestId;
      return running;
    }, handle.context);
    addGroup(group.taskId, requestId, group.conversationId, record);
  }

  for (const group of groups.values()) {
    const { taskId, requestId, conversationId } = group;
    const conversation = await handle.harness.conversation(conversationId, handle.context);
    if (!conversation) continue;
    const reportWatchError = (error: unknown) => {
      try {
        hooks.onWatchError?.(taskId, error);
      } catch {
        // Restored progress is best-effort and must not affect recovery.
      }
    };
    let shouldWatch = true;
    try {
      shouldWatch = hooks.onActive?.(taskId, String(conversationId)) !== false;
    } catch (error) {
      shouldWatch = false;
      reportWatchError(error);
    }
    let eventStream: import("@earendil-works/pi-durable").AgentEventStream | undefined;
    if (shouldWatch && (hooks.onSnapshot || hooks.onEvents)) {
      try {
        eventStream = await handle.module.watchEvents(
          handle.harness,
          conversationId,
          handle.context,
        );
        hooks.onSnapshot?.(taskId, eventStream.snapshot);
        if (hooks.onEvents) {
          eventStream.start(async (events) => {
            try {
              hooks.onEvents?.(taskId, events);
            } catch (error) {
              reportWatchError(error);
            }
          });
        }
      } catch (error) {
        reportWatchError(error);
        if (eventStream) {
          try {
            await eventStream.stop();
          } catch (stopError) {
            reportWatchError(stopError);
          }
          eventStream = undefined;
        }
      }
    }

    let outcome: "done" | "failed" | "cancelled" = "failed";
    const reportFailure = async (reason: string) => {
      let usage: DurableUsage | undefined;
      try {
        usage = await readConversationUsage(handle, conversationId);
      } catch {
        // Failure receipts include usage only when the committed ledger is readable.
      }
      try {
        hooks.onFailed?.(taskId, reason, usage);
      } catch {
        // Recovery of sibling tasks must continue independently.
      }
    };
    void (async () => {
      const settled = await settleDurableRun(
        handle,
        conversation,
        taskId,
        requestId,
      );
      if (settled.status === "cancelled") {
        outcome = "cancelled";
        let usage: DurableUsage | undefined;
        try {
          usage = await readConversationUsage(handle, conversationId);
        } catch {
          // Cancellation receipts include usage only when the committed ledger is readable.
        }
        try {
          hooks.onCancelled?.(taskId, settled.reason, usage);
        } catch {
          // Cancellation reporting is best-effort; the harness is already idle.
        }
        return;
      }
      if (settled.status === "failed") {
        await reportFailure(settled.reason);
        return;
      }
      if (settled.status !== "done") {
        await reportFailure("Durable task lifecycle did not reach a terminal result.");
        return;
      }
      const output = await settledAnswerText(handle, conversation, settled.answer);
      hooks.onRecovered?.(
        taskId,
        output,
        parseDurableUsage(settled.usageJson) ??
          await readConversationUsage(handle, conversation.id),
      );
      outcome = "done";
    })()
      .catch(async (error: unknown) => {
        await reportFailure(error instanceof Error ? error.message : String(error));
      })
      .finally(async () => {
        if (eventStream) {
          try {
            await eventStream.stop();
          } catch (error) {
            reportWatchError(error);
          }
        }
        try {
          hooks.onSettled?.(taskId, outcome);
        } catch {
          // A row cleanup failure must not affect other recovered tasks.
        }
      });
  }
}
