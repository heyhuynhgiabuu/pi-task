import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CHILD_RUN_TPS_ENTRY_TYPE, createChildTpsRun, sumAssistantOutputTokens } from "../panel/child-metadata.js";

/** Record native Pi child runs, including tool time, with the main TPS extension's UI-wait accounting. */
export function registerChildTps(pi: ExtensionAPI, now: () => number = Date.now): void {
  if (process.env.PI_TASK_TOOL_DISABLED !== "1") return;
  const run = createChildTpsRun();
  pi.on("agent_start", () => run.start(now()));
  pi.on("ui_prompt_start", () => run.promptStart(now()));
  pi.on("ui_prompt_end", () => run.promptEnd(now()));
  pi.on("agent_end", (event) => {
    const measurement = run.end(now());
    if (!measurement) return;
    const output = sumAssistantOutputTokens(event.messages);
    if (output <= 0) return;
    pi.appendEntry(CHILD_RUN_TPS_ENTRY_TYPE, { version: 1, ...measurement, output });
  });
}
