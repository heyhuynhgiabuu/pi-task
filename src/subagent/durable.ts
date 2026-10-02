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

import { join } from "node:path";

/** The subset of the pi-durable module the backend uses. */
type DurableModule = typeof import("@earendil-works/pi-durable");

type DurableHarness = import("@earendil-works/pi-durable").Harness;
type ChordContext = import("@earendil-works/chord").Context;
type ConversationId = import("@earendil-works/pi-durable").ConversationId;

/** Test seam: build the harness model registry instead of createModels(). */
export type DurableModelsFactory = (
  durable: DurableModule,
) => import("@earendil-works/pi-ai").Models;

export interface DurableHarnessHandle {
  harness: DurableHarness;
  module: DurableModule;
  context: ChordContext;
  models: import("@earendil-works/pi-ai").Models;
  /** Owner key -> child conversation id, durable across restarts. */
  children: import("@earendil-works/pi-durable").SessionDocToken<{
    byOwner: Record<string, { conversationId: ConversationId }>;
  }>;
}

const harnessCache = new Map<string, Promise<DurableHarnessHandle>>();

export function durableOwnerKey(taskId: string): string {
  return `pi-task:${taskId}`;
}

export function durableDatabasePath(piDir: string): string {
  return join(piDir, "durable", "tasks.sqlite");
}

/**
 * Open (once per database) the harness that runs durable subagent tasks.
 * `models` is a test seam: production uses `createModels()`, whose providers
 * read env keys, so OAuth-backed models need the credential bridge work.
 */
export async function openDurableHarness(
  piDir: string,
  options: { databasePath?: string; models?: DurableModelsFactory } = {},
): Promise<DurableHarnessHandle> {
  const databasePath = options.databasePath ?? durableDatabasePath(piDir);
  const cached = harnessCache.get(databasePath);
  if (cached) return cached;
  const promise = (async () => {
    const [durable, sqlite, chordContext] = await Promise.all([
      import("@earendil-works/pi-durable"),
      import("@earendil-works/pi-durable/storage/sqlite/node"),
      import("@earendil-works/chord/context"),
    ]);
    const { createModels } = await import("@earendil-works/pi-ai/models");
    const { NodeExecutionEnv } = await import("@earendil-works/pi-durable/env/node");
    const { CodingTools } = await import("@earendil-works/pi-durable/tools");
    const models = options.models ? options.models(durable) : createModels();
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
    return {
      harness,
      module: durable,
      context: chordContext.BACKGROUND_CONTEXT as ChordContext,
      models,
      children,
    };
  })();
  harnessCache.set(databasePath, promise);
  return promise;
}

/** Find-before-create in one atomic commit (pi-durable example 22 pattern). */
async function findOrCreateChild(
  handle: DurableHarnessHandle,
  ownerKey: string,
  configure?: { model?: { provider: string; modelId: string }; cwd?: string },
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
  const byOwner = await root.commit(async (tx) => {
    const map = await tx.doc(handle.children);
    // The draft is a transaction overlay: read primitives inside the commit —
    // nested tracked objects throw "settled overlay" after it settles.
    return Object.entries(map.byOwner).map(([key, value]) => ({
      ownerKey: key,
      conversationId: value.conversationId,
    }));
  }, handle.context);
  const childId = byOwner.find(
    (child) => child.ownerKey === durableOwnerKey(taskId),
  )?.conversationId;
  if (childId === undefined) return undefined;
  return handle.harness.conversation(childId, handle.context);
}

/** Parse AgentConfig.model ("provider/model" or "provider/model/thinking"). */
function parseAgentModel(model?: string): {
  provider: string;
  modelId: string;
} | undefined {
  if (!model) return undefined;
  const [provider, modelId] = model.split("/");
  if (!provider || !modelId) return undefined;
  return { provider, modelId };
}

/** The harness default: the first registered chat model, when one exists. */
function defaultModelRef(handle: DurableHarnessHandle): {
  provider: string;
  modelId: string;
} | undefined {
  const first = handle.models.getAllModels()[0];
  return first ? { provider: first.provider, modelId: first.id } : undefined;
}

export interface DurableRunResult {
  conversationId: string;
  answer: string;
}

