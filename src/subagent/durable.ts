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

import { createTaskFastModeModelMatcher } from "../fast-mode.js";

/** The subset of the pi-durable module the backend uses. */
type DurableModule = typeof import("@earendil-works/pi-durable");

type DurableHarness = import("@earendil-works/pi-durable").Harness;
type ChordContext = import("@earendil-works/chord").Context;
type ConversationId = import("@earendil-works/pi-durable").ConversationId;
type EntryId = import("@earendil-works/pi-durable").EntryId;

type DurableRunRecord =
  | { taskId: string; status: "admitting"; ownerPid?: number }
  | {
      taskId: string;
      status: "running";
      steeringRequestIds: string[];
      strandedSteeringReason?: string;
    }
  | { taskId: string; status: "done"; answer: EntryId; usageJson?: string }
  | { taskId: string; status: "failed"; reason: string }
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
    const storage = await sqlite.openNodeSqliteStorage(databasePath);
    const harness = await durable.Harness.open(
      storage,
      {
        models,
        registry,
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
      hasSubmission: async (conversationId: ConversationId, requestId: string) =>
        (await storage.submissionByRequest(conversationId, requestId, context)) !== undefined,
      children,
      runsDoc,
      usageDoc: durable.UsageDoc,
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

/** Reserve one parent request before it can accept any transcript steering. */
async function reserveDurableRun(
  handle: DurableHarnessHandle,
  conversation: import("@earendil-works/pi-durable").Conversation,
  taskId: string,
  requestId: string,
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
    return copyDurableRunRecord(runs.byRequestId[requestId]!);
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
        terminal = {
          taskId,
          status: "failed",
          reason: `durable subagent failed: ${describeUnansweredSubmission(failedSubmission)}`,
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
  /** Mirror the parent's fast mode onto the child's Codex requests. */
  fast?: boolean;
  /** Called once the submission is durably admitted, before it settles. */
  onSubmitted?: (conversationId: string) => void;
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
  const childId = await findOrCreateChild(
    handle,
    durableOwnerKey(input.taskId),
    {
      model:
        parseAgentModel(input.model, handle.models) ??
        input.sessionModel ??
        defaultModelRef(handle),
      cwd: input.cwd,
      thinkingLevel: input.thinkingLevel,
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

  const requestId = input.requestId ?? durableOwnerKey(input.taskId);
  try {
    if (input.signal?.aborted) throw new DurableTaskCancelledError();
    const reservation = await reserveDurableRun(
      handle,
      conversation,
      input.taskId,
      requestId,
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
      if (input.signal?.aborted) throw new DurableTaskCancelledError();
      input.onSubmitted?.(String(childId));
      if (reservation.status === "failed") throw new Error(reservation.reason);
      if (reservation.status === "cancelled") {
        throw new DurableTaskCancelledError(reservation.reason);
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
      if (activated.status === "failed") throw new Error(activated.reason);
      if (activated.status === "cancelled") {
        throw new DurableTaskCancelledError(activated.reason);
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
    if (settledRun.status === "failed") throw new Error(settledRun.reason);
    if (settledRun.status !== "done") {
      throw new Error("Durable task lifecycle did not reach a terminal outcome.");
    }
    const answer = await settledAnswerText(handle, conversation, settledRun.answer);
    const usage = parseDurableUsage(settledRun.usageJson) ??
      await readConversationUsage(handle, childId);
    return { conversationId: String(childId), answer, usage };
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
    onFailed?: (taskId: string, reason: string) => void;
    onCancelled?: (taskId: string, reason: string) => void;
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
    const reportFailure = (reason: string) => {
      try {
        hooks.onFailed?.(taskId, reason);
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
        try {
          hooks.onCancelled?.(taskId, settled.reason);
        } catch {
          // Cancellation reporting is best-effort; the harness is already idle.
        }
        return;
      }
      if (settled.status === "failed") {
        reportFailure(settled.reason);
        return;
      }
      if (settled.status !== "done") {
        reportFailure("Durable task lifecycle did not reach a terminal result.");
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
      .catch((error: unknown) => {
        reportFailure(error instanceof Error ? error.message : String(error));
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
