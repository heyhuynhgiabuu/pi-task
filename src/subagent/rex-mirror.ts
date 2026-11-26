/**
 * Rex mirror launcher: opens a view-only pane running `rex-view` against a
 * durable child's live snapshot file. Manual `o` splits right of Pi; automatic
 * mirrors for durable tasks always open in a new Rex window without stealing
 * focus.
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
// Automatic calls only ever act inside a running Rex: a stale environment
// must not start a server, and a hung one must fail in time to fall back.
const REX_AUTO_BOUNDS = ["--autostart=false", "--timeout", REX_AUTO_TIMEOUT] as const;

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

type ResolvedRexTarget =
  | { ok: true; session: string; block: string }
  | { ok: false; error: string };

/**
 * Current Rex sets `REX_BLOCK` without `REX_SESSION`; older setups set both.
 * When `REX_SESSION` is absent, resolve `session_id` through `rex whoami --json`.
 */
async function resolveRexTarget(
  runner: CommandRunner,
  env: NodeJS.ProcessEnv,
  bounds: readonly string[],
): Promise<ResolvedRexTarget> {
  const block = env.REX_BLOCK?.trim();
  if (!block) {
    return {
      ok: false,
      error: "Rex mirror requires Pi to be running inside Rex (REX_BLOCK is not set).",
    };
  }
  const envSession = env.REX_SESSION?.trim();
  if (envSession) {
    return { ok: true, session: envSession, block };
  }
  try {
    const whoami = await runner.run("rex", ["whoami", "--json", ...bounds], { env });
    let parsed: unknown;
    try {
      parsed = JSON.parse(whoami.stdout);
    } catch {
      return { ok: false, error: "rex whoami returned invalid JSON output." };
    }
    const sessionId =
      parsed && typeof parsed === "object"
        ? (parsed as { session_id?: unknown }).session_id
        : undefined;
    if (typeof sessionId !== "string" || !sessionId.trim()) {
      return { ok: false, error: "rex whoami response did not include session_id." };
    }
    return { ok: true, session: sessionId.trim(), block };
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

async function launchMirrorPane(
  input: RexMirrorLaunchInput,
  options: RexMirrorLaunchOptions,
  mode: "split" | "new-window",
): Promise<RexMirrorLaunchResult> {
  const env = options.env ?? process.env;
  const runner = options.runner ?? createDefaultCommandRunner();
  const bounds = mode === "new-window" ? REX_AUTO_BOUNDS : [];
  const target = await resolveRexTarget(runner, env, bounds);
  if (!target.ok) return target;

  const execPath = options.execPath ?? process.execPath;
  const viewerPath = options.viewerPath ?? resolveRexViewerPath();
  const label = formatRexMirrorLabel(input.taskId, input.agentType, input.description);
  const subcommand = mode === "split" ? "split" : "run";
  const placementArgs =
    mode === "split" ? ["-b", target.block, "--split=right", "--ratio", REX_SPLIT_RATIO] : [];

  const args = [
    subcommand,
    "-s",
    target.session,
    ...placementArgs,
    "--focus=false",
    "-c",
    input.cwd,
    "--label",
    label,
    ...bounds,
    "--json",
    "--",
    execPath,
    viewerPath,
    input.snapshotPath,
  ];

  try {
    const result = await runner.run("rex", args, { env });
    return parseCreatedBlock(result.stdout, subcommand);
  } catch (error) {
    return { ok: false, error: describeRexFailure(error) };
  }
}

export function launchRexMirror(
  input: RexMirrorLaunchInput,
  options: RexMirrorLaunchOptions = {},
): Promise<RexMirrorLaunchResult> {
  return launchMirrorPane(input, options, "split");
}

export function launchAutoRexMirror(
  input: RexMirrorLaunchInput,
  options: RexMirrorLaunchOptions = {},
): Promise<RexMirrorLaunchResult> {
  return launchMirrorPane(input, options, "new-window");
}
