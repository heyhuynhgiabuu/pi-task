import { Text } from "@earendil-works/pi-tui";
import { keyHint, keyText, rawKeyHint } from "@earendil-works/pi-coding-agent";

/**
 * Renderer for background task completion notifications.
 * Supports collapsed/expanded views with Ctrl+O.
 */
export function createTaskCompleteRenderer() {
  return (message: any, { expanded }: { expanded?: boolean }, theme: any) => {
    const d = message.details as Record<string, unknown> | undefined;
    if (!d) return undefined;

    const agentType = (d.agent_type as string) || "";
    const desc = (d.description as string) || "";
    const result = ((d.result as string) || "").trim();
    const durationMs = (d.duration_ms as number) || 0;
    const toolUses = (d.tool_uses as number) || 0;

    let line = " " + theme.fg("accent", agentType);
    if (desc) line += theme.fg("dim", ` - ${desc}`);

    const useStr = toolUses > 0 ? `${toolUses} toolcalls` : "";
    const durStr = durationMs >= 1000 ? formatMs(durationMs) : "";
    const statsParts = [useStr, durStr].filter(Boolean);
    const statsText = statsParts.join(" • ");

    if (statsText) {
      line += "\n " + theme.fg("dim", statsText);
    }

    const expandHint = expandCollapseHint("to expand");
    const collapseHint = expandCollapseHint("to collapse");

    if (expanded) {
      if (result) line += "\n " + theme.fg("muted", result);
      line += "\n " + theme.fg("dim", `  (${collapseHint})`);
    } else {
      const preview = result.slice(0, 120);
      if (preview) {
        line +=
          "\n " +
          theme.fg("dim", `  ⎿  ${preview}`) +
          (result.length > 120 ? theme.fg("dim", "…") : "");
      }
      if (result.length > 120) {
        line += "\n " + theme.fg("dim", `  (${expandHint})`);
      }
    }

    if (!line.trim()) return undefined;
    const subtleBg = (text: string) => `\x1b[48;2;30;28;44m${text}\x1b[0m`;
    return new Text(line, 0, 1, subtleBg);
  };
}

function expandCollapseHint(action: "to expand" | "to collapse") {
  return keyText("app.tools.expand").trim()
    ? keyHint("app.tools.expand", action)
    : rawKeyHint("Ctrl+O", action);
}

function formatMs(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}
