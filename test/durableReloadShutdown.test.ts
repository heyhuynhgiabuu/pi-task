/**
 * The extension's own `session_shutdown` handler is what retires the durable harnesses,
 * and only for a reload. Retirement is process-wide state, so this file runs the
 * non-reload reasons first and the reload last.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";

import taskExtension from "../src/index.js";
import { openDurableHarness } from "../src/subagent/durable.js";

type Handler = (event?: { reason?: string }) => unknown;

function loadExtension(): Handler[] {
  const shutdown: Handler[] = [];
  const pi = {
    on(event: string, handler: Handler) {
      if (event === "session_shutdown") shutdown.push(handler);
    },
    registerMessageRenderer() {},
    registerFlag() {},
    getFlag() {
      return undefined;
    },
    registerTool() {},
    registerCommand() {},
    getAllTools() {
      return [];
    },
  };
  taskExtension(pi as never);

  return shutdown;
}

/** Pi awaits each handler in turn before it evaluates the next extension copy. */
async function shutdownWith(handlers: Handler[], reason: string | undefined) {
  for (const handler of handlers) await handler(reason ? { reason } : undefined);
}

function models() {
  const created = createModels();
  const faux = fauxProvider();
  created.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("unused")]);

  return created;
}

test("only a reload retires the durable harnesses; a new, resumed or forked session keeps them", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-task-reload-shutdown-"));
  const piDir = join(root, ".pi");
  mkdirSync(piDir, { recursive: true });
  const databasePath = join(root, "durable.sqlite");
  const handlers = loadExtension();
  try {
    const handle = await openDurableHarness(piDir, { databasePath, models: () => models() });

    for (const reason of ["new", "resume", "fork", "quit", undefined]) {
      await shutdownWith(handlers, reason);
      const again = await openDurableHarness(piDir, { databasePath, models: () => models() });
      assert.equal(again, handle, `a ${reason ?? "reasonless"} shutdown keeps the open harness`);
    }

    // The close takes a while, as it does with a turn in flight: the handler must not
    // return before it is done, because Pi evaluates the new copy as soon as it does.
    const realClose = handle.harness.close.bind(handle.harness);
    let closeFinished = false;
    handle.harness.close = async (context) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const result = await realClose(context);
      closeFinished = true;

      return result;
    };

    await shutdownWith(handlers, "reload");

    assert.equal(closeFinished, true, "the reload handler waited for the harness to close");
    await assert.rejects(
      openDurableHarness(piDir, { databasePath, models: () => models() }),
      /replaced by a reload/,
      "after a reload this copy opens nothing",
    );
    await handle.harness.closed;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
