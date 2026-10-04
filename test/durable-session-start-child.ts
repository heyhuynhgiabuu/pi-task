import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { readTaskSessionHistory } from "../src/conversation.js";
import registerTaskExtension from "../src/index.js";
import type { DurableRuntimeModelRegistry } from "../src/subagent/durable.js";

const [piDir, cwd, taskId] = process.argv.slice(2);
if (!piDir || !cwd || !taskId) {
  console.error("usage: durable-session-start-child.ts <piDir> <cwd> <taskId>");
  process.exit(1);
}

async function main(): Promise<void> {
  process.chdir(cwd);
  delete process.env.PI_TASK_TOOL_DISABLED;
  process.env.PI_TASK_BACKEND = "auto";

  let modelStarted = false;
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  faux.setResponses([async () => {
    modelStarted = true;
    // Keep recovery in-flight long enough to inspect startup's persisted state.
    await new Promise<void>(() => {});
    return fauxAssistantMessage("Unreachable durable recovery fixture response.");
  }]);
  const modelRegistry: DurableRuntimeModelRegistry = {
    getAll: () => models.getAllModels() as never,
    find: (provider, modelId) => models.getModel(provider, modelId),
    streamSimple: (model, context, options) => models.streamSimple(model, context, options),
  };

  const sessionPath = join(piDir, "parent-session.jsonl");
  mkdirSync(piDir, { recursive: true });
  writeFileSync(
    sessionPath,
    [
      JSON.stringify({
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: "sess-start",
        timestamp: new Date().toISOString(),
        cwd,
      }),
      JSON.stringify({
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: {
          role: "user",
          content: [{ type: "text", text: "Start recovery fixture." }],
          timestamp: Date.now(),
        },
      }),
    ].join("\n") + "\n",
  );
  const sentMessages: {
    customType?: string;
    details?: { compare?: boolean; completion_delivery_id?: string };
  }[] = [];
  const sessionStartHandlers: ((event: unknown, ctx: unknown) => Promise<void> | void)[] = [];
  registerTaskExtension({
    on(event: string, handler: (...args: unknown[]) => unknown) {
      if (event === "session_start") {
        sessionStartHandlers.push(handler as (event: unknown, ctx: unknown) => Promise<void> | void);
      }
    },
    registerFlag() {},
    getFlag() { return false; },
    registerTool() {},
    registerCommand() {},
    registerMessageRenderer() {},
    registerProvider() {},
    getAllTools() { return []; },
    sendMessage(message: {
      customType?: string;
      details?: { compare?: boolean; completion_delivery_id?: string };
    }) {
      sentMessages.push(message);
      appendFileSync(
        sessionPath,
        `${JSON.stringify({
          type: "custom_message",
          customType: message.customType,
          id: `custom-${sentMessages.length}`,
          parentId: "user-1",
          timestamp: new Date().toISOString(),
          content: "",
          display: true,
          details: message.details,
        })}\n`,
      );
    },
  } as never);

  const ctx = {
    cwd,
    mode: "rpc",
    hasUI: false,
    modelRegistry,
    sessionManager: {
      getSessionId: () => "sess-start",
      getLeafId: () => null,
      getBranch: () => [],
      getSessionFile: () => sessionPath,
    },
    ui: { notify() {} },
  };
  for (const handler of sessionStartHandlers) {
    await handler({ type: "session_start", reason: "startup" }, ctx);
  }
  for (let waited = 0; waited < 2_000 && !modelStarted; waited += 10) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const hasComparisonHistory = readTaskSessionHistory(piDir).some(
    (entry) => entry.comparisonGroupId !== undefined,
  );
  if (hasComparisonHistory) {
    for (
      let waited = 0;
      waited < 2_000 && !sentMessages.some((message) => message.details?.compare === true);
      waited += 10
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    for (let waited = 0; waited < 2_000; waited += 10) {
      const comparisonHistory = readTaskSessionHistory(piDir).filter(
        (entry) => entry.comparisonGroupId !== undefined,
      );
      if (
        comparisonHistory.length > 0 &&
        comparisonHistory.every((entry) => entry.comparisonDelivered === true)
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  const history = readTaskSessionHistory(piDir).find((entry) => entry.id === taskId);
  const state = {
    status: history?.status,
    backend: history?.backend,
    modelStarted,
    comparisonReports: sentMessages.filter((message) => message.details?.compare === true).length,
  };
  process.stdout.write(`SESSION_START_ORDER ${JSON.stringify(state)}\n`, () => process.exit(0));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
