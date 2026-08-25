import { Container, Text } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { keyHint, keyText, rawKeyHint } from "@earendil-works/pi-coding-agent";
import { formatElapsed } from "../helpers.js";

export type TaskResultDetails = {
  agent_type?: string;
  description?: string;
  phase?: string;
  tool_uses?: number;
  duration_ms?: number;
  background?: boolean;
  summary?: string;
  findings?: string;
  evidence?: string;
  files?: string;
  caveats?: string;
  next_steps?: string;
  structured_result?:
    | boolean
    | { status?: string; raw_status?: string; valid?: boolean };
  full_output?: string;
};

/** Shared collapsed/expanded body for task tool results and task-complete notifications. */
export function renderTaskResultBody(
  details: TaskResultDetails,
  contentSummaryText: string,
  options: { expanded?: boolean; indentHint?: boolean },
  theme: Theme,
): InstanceType<typeof Container> {
  const tight = Boolean(details.background);
  let durationMs = 0;
  if (typeof details.duration_ms === "number" && details.duration_ms > 0) {
    durationMs = details.duration_ms;
  }

  const summaryLine = (details.summary ?? contentSummaryText).trim();
  const preview = summaryLine.slice(0, 120);
  const hintPrefix = options.indentHint ? " " : "";
  const expandHint = hintPrefix + parenthesizedExpandHint("to expand", theme);
  const collapseHint = hintPrefix + parenthesizedExpandHint("to collapse", theme);
  const structured = hasStructuredTaskDetails(details);
  const plainBody = (details.full_output ?? contentSummaryText).trim();
  const multilinePlain = !structured && plainBody.includes("\n");

  const container = new Container();

  if (typeof details.tool_uses === "number" && details.tool_uses > 0) {
    const toolsLabel =
      details.tool_uses === 1
        ? "1 toolcall"
        : `${details.tool_uses} toolcalls`;
    const statsText =
      " " +
      theme.fg("muted", toolsLabel) +
      (durationMs > 0
        ? theme.fg("muted", " • ") + theme.fg("success", formatElapsed(durationMs))
        : "");
    container.addChild(new Text(statsText, 0, 0));
  } else if (durationMs > 0) {
    container.addChild(
      new Text(" " + theme.fg("success", formatElapsed(durationMs)), 0, 0),
    );
  }

  if (options.expanded) {
    if (structured) {
      appendBlock(container, theme, "Summary", details.summary ?? summaryLine, tight);
      appendBlock(container, theme, "Findings", details.findings, tight);
      appendBlock(container, theme, "Evidence", details.evidence, tight);
      appendBlock(container, theme, "Files", details.files, tight);
      appendBlock(container, theme, "Caveats", details.caveats, tight);
      appendBlock(container, theme, "Next steps", details.next_steps, tight);
    } else if (plainBody) {
      for (const line of plainBody.split("\n")) {
        container.addChild(new Text(prefixResultLine(line, tight), 0, 0));
      }
    }
    container.addChild(new Text(collapseHint, 0, 0));
  } else {
    if (multilinePlain) {
      if (tight) {
        const line = pickLatestCollapsedPreviewLine(plainBody);
        if (line) {
          const branchPreview = line.startsWith("⎿")
            ? line
            : `⎿ ${line}`;
          container.addChild(
            new Text(
              theme.fg("dim", prefixResultLine(branchPreview, true)),
              0, 0,
            ),
          );
        }
      } else {
        for (const line of plainBody.split("\n")) {
          container.addChild(
            new Text(theme.fg("dim", prefixResultLine(line, tight)), 0, 0),
          );
        }
      }
    } else if (preview) {
      const branchPreview = preview.startsWith("⎿")
        ? preview
        : `⎿ ${preview}`;
      const previewText =
        (tight ? " " : "") +
        prefixResultLine(branchPreview, tight) +
        (summaryLine.length > 120 ? theme.fg("dim", "…") : "");
      container.addChild(new Text(previewText, 0, 0));
    }
    if (
      summaryLine.length > 120 ||
      structured ||
      multilinePlain ||
      (details.full_output ?? "").length > summaryLine.length
    ) {
      container.addChild(new Text(expandHint, 0, 0));
    }
  }

  return container;
}

function hasStructuredTaskDetails(details: TaskResultDetails): boolean {
  if (!details.structured_result) return false;
  return Boolean(
    details.findings ||
      details.evidence ||
      details.files ||
      details.caveats ||
      details.next_steps,
  );
}

function appendBlock(
  container: InstanceType<typeof Container>,
  theme: Theme,
  label: string,
  body: string | undefined,
  tight: boolean,
) {
  const text = (body ?? "").trim();
  if (!text) return;
  container.addChild(
    new Text(theme.fg("toolTitle", ` ${label}`), 0, 0),
  );
  for (const line of text.split("\n")) {
    container.addChild(new Text(prefixResultLine(line, tight), 0, 0));
  }
}

function expandCollapseHint(action: "to expand" | "to collapse") {
  return keyText("app.tools.expand").trim()
    ? keyHint("app.tools.expand", action)
    : rawKeyHint("ctrl+o", action);
}

/** Parens stay dim; inner hint keeps key/muted styles (trailing `)` was default fg after ANSI reset). */
function parenthesizedExpandHint(
  action: "to expand" | "to collapse",
  theme: Theme,
): string {
  const inner = expandCollapseHint(action);
  return theme.fg("dim", "(") + inner + theme.fg("dim", ")");
}

function pickLatestCollapsedPreviewLine(plainBody: string): string | undefined {
  const lines = plainBody
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) return undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.trimStart().startsWith("⎿")) return lines[i]!;
  }
  return lines[lines.length - 1]!;
}

function prefixResultLine(line: string, _tight: boolean): string {
  const trimmed = line.trimEnd();
  if (trimmed.startsWith("⎿")) {
    return trimmed;
  }
  return ` ${trimmed.trimStart()}`;
}