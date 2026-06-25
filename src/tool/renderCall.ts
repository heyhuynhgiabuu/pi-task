import { Text } from "@earendil-works/pi-tui";

/** Render the task tool call line while the subagent is running. */
export function renderCall(args: unknown, theme: any) {
  const params = args as Record<string, unknown>;
  const agentName = (params.agent_type as string) || "...";
  const desc = (params.description as string) || "";

  let text = theme.fg("toolTitle", "");
  text += theme.fg("accent", agentName);
  if (desc) text += theme.fg("dim", ` - ${desc}`);
  return new Text(text, 0, 0);
}
