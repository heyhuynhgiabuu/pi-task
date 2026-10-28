/**
 * Shared by the reload tests: one evaluation of the extension is a full copy of `src`,
 * because a query-string import would re-evaluate one file and share every other module,
 * which hides exactly the state a reload is about.
 */

import { cpSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";

export type DurableModule = typeof import("../src/subagent/durable.js");
export type ExecutionModule = typeof import("../src/lifecycle/durable-execution.js");

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export type ExtensionCopy = { durable: DurableModule; execution: ExecutionModule };

/** One more evaluation of the extension: its own copy of `src`, the same dependencies. */
export async function evaluateExtensionCopy(root: string, name: string): Promise<ExtensionCopy> {
  const dir = join(root, name);
  mkdirSync(dir);
  cpSync(join(repoRoot, "src"), join(dir, "src"), { recursive: true });
  symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  const load = <T>(file: string) => import(pathToFileURL(join(dir, file)).href) as Promise<T>;

  return {
    durable: await load<DurableModule>("src/subagent/durable.ts"),
    execution: await load<ExecutionModule>("src/lifecycle/durable-execution.ts"),
  };
}

/** A model whose first answer is held until released; counts how many turns it served. */
export function gatedModels(answer: string) {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage(answer), fauxAssistantMessage(answer)]);
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const reachedPromise = new Promise<void>((resolve) => (reached = resolve));
  const original = models.streamSimple.bind(models);
  const counter = { turns: 0 };
  models.streamSimple = (model, context, options) => {
    counter.turns += 1;
    const stream = original(model, context, options);
    const result = stream.result.bind(stream);
    stream.result = async () => {
      reached();
      await gate;

      return result();
    };

    return stream;
  };

  return { models, release, reached: reachedPromise, counter };
}

export function instantModels(answer: string) {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage(answer), fauxAssistantMessage(answer)]);
  const original = models.streamSimple.bind(models);
  const counter = { turns: 0 };
  models.streamSimple = (model, context, options) => {
    counter.turns += 1;

    return original(model, context, options);
  };

  return { models, counter };
}
