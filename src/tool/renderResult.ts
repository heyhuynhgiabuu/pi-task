import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { keyHint, keyText, rawKeyHint } from "@earendil-works/pi-coding-agent";
import { formatMs } from "../helpers.js";

/**
 * Custom renderResult for the task tool.
 * Supports collapsed/expanded views with Ctrl+O (app.tools.expand).
 */
export function renderResult(result: any, options: { expanded?: boolean }, theme: any) {
  const details = (result.details ?? {}) as {
    agent_type?: string;
    description?: string;
    phase?: string;
    tool_uses?: number;
    duration_ms?: number;
    background?: boolean;
  };

  const stats: string[] = [];
  if (typeof details.tool_uses === "number" && details.tool_uses > 0) {
    stats.push(
      theme.fg("muted", `${details.tool_uses} toolcall${details.tool_uses === 1 ? "" : "s"}`),
    );
  }
  if (typeof details.duration_ms === "number" && details.duration_ms > 0) {
    stats.push(theme.fg("muted", formatMs(details.duration_ms)));
  }

  const firstContent = result.content?.[0];
  const fullText =
    firstContent && "text" in firstContent
      ? (firstContent.text ?? "").trim()
      : "";
  const preview = fullText.slice(0, 120);
  const expandHint = expandCollapseHint("to expand");
  const collapseHint = expandCollapseHint("to collapse");

  const container = new Container();

  if (stats.length) {
    container.addChild(new Text(stats.join(theme.fg("dim", " • ")), 0, 0));
  }

  if (options.expanded) {
    if (fullText) {
      for (const line of fullText.split("\n")) {
        container.addChild(new Text(truncateToWidth(line, 200), 0, 0));
      }
    }
    container.addChild(
      new Text(theme.fg("dim", `  (${collapseHint})`), 0, 0),
    );
  } else {
    if (preview) {
      container.addChild(
        new Text(
          theme.fg("dim", `  ⎿  ${preview}`) +
            (fullText.length > 120 ? theme.fg("dim", "…") : ""),
          0,
          0,
        ),
      );
    }
    if (fullText.length > 120) {
      container.addChild(
        new Text(theme.fg("dim", `  (${expandHint})`), 0, 0),
      );
    }
  }

  return container;
}

function expandCollapseHint(action: "to expand" | "to collapse") {
  return keyText("app.tools.expand").trim()
    ? keyHint("app.tools.expand", action)
    : rawKeyHint("Ctrl+O", action);
}




