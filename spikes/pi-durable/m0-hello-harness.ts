/**
 * M0 of the pi-durable backend spike (spike-pi-durable-backend.md).
 *
 * Proves the harness fundamentals on SQLite with the faux provider (no
 * network, no API keys):
 *   1. A conversation persists across harness close/reopen, and resubmitting
 *      the same requestId is exactly-once (the original answer comes back; no
 *      duplicate assistant entry).
 *   2. A child process killed mid-tool-call leaves an unfinished submission;
 *      a new process reopens the storage, resumes, the safe-to-rerun tool
 *      reruns, and the submission completes with the recovered answer.
 *
 * Run: npx tsx spikes/pi-durable/m0-hello-harness.ts
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const context = BACKGROUND_CONTEXT;
const MODEL = { provider: "faux", modelId: "faux-1" } as const;
const TOOL_MS = Number(process.env.M0_TOOL_MS ?? 50);

function makeModels(steps: FauxResponseStep[]) {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  faux.setResponses(steps);
  return models;
}

const slowTool = defineTool({
  name: "m0_slow",
  description: "Sleeps, then acknowledges. Safe to rerun after a crash.",
  parameters: Type.Object({}),
  replay: "safe",
  execute: async () => {
    await new Promise((resolve) => setTimeout(resolve, TOOL_MS));
    return { content: [{ type: "text", text: "tool done" }] };
  },
});

function makeRegistry() {
  const registry = createRegistry();
  registry.install(defineExtension({ name: "m0", tools: [slowTool] }));
  return registry;
}

async function answerText(
  conversation: Awaited<ReturnType<Harness["root"]>>,
  answer: unknown,
): Promise<string> {
  const entry = await conversation.commit(
    (tx) => tx.entry(AssistantEntry, answer as never),
    context,
  );
  const message = entry?.model?.[0] as
    | { content: { type: string; text?: string }[] }
    | undefined;
  return (message?.content ?? [])
    .flatMap((c) => (c.type === "text" && c.text ? [c.text] : []))
    .join("");
}

async function assistantEntryCount(
  conversation: Awaited<ReturnType<Harness["root"]>>,
): Promise<number> {
  const page = await conversation.commit(
    (tx) => tx.scanEntries({ conversationId: conversation.id }, 200),
    context,
  );
  return page.items.filter(
    (entry: { kind?: string }) => entry.kind === "pi.assistant",
  ).length;
}

/** Check 1: durability across close/reopen + exactly-once resubmit. */
async function checkPersistence(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "pi-task-m0-"));
  const db = join(dir, "m0.sqlite");
  try {
    const storage = await openNodeSqliteStorage(db);
    const harness = await Harness.open(
      storage,
      { models: makeModels([fauxAssistantMessage("Hello from durable.")]), registry: makeRegistry() },
      context,
    );
    const root = await harness.root(context, { agent: { model: MODEL } });
    const settled = await (
      await root.submit({ type: "input", content: "Say hello.", requestId: "m0:close" }, context)
    ).wait(context);
    if (settled.status !== "done") throw new Error(`settled ${settled.status}`);
    const first = await answerText(root, settled.answer);
    const firstCount = await assistantEntryCount(root);
    await harness.close(context);

    // Reopen: the transcript is still there, and the same requestId returns
    // the original answer without appending a second one.
    const reopened = await Harness.open(
      await openNodeSqliteStorage(db),
      { models: makeModels([fauxAssistantMessage("SHOULD NOT BE USED")]), registry: makeRegistry() },
      context,
    );
    const root2 = await reopened.root(context, { agent: { model: MODEL } });
    const again = await (
      await root2.submit({ type: "input", content: "Say hello.", requestId: "m0:close" }, context)
    ).wait(context);
    const second = await answerText(root2, again.answer);
    const secondCount = await assistantEntryCount(root2);
    await reopened.close(context);

    if (first !== "Hello from durable.") throw new Error(`first answer: ${first}`);
    if (second !== first) throw new Error(`resubmit answered differently: ${second}`);
    if (secondCount !== firstCount) {
      throw new Error(`exactly-once violated: ${firstCount} -> ${secondCount} assistant entries`);
    }
    return `answer "${first}" survived reopen; resubmit returned it verbatim (${secondCount} assistant entries, unchanged)`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function childPhase(db: string): void {
  void childPhaseImpl(db).catch((error) => {
    console.error("M0 child failed:", error);
    process.exit(1);
  });
}

async function childPhaseImpl(db: string): Promise<void> {
  const harness = await Harness.open(
    await openNodeSqliteStorage(db),
    {
      models: makeModels([
        fauxAssistantMessage(
          [fauxToolCall("m0_slow", {}, { id: "call-1" })],
          { stopReason: "toolUse" },
        ),
      ]),
      registry: makeRegistry(),
    },
    context,
  );
  harness.resume();
  const root = await harness.root(context, { agent: { model: MODEL } });
  void root
    .submit({ type: "input", content: "Run the slow tool.", requestId: "m0:crash" }, context)
    .then((s) => s.wait(context))
    .catch(() => {});
  console.log("M0 child: running (mid-tool)");
  // The in-flight tool timer keeps the process alive until the parent kills it.
  setTimeout(() => process.exit(3), 60_000).unref?.();
}

/** Check 2: SIGKILL mid-tool, reopen, resume, complete exactly once. */
async function checkCrashResume(scriptPath: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "pi-task-m0-crash-"));
  const db = join(dir, "m0.sqlite");
  try {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", scriptPath, "--phase=child", db],
      {
        env: { ...process.env, M0_TOOL_MS: "30000" },
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    await new Promise<void>((resolve, reject) => {
      let out = "";
      child.stdout!.on("data", (chunk: Buffer) => {
        out += chunk.toString();
        if (out.includes("M0 child: running")) resolve();
      });
      child.on("exit", (code) => reject(new Error(`child exited early: ${code}`)));
      setTimeout(() => reject(new Error("child never started working")), 20_000).unref();
    });
    await new Promise((resolve) => setTimeout(resolve, 1_500)); // land mid-tool
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));

    // New process, same storage: resume and finish the interrupted work.
    const harness = await Harness.open(
      await openNodeSqliteStorage(db),
      { models: makeModels([fauxAssistantMessage("Recovered after crash.")]), registry: makeRegistry() },
      context,
    );
    harness.resume();
    const root = await harness.root(context, { agent: { model: MODEL } });
    const settled = await (
      await root.submit({ type: "input", content: "Run the slow tool.", requestId: "m0:crash" }, context)
    ).wait(context);
    if (settled.status !== "done") throw new Error(`settled ${settled.status}`);
    const text = await answerText(root, settled.answer);
    await harness.close(context);
    if (text !== "Recovered after crash.") throw new Error(`recovered answer: ${text}`);
    return "SIGKILL mid-tool -> reopen -> resume -> submission completed with the recovered answer";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const scriptPath = fileURLToPath(import.meta.url);
const phase = process.argv[2];
if (phase === "--phase=child") {
  childPhase(process.argv[3]!);
} else {
  const results: string[] = [];
  try {
    results.push(`persistence: ${await checkPersistence()}`);
    results.push(`crash/resume: ${await checkCrashResume(scriptPath)}`);
    console.log("M0 PASS");
    for (const r of results) console.log(`  - ${r}`);
  } catch (error) {
    console.error("M0 FAIL", error);
    process.exit(1);
  }
}
