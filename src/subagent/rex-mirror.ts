/**
 * Rex mirror launcher: opens a view-only split pane beside the parent Pi
 * block running `rex-view` against a durable child's live snapshot file.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  createDefaultCommandRunner,
  describeCommandFailure,
  type CommandRunner,
} from "./terminalBackend.js";

const REX_SPLIT_RATIO = "40";
const REX_LABEL_MAX_CHARS = 128;
const REX_AUTO_TIMEOUT = "10s";

export interface RexMirrorLaunchInput {
  taskId: string;
  agentType: string;
  description: string;
  cwd: string;
  snapshotPath: string;
}

export interface RexMirrorLaunchOptions {
  runner?: CommandRunner;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  viewerPath?: string;
}

export type RexMirrorLaunchResult =
  | { ok: true; blockId: string }
  | { ok: false; error: string };

/**
 * Where the viewer entry lives relative to this module. Loaded from TypeScript
 * (`pi -e ./src/index.ts`), the TypeScript sibling comes first so a stale build
 * never shadows the source; running it needs a runtime that strips types.
 */
export function rexViewerCandidates(moduleUrl: string): string[] {
  if (moduleUrl.endsWith(".ts")) {
    return [
      new URL("../rex-view.ts", moduleUrl).href,
      new URL("../../dist/rex-view.js", moduleUrl).href,
    ];
  }
  return [new URL("../rex-view.js", moduleUrl).href];
}

export function resolveRexViewerPath(moduleUrl: string = import.meta.url): string {
  const candidates = rexViewerCandidates(moduleUrl).map((href) => fileURLToPath(href));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0]!;
}

export function formatRexMirrorLabel(
  taskId: string,
  agentType: string,
  description: string,
): string {
  const cleanDesc = description.replace(/[\r\n\t]+/g, " ").trim();
  const base = cleanDesc ? `${agentType} (${taskId}): ${cleanDesc}` : `${agentType} (${taskId})`;
  return base.slice(0, REX_LABEL_MAX_CHARS);
}

export async function launchRexMirror(
  input: RexMirrorLaunchInput,
  options: RexMirrorLaunchOptions = {},
): Promise<RexMirrorLaunchResult> {
  const env = options.env ?? process.env;
  const session = env.REX_SESSION?.trim();
  const block = env.REX_BLOCK?.trim();
  if (!session || !block) {
    return {
      ok: false,
      error: "Rex mirror requires Pi to be running inside Rex (REX_SESSION and REX_BLOCK are not set).",
    };
  }

  const execPath = options.execPath ?? process.execPath;
  const viewerPath = options.viewerPath ?? resolveRexViewerPath();
  const runner = options.runner ?? createDefaultCommandRunner();
  const label = formatRexMirrorLabel(input.taskId, input.agentType, input.description);

  const args = [
    "split",
    "-s",
    session,
    "-b",
    block,
    "--split=right",
    "--ratio",
    REX_SPLIT_RATIO,
    "--focus=false",
    "-c",
    input.cwd,
    "--label",
    label,
    "--json",
    "--",
    execPath,
    viewerPath,
    input.snapshotPath,
  ];

  try {
    const result = await runner.run("rex", args, { env });
    return parseCreatedBlock(result.stdout, "split");
  } catch (error) {
    return { ok: false, error: describeRexFailure(error) };
  }
}

function parseCreatedBlock(stdout: string, subcommand: string): RexMirrorLaunchResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return {
      ok: false,
      error: `rex ${subcommand} returned invalid JSON output.`,
    };
  }
  const blockIds =
    parsed && typeof parsed === "object"
      ? (parsed as { block_ids?: unknown }).block_ids
      : undefined;
  const blockId =
    Array.isArray(blockIds) && typeof blockIds[0] === "string" && blockIds[0].length > 0
      ? blockIds[0]
      : undefined;
  if (!blockId) {
    return {
      ok: false,
      error: `rex ${subcommand} response did not include block_ids[0].`,
    };
  }
  return { ok: true, blockId };
}

function describeRexFailure(error: unknown): string {
  const reason = describeCommandFailure(error);
  // The default runner reports a binary it could not start without its ENOENT
  // code or any output, so that failure is indistinguishable except by shape.
  return /exited unsuccessfully$/.test(reason)
    ? `${reason}: rex could not be started; is the rex command on PATH?`
    : reason;
}

interface RexWindowLayout {
  windowId: string;
  blockIds: string[];
}

/** Returns undefined for any session shape this module does not recognize. */
function parseRexWindows(stdout: string): RexWindowLayout[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const windows = (parsed as { windows?: unknown } | null)?.windows;
  if (!Array.isArray(windows)) return undefined;
  const layouts: RexWindowLayout[] = [];
  for (const window of windows) {
    if (!window || typeof window !== "object") return undefined;
    const { window_id: windowId, layers } = window as { window_id?: unknown; layers?: unknown };
    if (typeof windowId !== "string" || !windowId || !Array.isArray(layers)) return undefined;
    const blockIds: string[] = [];
    for (const layer of layers) {
      const blocks = (layer as { blocks?: unknown } | null)?.blocks;
      if (!Array.isArray(blocks)) return undefined;
      for (const block of blocks) {
        const blockId = (block as { block_id?: unknown } | null)?.block_id;
        if (typeof blockId !== "string" || !blockId) return undefined;
        blockIds.push(blockId);
      }
    }
    layouts.push({ windowId, blockIds });
  }
  return layouts;
}

