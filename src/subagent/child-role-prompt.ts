import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const TASK_ROLE_PROMPT_FLAG = "task-role-prompt";

// Accept both text-only hook events and newer mutable prompt sections.
interface RolePromptEvent {
  readonly systemPrompt: string;
  systemPromptOptions?: {
    appendSystemPrompt: string;
    forceSystemPrompt?: string;
  };
}

function resolveRolePrompt(source: string): string {
  if (!existsSync(source)) return source;
  try {
    return readFileSync(source, "utf8").replace(/^\uFEFF/, "");
  } catch (error) {
    // Match Pi's text-or-file behavior: warn and retain the literal input.
    console.error(`Warning: Could not read role prompt file ${source}: ${String(error)}`);
    return source;
  }
}

/** Add the role after Pi has selected native append resources for the child. */
export function registerChildRolePrompt(pi: ExtensionAPI): void {
  pi.registerFlag(TASK_ROLE_PROMPT_FLAG, {
    description: "Internal task child role instructions (text or file path)",
    type: "string",
  });
  if (process.env.PI_TASK_TOOL_DISABLED !== "1") return;

  pi.on("before_agent_start", (event: RolePromptEvent) => {
    // CLI flags are applied after extension factories run.
    const source = pi.getFlag(TASK_ROLE_PROMPT_FLAG);
    if (typeof source !== "string" || !source) return;
    const role = resolveRolePrompt(source);
    if (!role) return;

    const options = event.systemPromptOptions;
    if (options && options.forceSystemPrompt === undefined) {
      options.appendSystemPrompt = [options.appendSystemPrompt, role].filter(Boolean).join("\n\n");
      return;
    }
    // Legacy Pi, or an earlier extension's forced prompt: preserve that text.
    return { systemPrompt: [event.systemPrompt, role].filter(Boolean).join("\n\n") };
  });
}
