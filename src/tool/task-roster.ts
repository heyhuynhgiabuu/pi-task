/**
 * Keep the task tool's roster in step with the agents that are actually there.
 *
 * `buildTaskToolDescription` renders one line per visible agent into the tool
 * description, which is what the model reads when deciding whom to delegate to.
 * That description was built once at registration and never again, so the roster
 * went stale two ways: launching pi in a subdirectory kept the launch
 * directory's agents, and adding or editing a role file mid session was
 * invisible to the model.
 *
 * `prepareLoadout` is pi's per-turn hook for exactly this: a tool that
 * orchestrates other tools lists them in its own description. Rebuilding costs
 * about 0.33 ms, so there is nothing to cache.
 */

import { buildTaskToolDescription, discoverAgents } from "../helpers.js";

/** The part of pi's ToolLoadout this module reads. */
interface LoadoutShape {
  declared: readonly { name: string }[];
}

/**
 * The prepareLoadout change for the roster, or undefined when the task tool is
 * not offered this turn.
 */
export function rosterLoadoutChange(
  loadout: LoadoutShape,
  cwd: string,
  bundledAgentDir: string | undefined,
  taskToolName = "task",
): { descriptions: Record<string, string> } | undefined {
  if (!loadout.declared.some((tool) => tool.name === taskToolName)) return undefined;

  return {
    descriptions: {
      [taskToolName]: buildTaskToolDescription(discoverAgents(cwd, bundledAgentDir).agents),
    },
  };
}