/** Window id from a `rex run --json` creation response, if it carries one. */
function parseCreatedWindowId(stdout: string): string | undefined {
  try {
    const windowId = (JSON.parse(stdout) as { window_id?: unknown } | null)?.window_id;
    return typeof windowId === "string" && windowId ? windowId : undefined;
  } catch {
    return undefined;
  }
}

// Placement is serialized per Rex session so simultaneous launches never
// inspect the same layout. Overflow ownership is kept per session and parent
// block as window id -> owned viewer block ids (labels are mutable, and a block
// moved into another window must not make that window ours).
const rexPlacementQueues = new Map<string, Promise<unknown>>();
const rexOverflowWindows = new Map<string, Map<string, Set<string>>>();

function serializePlacement<T>(session: string, task: () => Promise<T>): Promise<T> {
  const previous = rexPlacementQueues.get(session) ?? Promise.resolve();
  const next = previous.then(task, task);
  const tail = next.catch(() => undefined);
  rexPlacementQueues.set(session, tail);
  void tail.then(() => {
    if (rexPlacementQueues.get(session) === tail) rexPlacementQueues.delete(session);
  });
  return next;
}

async function findWindowOfBlock(
  runner: CommandRunner,
  env: NodeJS.ProcessEnv,
  session: string,
  bounds: string[],
  blockId: string,
): Promise<string | undefined> {
  try {
    const inspected = await runner.run(
      "rex",
      ["session", "inspect", session, "--json", ...bounds],
      { env },
    );
    // `rex run` always creates a window holding only its block; anything else is not verified as ours.
    return parseRexWindows(inspected.stdout)?.find(
      (window) =>
        window.blockIds.length === 1 && window.blockIds[0] === blockId,
    )?.windowId;
  } catch {
    return undefined;
  }
}

/**
 * Opens a durable mirror without moving or focusing anything: split right of
 * the parent when its window holds only the parent, else split right of an
 * overflow window this parent created that still holds only its mirror, else
 * a new window. Never splits a window holding any other block.
 */
export async function launchAutoRexMirror(
  input: RexMirrorLaunchInput,
  options: RexMirrorLaunchOptions = {},
): Promise<RexMirrorLaunchResult> {
  const env = options.env ?? process.env;
  const session = env.REX_SESSION?.trim();
  const block = env.REX_BLOCK?.trim();
  if (!session || !block) {
    return {
      ok: false,
      error: "Rex mirror requires Pi to be running inside Rex (REX_SESSION and REX_BLOCK are not set).",
    };
  }

  const execPath = options.execPath ?? process.execPath;
  const viewerPath = options.viewerPath ?? resolveRexViewerPath();
  const runner = options.runner ?? createDefaultCommandRunner();
  const label = formatRexMirrorLabel(input.taskId, input.agentType, input.description);
  // Automatic calls only ever act inside a running Rex: a stale environment
  // must not start a server, and a hung one must fail in time to fall back.
  const bounds = ["--autostart=false", "--timeout", REX_AUTO_TIMEOUT];
  const viewerArgs = ["--json", "--", execPath, viewerPath, input.snapshotPath];

  return serializePlacement(session, async () => {
    try {
      const inspected = await runner.run(
        "rex",
        ["session", "inspect", session, "--json", ...bounds],
        { env },
      );
      const windows = parseRexWindows(inspected.stdout);
      if (!windows) {
        return { ok: false, error: "rex session inspect returned an unrecognized layout." };
      }
      const parentWindow = windows.find((window) => window.blockIds.includes(block));
      if (!parentWindow) {
        return { ok: false, error: `rex session inspect did not include parent block ${block}.` };
      }

      const ownerKey = `${session}\0${block}`;
      const owned = rexOverflowWindows.get(ownerKey) ?? new Map<string, Set<string>>();
      for (const [ownedWindowId, ownedBlockIds] of owned) {
        const current = windows.find((window) => window.windowId === ownedWindowId);
        for (const ownedId of ownedBlockIds) {
          if (!current?.blockIds.includes(ownedId)) ownedBlockIds.delete(ownedId);
        }
        if (ownedBlockIds.size === 0) owned.delete(ownedWindowId);
      }

      let anchor: string | undefined;
      let overflowWindowId: string | undefined;
      if (parentWindow.blockIds.length === 1) {
        anchor = block;
      } else {
        const overflow = windows.find(
          (window) =>
            window.windowId !== parentWindow.windowId &&
            window.blockIds.length === 1 &&
            owned.get(window.windowId)?.has(window.blockIds[0]!),
        );
        anchor = overflow?.blockIds[0];
        overflowWindowId = overflow?.windowId;
      }

      const command = anchor ? "split" : "run";
      const splitArgs = anchor ? ["-b", anchor, "--split=right", "--ratio", REX_SPLIT_RATIO] : [];
      const created = await runner.run(
        "rex",
        [
          command,
          "-s",
          session,
          ...splitArgs,
          "--focus=false",
          "-c",
          input.cwd,
          "--label",
          label,
          ...bounds,
          ...viewerArgs,
        ],
        { env },
      );
      const result = parseCreatedBlock(created.stdout, command);
      if (result.ok && overflowWindowId) {
        owned.get(overflowWindowId)?.add(result.blockId);
      } else if (result.ok && !anchor) {
        // Only a verified window is recorded; a failed lookup costs reuse, not the launch.
        const windowId =
          parseCreatedWindowId(created.stdout) ??
          (await findWindowOfBlock(runner, env, session, bounds, result.blockId));
        if (windowId) {
          owned.set(windowId, new Set([result.blockId]));
          rexOverflowWindows.set(ownerKey, owned);
        }
      }
      return result;
    } catch (error) {
      return { ok: false, error: describeRexFailure(error) };
    }
  });
}