/** Run a durable subagent: find-before-create, exactly-once by task id. */
export async function runDurableTask(input: {
  piDir: string;
  taskId: string;
  task: string;
  cwd?: string;
  /** Agent frontmatter model ("provider/model"); absent uses the harness default. */
  model?: string;
  databasePath?: string;
  models?: DurableModelsFactory;
  /** Called once the submission is durably admitted, before it settles. */
  onSubmitted?: (conversationId: string) => void;
}): Promise<DurableRunResult> {
  const handle = await openDurableHarness(input.piDir, {
    databasePath: input.databasePath,
    models: input.models,
  });
  const childId = await findOrCreateChild(
    handle,
    durableOwnerKey(input.taskId),
    {
      model: parseAgentModel(input.model) ?? defaultModelRef(handle),
      cwd: input.cwd,
    },
  );
  const conversation = (await handle.harness.conversation(childId, handle.context))!;
  const request = {
    type: "input",
    content: input.task,
    requestId: durableOwnerKey(input.taskId),
  } as const;
  const submission = await conversation.submit(request, handle.context);
  input.onSubmitted?.(String(childId));
  const settled = await submission.wait(handle.context);
  if (settled.status !== "done" || settled.type !== "input") {
    const reason = "reason" in settled ? String(settled.reason) : settled.status;
    throw new Error(`durable subagent failed: ${reason}`);
  }
  const answer = await settledAnswerText(handle, conversation, settled.answer);
  return { conversationId: String(childId), answer };
}

/** Read the assistant text out of a settled submission's answer entry. */
async function settledAnswerText(
  handle: DurableHarnessHandle,
  conversation: import("@earendil-works/pi-durable").Conversation,
  answer: unknown,
): Promise<string> {
  const entry = await conversation.commit(
    (tx) => tx.entry(handle.module.AssistantEntry, answer as never),
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
  options: { databasePath?: string } = {},
): Promise<string | null> {
  const handle = await openDurableHarness(piDir, { databasePath: options.databasePath });
  const conversation = await findChild(handle, taskId);
  if (!conversation) return `No durable child conversation for task ${taskId}.`;
  await conversation.submit(
    { type: "input", content: text, whenBusy: "steer" },
    handle.context,
  );
  return null;
}

/** Abort the child conversation of a task; resolves once it is idle. */
export async function abortDurableTask(
  piDir: string,
  taskId: string,
  options: { databasePath?: string } = {},
): Promise<string | null> {
  const handle = await openDurableHarness(piDir, { databasePath: options.databasePath });
  const conversation = await findChild(handle, taskId);
  if (!conversation) return `No durable child conversation for task ${taskId}.`;
  await conversation.abort(handle.context);
  return null;
}

/**
 * Resume unfinished durable submissions after a parent restart: finish them,
 * then hand each recovered answer to `onRecovered` keyed by its pi-task id.
 * Fire-and-forget per submission by design; failures are reported per task.
 */
export async function resumeDurableTasks(
  piDir: string,
  hooks: {
    onRecovered?: (taskId: string, output: string) => void;
    onFailed?: (taskId: string, reason: string) => void;
  } = {},
  options: { databasePath?: string; models?: DurableModelsFactory } = {},
): Promise<void> {
  const handle = await openDurableHarness(piDir, {
    databasePath: options.databasePath,
    models: options.models,
  });
  const inspection = await handle.harness.inspect(handle.context);
  for (const submission of inspection.submissions) {
    const requestId = submission.requestId;
    if (typeof requestId !== "string" || !requestId.startsWith("pi-task:")) continue;
    const taskId = requestId.slice("pi-task:".length);
    const submissionHandle = await handle.harness.submission(submission.id, handle.context);
    if (!submissionHandle) continue;
    void submissionHandle
      .wait(handle.context)
      .then(async (settled) => {
        if (settled.status !== "done" || settled.type !== "input") {
          hooks.onFailed?.(taskId, `resumed submission ${settled.status}`);
          return;
        }
        const conversation = await handle.harness.conversation(
          submission.conversationId,
          handle.context,
        );
        if (!conversation) {
          hooks.onFailed?.(taskId, "child conversation missing after resume");
          return;
        }
        hooks.onRecovered?.(taskId, await settledAnswerText(handle, conversation, settled.answer));
      })
      .catch((error: unknown) => {
        hooks.onFailed?.(taskId, error instanceof Error ? error.message : String(error));
      });
  }
}
