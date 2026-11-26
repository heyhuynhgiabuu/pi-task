import { Box, MouseRegion, Text } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  renderTaskResultBody,
  type TaskResultDetails,
} from "./renderTaskResultBody.js";
import { renderTaskTitleText } from "./taskTitle.js";

/**
 * Renderer for background task completion notifications.
 * Same structured sections as foreground task renderResult (Ctrl+O).
 * A left click on the title row toggles this card only, like a native tool card.
 */
export function createTaskCompleteRenderer() {
  return (
    message: { details?: unknown },
    { expanded }: { expanded?: boolean },
    theme: Theme,
  ) => {
    const d = (message.details ?? {}) as TaskResultDetails & {
      agent_type?: string;
      description?: string;
      summary?: string;
      result?: string;
    };
    if (!d.agent_type && !d.description && !d.summary && !d.result) {
      return undefined;
    }

    const agentType = d.agent_type || "task";
    const desc = d.description || "";
    const title = renderTaskTitleText(agentType, desc, theme);
    const summaryText = (d.summary || "").trim();

    // Per-card state seeded from the Ctrl+O flag. The host re-runs this renderer
    // on Ctrl+O and theme changes, which resets any local toggle.
    let cardExpanded = expanded === true;
    const box = new Box(0, 1, (text) => theme.bg("toolSuccessBg", text));
    const rebuild = () => {
      box.clear();
      box.addChild(
        new MouseRegion(new Text(" " + title, 0, 0), (event) => {
          // Native click semantics: left click only, handled (repaints), no focus.
          if (event.type !== "click" || event.button !== "left") return undefined;
          cardExpanded = !cardExpanded;
          rebuild();
          return { handled: true };
        }),
      );
      box.addChild(
        renderTaskResultBody(
          d,
          summaryText,
          { expanded: cardExpanded, indentHint: true },
          theme,
        ),
      );
    };
    rebuild();
    return box;
  };
}
