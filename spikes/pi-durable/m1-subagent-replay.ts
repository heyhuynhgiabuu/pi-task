/**
 * M1 of the pi-durable backend spike (spike-pi-durable-backend.md):
 * runDurableSubagent() — the pi-durable subagent pattern
 * (packages/durable/test/examples/22-subagent-foreground.ts) adapted to a
 * caller outside any durable conversation.
 *
 * Replay safety here = find-before-create keyed by the caller's owner key
 * (a session-scoped document, because the native ownership index
 * `{ kind: "task", taskId }` only exists inside a durable tool call; M2
 * upgrades to it), plus exactly-once submission by `requestId`. A crash
 * mid-tool reruns the `replay: "safe"` tool and completes the original
 * submission instead of spawning a second child.
 *
 * Run: npx tsx spikes/pi-durable/m1-subagent-replay.ts
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";
import {
  AssistantEntry,
  configure,
  createRegistry,
  defineDoc,
  defineExtension,
  defineTool,
  Harness,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const context = BACKGROUND_CONTEXT;
const MODEL = { provider: "faux", modelId: "faux-1" } as const;

function makeModels(steps: FauxResponseStep[]) {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  faux.setResponses(steps);
  return models;
}

let toolMs = 50;

const slowTool = defineTool({
  name: "m1_slow",
  description: "Sleeps, then acknowledges. Safe to rerun after a crash.",
  parameters: Type.Object({}),
  replay: "safe",
  execute: async () => {
    await new Promise((resolve) => setTimeout(resolve, toolMs));
    return { content: [{ type: "text", text: "tool done" }] };
  },
});

function makeRegistry() {
  const registry = createRegistry();
  registry.install(defineExtension({ name: "m1", tools: [slowTool] }));
  return registry;
}

/** Owner key -> child conversation, durable so a rerun finds the same child. */
const Children = defineDoc<{
  byOwner: Record<string, { conversationId: string }>;
}>({
  kind: "m1.children",
  version: 1,
  scope: "session",
  initial: () => ({ byOwner: {} }),
});

export async function runDurableSubagent(input: {
  dbPath: string;
  ownerKey: string;
  task: string;
  steps: FauxResponseStep[];
  toolMs?: number;
}): Promise<{ conversationId: string; answer: string }> {
  toolMs = input.toolMs ?? 50;
  const harness = await Harness.open(
    await openNodeSqliteStorage(input.dbPath),
    { models: makeModels(input.steps), registry: makeRegistry() },
    context,
  );
  try {
    harness.resume();
    const root = await harness.root(context, { agent: { model: MODEL } });
    // Find-before-create in one atomic commit: a rerun of the same owner key
    // reuses the child it already created instead of spawning a twin.
    const childId = await root.commit(async (tx) => {
      const map = await tx.doc(Children);
      const existing = map.byOwner[input.ownerKey];
      if (existing !== undefined) return existing.conversationId;
      // Ownerless until M2, where the caller is a durable tool call and the
      // native index becomes { kind: "task", taskId: api.taskId } — and the
      // child inherits its owner's agent. Raw creation copies nothing, so the
      // model is pinned explicitly here.
      const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
      await configure(tx, created.id, { model: MODEL });
      map.byOwner[input.ownerKey] = { conversationId: created.id };
      return created.id;
    }, context);
    const handle = (await harness.conversation(childId, context))!;
    // Exactly-once by requestId: a rerun gets the submission it already made.
    const request = {
      type: "input",
      content: input.task,
      requestId: `subagent:${input.ownerKey}`,
    } as const;
    const settled = await (await handle.submit(request, context)).wait(context);
    if (settled.status !== "done" || settled.type !== "input") {
      throw new Error(`subagent failed: ${JSON.stringify(settled)}`);
    }
    const entry = await handle.commit(
      (tx) => tx.entry(AssistantEntry, settled.answer),
      context,
    );
    const message = entry?.model?.[0] as
      | { content: { type: string; text?: string }[] }
      | undefined;
    const answer = (message?.content ?? [])
      .flatMap((c) => (c.type === "text" && c.text ? [c.text] : []))
      .join("");
    return { conversationId: childId, answer };
  } finally {
    await harness.close(context);
  }
}

