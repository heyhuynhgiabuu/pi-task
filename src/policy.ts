/** Minimal shared tool-policy helpers for task agent frontmatter. */

export const XAI_SIDE_TOOL_NAMES = [
  "xai_generate_text",
  "xai_multi_agent",
  "xai_web_search",
  "xai_x_search",
  "xai_code_execution",
  "xai_generate_image",
  "xai_analyze_image",
  "xai_deep_research",
  "xai_critique",
] as const;

function xaiSideToolsEnabled(): boolean {
  const raw = (process.env.PI_XAI_SIDE_TOOLS ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function parseMergedDisallowedTools(raw?: string): string[] {
  const result = new Set<string>();
  if (!xaiSideToolsEnabled()) {
    for (const tool of XAI_SIDE_TOOL_NAMES) result.add(tool);
  }

  for (const token of (raw ?? "").split(",")) {
    const value = token.trim();
    if (!value) continue;
    if (value === "xai") {
      for (const tool of XAI_SIDE_TOOL_NAMES) result.add(tool);
      continue;
    }
    result.add(value);
  }
  return [...result];
}
