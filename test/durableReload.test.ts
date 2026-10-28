/**
 * `/reload` evaluates the whole extension again in the same Pi process. The earlier
 * copy keeps its harness (and the store lock) until it closes it, and a second
 * harness on the same store would treat the running turn as interrupted and run it
 * again. So the earlier copy must close its harnesses on `session_shutdown` with
 * reason `reload`, and only then may the new copy open the store.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  evaluateExtensionCopy,
  gatedModels,
  instantModels,
  type DurableModule,
} from "./durable-reload-helpers.js";

const evaluateExtension = async (root: string, name: string): Promise<DurableModule> =>
  (await evaluateExtensionCopy(root, name)).durable;

test("a reload hands the store from the earlier copy to the new one: one harness at a time, the running task finishes once", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-reload-"));
  const piDir = join(root, ".pi");
  mkdirSync(piDir, { recursive: true });
  const databasePath = join(root, "durable.sqlite");
  const taskId = "t-reload";
  const reports: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    reports.push(args.map(String).join(" "));
  };
  const earlier = gatedModels("answer from the earlier copy");
  let releasedEarly = false;
  try {
    const copyA = await evaluateExtension(root, "copy-a");
    const copyB = await evaluateExtension(root, "copy-b");
    const requestId = copyA.durableRequestId(taskId, "call-1");

    const running = copyA.runDurableTask({
      piDir,
      databasePath,
      taskId,
      task: "do the long thing",
      requestId,
      models: () => earlier.models,
    });
    const runningOutcome = running.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await earlier.reached;

    // The reload: the earlier copy is told to shut down, and must be done before the
    // new copy is evaluated and opens the store.
    const retired = copyA.retireDurableHarnesses();
    earlier.release();
    releasedEarly = true;
    await retired;

    const outcome = await runningOutcome;
    assert.equal(outcome.ok, false, "the earlier copy's run ends when its harness closes");
    assert.ok(
      copyA.isDurableRetirement((outcome as { error: unknown }).error),
      "and that end reads as a retirement, not as a task failure",
    );
    assert.equal(
      copyA.isDurableStorageFailure((outcome as { error: unknown }).error),
      false,
      "it is not a storage failure either",
    );

    // The new copy opens the same store while the earlier copy still exists.
    const next = instantModels("answer from the new copy");
    const result = await copyB.runDurableTask({
      piDir,
      databasePath,
      taskId,
      task: "do the long thing",
      requestId,
      models: () => next.models,
    });

    assert.match(result.answer, /answer from the new copy/);
    assert.equal(next.counter.turns, 1, "the interrupted turn runs once, under the new copy");
    assert.deepEqual(
      reports.filter((line) => /durable harness report|storage error|SessionFailed/i.test(line)),
      [],
      "no harness reported a storage failure",
    );
  } finally {
    console.error = originalError;
    if (!releasedEarly) earlier.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a retired copy refuses to open a store again", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-retired-"));
  const piDir = join(root, ".pi");
  mkdirSync(piDir, { recursive: true });
  try {
    const copy = await evaluateExtension(root, "copy-a");
    await copy.retireDurableHarnesses();
    await assert.rejects(
      copy.openDurableHarness(piDir, {
        databasePath: join(root, "durable.sqlite"),
        models: () => instantModels("never").models,
      }),
      /retired|reload/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retiring while a store is still opening, and that open fails, neither rejects nor hangs", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-reload-failed-open-"));
  const piDir = join(root, ".pi");
  mkdirSync(piDir, { recursive: true });
  try {
    const copy = await evaluateExtension(root, "copy-a");
    const opening = copy.openDurableHarness(piDir, {
      databasePath: root, // a directory: sqlite cannot open it as a database
      models: () => instantModels("unused").models,
    });
    const refused = opening.then(
      () => "opened",
      () => "refused",
    );

    await copy.retireDurableHarnesses();

    assert.equal(await refused, "refused", "the failed open still fails for its own reason");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("several harnesses that will not close are given up on together, not one after another", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-reload-parallel-"));
  const piDir = join(root, ".pi");
  mkdirSync(piDir, { recursive: true });
  const originalError = console.error;
  const reports: string[] = [];
  const reals: (() => Promise<unknown>)[] = [];
  const closedPromises: Promise<unknown>[] = [];
  try {
    const copy = await evaluateExtension(root, "copy-a");
    for (const name of ["one", "two", "three"]) {
      const handle = await copy.openDurableHarness(piDir, {
        databasePath: join(root, `${name}.sqlite`),
        models: () => instantModels("unused").models,
      });
      const real = handle.harness.close.bind(handle.harness);
      reals.push(() => real(handle.context));
      closedPromises.push(handle.harness.closed);
      handle.harness.close = () => new Promise(() => undefined);
    }
    console.error = (...args: unknown[]) => {
      reports.push(args.map(String).join(" "));
    };

    const started = Date.now();
    await copy.retireDurableHarnesses(400);
    const elapsed = Date.now() - started;

    // One after another would take about 1200 ms; together it is one limit.
    assert.ok(elapsed < 900, `retiring three hung stores took ${elapsed} ms`);
    assert.equal(reports.filter((line) => /did not close within 400 ms/.test(line)).length, 3);
  } finally {
    console.error = originalError;
    for (const close of reals) await close().catch(() => undefined);
    for (const closed of closedPromises) await closed.catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a close that rejects does not release the store before the harness has really closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-reload-reject-"));
  const piDir = join(root, ".pi");
  mkdirSync(piDir, { recursive: true });
  const originalError = console.error;
  const reports: string[] = [];
  let closeForReal: (() => Promise<unknown>) | undefined;
  let closed: Promise<unknown> | undefined;
  try {
    const copy = await evaluateExtension(root, "copy-a");
    const handle = await copy.openDurableHarness(piDir, {
      databasePath: join(root, "durable.sqlite"),
      models: () => instantModels("unused").models,
    });
    const real = handle.harness.close.bind(handle.harness);
    closeForReal = () => real(handle.context);
    closed = handle.harness.closed;
    handle.harness.close = () => Promise.reject(new Error("close failed"));
    console.error = (...args: unknown[]) => {
      reports.push(args.map(String).join(" "));
    };

    const started = Date.now();
    await copy.retireDurableHarnesses(150);

    assert.ok(Date.now() - started >= 140, "retirement waited for `closed` instead of trusting the rejection");
    assert.ok(reports.some((line) => /did not close within 150 ms/.test(line)), reports.join("\n"));
  } finally {
    console.error = originalError;
    await closeForReal?.().catch(() => undefined);
    await closed?.catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a harness that will not close is given up on after the time limit, and its store stays locked", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-reload-hang-"));
  const piDir = join(root, ".pi");
  mkdirSync(piDir, { recursive: true });
  const databasePath = join(root, "durable.sqlite");
  const reports: string[] = [];
  const originalError = console.error;
  let closeForReal: (() => Promise<unknown>) | undefined;
  let closed: Promise<unknown> | undefined;
  try {
    const copy = await evaluateExtension(root, "copy-a");
    const handle = await copy.openDurableHarness(piDir, {
      databasePath,
      models: () => instantModels("unused").models,
    });
    const real = handle.harness.close.bind(handle.harness);
    closeForReal = () => real(handle.context);
    closed = handle.harness.closed;
    handle.harness.close = () => new Promise(() => undefined);
    console.error = (...args: unknown[]) => {
      reports.push(args.map(String).join(" "));
    };

    const started = Date.now();
    await copy.retireDurableHarnesses(50);

    assert.ok(Date.now() - started < 5_000, "retirement gave up instead of waiting forever");
    assert.ok(
      reports.some((line) => /did not close within 50 ms/.test(line)),
      reports.join("\n"),
    );
    const closedYet = await Promise.race([
      handle.harness.closed.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    assert.equal(closedYet, false, "the harness never closed, so its store lock was not released");
  } finally {
    console.error = originalError;
    await closeForReal?.().catch(() => undefined);
    await closed?.catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});