async function readChildren(dbPath: string): Promise<string[]> {
  const harness = await Harness.open(
    await openNodeSqliteStorage(dbPath),
    { models: makeModels([]), registry: makeRegistry() },
    context,
  );
  try {
    const root = await harness.root(context, { agent: { model: MODEL } });
    // The draft is a transaction overlay: extract plain data inside the commit.
    const keys = await root.commit(async (tx) => {
      const map = await tx.doc(Children);
      return Object.keys(map.byOwner ?? {});
    }, context);
    return keys;
  } finally {
    await harness.close(context);
  }
}

function childPhase(db: string, ownerKey: string): void {
  void runDurableSubagent({
    dbPath: db,
    ownerKey,
    task: "Run the slow tool.",
    steps: [
      fauxAssistantMessage(
        [fauxToolCall("m1_slow", {}, { id: "call-1" })],
        { stopReason: "toolUse" },
      ),
    ],
    toolMs: Number(process.env.M1_TOOL_MS ?? 30_000),
  })
    .then((r) => console.log(`M1 child finished unexpectedly: ${r.answer}`))
    .catch((error) => console.error("M1 child failed:", error));
  console.log("M1 child: running (mid-tool)");
  // The in-flight tool timer keeps the process alive until the parent kills it.
  setTimeout(() => process.exit(3), 60_000).unref();
}

const scriptPath = fileURLToPath(import.meta.url);
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
const phase = invokedDirectly ? process.argv[2] : undefined;
if (invokedDirectly && phase === "--phase=child") {
  childPhase(process.argv[3]!, process.argv[4]!);
} else if (invokedDirectly) {
  const results: string[] = [];
  try {
    // Check 1: rerun after completion is find-before-create, not a twin.
    const dir1 = mkdtempSync(join(tmpdir(), "pi-task-m1-"));
    try {
      const db1 = join(dir1, "m1.sqlite");
      const first = await runDurableSubagent({
        dbPath: db1,
        ownerKey: "owner-1",
        task: "Answer once.",
        steps: [fauxAssistantMessage("Answer one.")],
      });
      const rerun = await runDurableSubagent({
        dbPath: db1,
        ownerKey: "owner-1",
        task: "Answer once.",
        steps: [fauxAssistantMessage("SHOULD NOT BE USED")],
      });
      if (rerun.answer !== first.answer) {
        throw new Error(`rerun answered differently: ${rerun.answer}`);
      }
      if (rerun.conversationId !== first.conversationId) {
        throw new Error("rerun created a second child conversation");
      }
      const children1 = await readChildren(db1);
      if (children1.length !== 1) {
        throw new Error(`expected 1 child, found ${children1.length}`);
      }
      results.push(
        `rerun-after-done: same child ${first.conversationId}, same answer "${first.answer}", 1 child in storage`,
      );
    } finally {
      rmSync(dir1, { recursive: true, force: true });
    }

    // Check 2: SIGKILL mid-tool -> rerun finds the same child and completes.
    const dir2 = mkdtempSync(join(tmpdir(), "pi-task-m1-crash-"));
    try {
      const db2 = join(dir2, "m1.sqlite");
      const child = spawn(
        process.execPath,
        [
          "--import", "tsx", scriptPath,
          "--phase=child", db2, "owner-2",
        ],
        {
          env: { ...process.env, M1_TOOL_MS: "30000" },
          stdio: ["ignore", "pipe", "inherit"],
        },
      );
      await new Promise<void>((resolve, reject) => {
        let out = "";
        child.stdout!.on("data", (chunk: Buffer) => {
          out += chunk.toString();
          if (out.includes("M1 child: running")) resolve();
        });
        child.on("exit", (code) => reject(new Error(`child exited early: ${code}`)));
        setTimeout(() => reject(new Error("child never started working")), 20_000).unref();
      });
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child.on("exit", () => resolve()));

      const recovered = await runDurableSubagent({
        dbPath: db2,
        ownerKey: "owner-2",
        task: "Run the slow tool.",
        steps: [fauxAssistantMessage("Recovered after crash.")],
        toolMs: 50,
      });
      const children2 = await readChildren(db2);
      if (recovered.answer !== "Recovered after crash.") {
        throw new Error(`recovered answer: ${recovered.answer}`);
      }
      if (children2.length !== 1 || children2[0] !== "owner-2") {
        throw new Error(`expected exactly owner-2, found ${JSON.stringify(children2)}`);
      }
      results.push(
        `crash/rerun: SIGKILL mid-tool -> same child ${recovered.conversationId} completed with "${recovered.answer}", no twin`,
      );
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }

    console.log("M1 PASS");
    for (const r of results) console.log(`  - ${r}`);
  } catch (error) {
    console.error("M1 FAIL", error);
    process.exit(1);
  }
}
