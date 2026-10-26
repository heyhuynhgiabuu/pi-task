import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import registerTaskExtension from "../src/index.js";

// Runs the real session_start handler against a seeded history and reports the
// completion notices it sent. mode: replay | branch (guard withholds) | nofile.
const [piDir, cwd, mode] = process.argv.slice(2);
if (!piDir || !cwd || !mode) {
  console.error("usage: lost-notice-session-start-child.ts <piDir> <cwd> <mode>");
  process.exit(1);
}

async function main(): Promise<void> {
  process.chdir(cwd);
  delete process.env.PI_TASK_TOOL_DISABLED;
  process.env.PI_TASK_BACKEND = "auto";

  const sessionPath = join(piDir, "parent-session.jsonl");
  mkdirSync(piDir, { recursive: true });
  writeFileSync(
    sessionPath,
    [
      JSON.stringify({
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: "sess-lost",
        timestamp: new Date().toISOString(),
        cwd,
      }),
      JSON.stringify({
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: [{ type: "text", text: "Hi." }], timestamp: Date.now() },
      }),
    ].join("\n") + "\n",
  );

  const sent: { customType?: string; content?: string; details?: Record<string, unknown> }[] = [];
  const handlers: ((event: unknown, ctx: unknown) => Promise<void> | void)[] = [];
  registerTaskExtension({
    on(event: string, handler: (...args: unknown[]) => unknown) {
      if (event === "session_start") handlers.push(handler as (event: unknown, ctx: unknown) => Promise<void> | void);
    },
    registerFlag() {},
    getFlag() { return false; },
    registerTool() {},
    registerCommand() {},
    registerMessageRenderer() {},
    registerProvider() {},
    getAllTools() { return []; },
    sendMessage(message: (typeof sent)[number]) { sent.push(message); },
  } as never);

  const ctx = {
    cwd,
    mode: "rpc",
    hasUI: false,
    modelRegistry: {},
    sessionManager: {
      getSessionId: () => "sess-lost",
      getLeafId: () => null,
      getBranch: () => [],
      ...(mode === "nofile" ? {} : { getSessionFile: () => sessionPath }),
    },
    ui: { notify() {} },
  };
  for (const handler of handlers) await handler({ type: "session_start", reason: "startup" }, ctx);
  // The delivery queue holds a notice for its 200 ms debounce window.
  await new Promise((resolve) => setTimeout(resolve, 700));
  const replayed = sent.filter((message) => message.details?.replayed === true);
  process.stdout.write(
    `LOST_NOTICE_START ${JSON.stringify({ sent: sent.length, replayed: replayed.length, first: replayed[0]?.content })}\n`,
    () => process.exit(0),
  );
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
