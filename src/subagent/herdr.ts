import { execFileSync } from "node:child_process";
import { isAbsolute } from "node:path";
import type { HerdrTerminalHandle } from "../types.js";
import {
  createDefaultCommandRunner,
  type CommandRunner,
  type TerminalBackend,
  type TerminalLaunchInput,
} from "./terminalBackend.js";

interface HerdrPane {
  pane_id: string;
  terminal_id: string;
  tab_id?: string;
}

interface HerdrWorkspace {
  workspace_id: string;
  root_pane_id: string;
}

interface HerdrResponse<T> {
  result?: T;
}

let launchQueue: Promise<void> = Promise.resolve();
const groupedWorkspaces = new Map<
  string,
  { workspaceId: string; paneIds: Set<string> }
>();

function workspaceGroupKey(socketPath: string, group: string): string {
  return `${socketPath}\u0000${group}`;
}

async function serializeLaunch<T>(operation: () => Promise<T>): Promise<T> {
  const previous = launchQueue;
  let release!: () => void;
  launchQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

function decode<T>(stdout: string, operation: string): T {
  try {
    const parsed = JSON.parse(stdout) as T | HerdrResponse<T>;
    if (parsed && typeof parsed === "object" && "result" in parsed) {
      return (parsed as HerdrResponse<T>).result as T;
    }
    return parsed as T;
  } catch (error) {
    throw new Error(
      `HerdR ${operation} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function paneFrom(value: unknown): HerdrPane {
  const candidate = value as {
    pane?: Partial<HerdrPane>;
    agent?: Partial<HerdrPane>;
  };
  const pane = candidate.pane ?? candidate.agent;
  if (
    typeof pane?.pane_id !== "string" ||
    typeof pane.terminal_id !== "string"
  ) {
    throw new Error("HerdR response did not include pane_id and terminal_id");
  }
  return pane as HerdrPane;
}

function paneHostsPi(value: unknown): boolean {
  const candidate = value as { pane?: { agent?: unknown } };
  return candidate.pane?.agent === "pi";
}

function workspaceFrom(value: unknown): HerdrWorkspace {
  const candidate = value as {
    workspace?: { workspace_id?: unknown };
    root_pane?: { pane_id?: unknown };
  };
  if (
    typeof candidate.workspace?.workspace_id !== "string" ||
    typeof candidate.root_pane?.pane_id !== "string"
  ) {
    throw new Error(
      "HerdR response did not include workspace_id and root pane_id",
    );
  }
  return {
    workspace_id: candidate.workspace.workspace_id,
    root_pane_id: candidate.root_pane.pane_id,
  };
}

function isMissingWorkspace(error: unknown): boolean {
  return /workspace_not_found|workspace not found/i.test(String(error));
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const output = error as Error & { stdout?: unknown; stderr?: unknown };
  return [error.message, output.stdout, output.stderr]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

function isAgentPaneBusy(error: unknown): boolean {
  return /agent_pane_busy|not an available shell/i.test(errorText(error));
}

function isAgentPromptRetryable(error: unknown): boolean {
  return /agent_prompt_stalled|timed out waiting for agent status|"code"\s*:\s*"timeout"|"code"\s*:\s*"agent_prompt_stalled"/i.test(
    errorText(error),
  );
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function requireHerdrHandle(
  handle: Parameters<TerminalBackend["isAlive"]>[0],
): HerdrTerminalHandle {
  if (handle.backend !== "herdr")
    throw new Error("HerdR backend cannot control a non-HerdR handle");
  return handle;
}

export interface HerdrTerminalBackendOptions {
  run?: CommandRunner["run"];
  env?: NodeJS.ProcessEnv;
}

export function createHerdrTerminalBackend(
  options: HerdrTerminalBackendOptions = {},
): TerminalBackend {
  const env = options.env ?? process.env;
  const runner = options.run ?? createDefaultCommandRunner().run;
  const socketPath = env.HERDR_SOCKET_PATH;
  const run = (args: readonly string[]) =>
    runner("herdr", args, {
      env: { ...env, HERDR_SOCKET_PATH: socketPath },
    });

  const verifyOwnership = async (
    rawHandle: Parameters<TerminalBackend["isAlive"]>[0],
  ): Promise<HerdrTerminalHandle> => {
    const handle = requireHerdrHandle(rawHandle);
    if (!socketPath || handle.socketPath !== socketPath) {
      throw new Error("HerdR ownership mismatch: session socket changed");
    }
    const response = await run(["pane", "get", handle.resourceId]);
    const current = paneFrom(decode(response.stdout, "pane get"));
    if (current.terminal_id !== handle.terminalId) {
      throw new Error("HerdR ownership mismatch: terminal changed");
    }
    return handle;
  };

  return {
    kind: "herdr",

    async available() {
      if (
        env.HERDR_ENV !== "1" ||
        !env.HERDR_PANE_ID ||
        !socketPath ||
        !isAbsolute(socketPath)
      )
        return false;
      try {
        await run(["status", "server"]);
        await run(["pane", "current", "--current"]);
        return true;
      } catch {
        return false;
      }
    },

    async launch(input: TerminalLaunchInput) {
      return serializeLaunch(async () => {
        if (
          env.HERDR_ENV !== "1" ||
          !env.HERDR_PANE_ID ||
          !socketPath ||
          !isAbsolute(socketPath)
        ) {
          throw new Error(
            "HerdR backend requires Pi to run inside an active HerdR pane",
          );
        }
        const groupKey = input.workspaceGroup
          ? workspaceGroupKey(socketPath, input.workspaceGroup)
          : undefined;
        const existingGroup = groupKey
          ? groupedWorkspaces.get(groupKey)
          : undefined;
        const terminalEnvArgs = Object.entries(input.env ?? {}).flatMap(
          ([name, value]) => ["--env", `${name}=${value}`],
        );
        const workspaceResponse =
          groupKey && !existingGroup
            ? await run([
                "workspace",
                "create",
                "--cwd",
                input.cwd,
                ...terminalEnvArgs,
                "--label",
                input.workspaceGroup!,
                "--no-focus",
              ])
            : undefined;
        const workspace = workspaceResponse
          ? workspaceFrom(decode(workspaceResponse.stdout, "workspace create"))
          : undefined;
        let created: HerdrPane | undefined;
        try {
          if (workspace) {
            const response = await run(["pane", "get", workspace.root_pane_id]);
            created = paneFrom(decode(response.stdout, "pane get"));
          } else {
            const targetPane = existingGroup
              ? existingGroup.paneIds.values().next().value
              : undefined;
            if (existingGroup && !targetPane) {
              throw new Error("HerdR workspace has no live task pane to split");
            }
            const response = await run([
              "pane",
              "split",
              ...(targetPane ? [targetPane] : ["--current"]),
              "--direction",
              input.direction ?? "right",
              "--cwd",
              input.cwd,
              ...terminalEnvArgs,
              "--no-focus",
            ]);
            created = paneFrom(decode(response.stdout, "pane split"));
          }
          const startArgs = [
            "agent",
            "start",
            input.label ?? "pi-task",
            "--kind",
            "pi",
            "--pane",
            created.pane_id,
            "--",
            ...(input.agentArgs ?? []),
          ];
          const deadline = Date.now() + 3_000;
          while (true) {
            try {
              const response = await run(startArgs);
              created = paneFrom(decode(response.stdout, "agent start"));
              break;
            } catch (error) {
              if (!isAgentPaneBusy(error) || Date.now() >= deadline) throw error;
              await sleep(50);
            }
          }
          if (input.initialPrompt !== undefined) {
            const promptArgs = [
              "agent",
              "prompt",
              created.pane_id,
              input.initialPrompt,
              "--wait",
              "--until",
              "working",
              "--until",
              "blocked",
              "--until",
              "done",
              "--timeout",
              "8000",
            ];
            try {
              await run(promptArgs);
            } catch (error) {
              if (!isAgentPromptRetryable(error)) throw error;
              await run(["agent", "send-keys", created.pane_id, "enter"]);
              await run([
                "agent",
                "wait",
                created.pane_id,
                "--until",
                "working",
                "--until",
                "blocked",
                "--until",
                "done",
                "--timeout",
                "8000",
              ]);
            }
          }
          if (groupKey) {
            const group = existingGroup ?? {
              workspaceId: workspace!.workspace_id,
              paneIds: new Set<string>(),
            };
            group.paneIds.add(created.pane_id);
            groupedWorkspaces.set(groupKey, group);
          }
          return {
            backend: "herdr" as const,
            resourceId: created.pane_id,
            socketPath,
            terminalId: created.terminal_id,
            ...(workspace || existingGroup
              ? { workspaceId: workspace?.workspace_id ?? existingGroup!.workspaceId }
              : {}),
            ...(input.workspaceGroup
              ? { workspaceGroup: input.workspaceGroup }
              : {}),
          };
        } catch (error) {
          if (workspace) {
            await run(["workspace", "close", workspace.workspace_id]).catch(
              () => undefined,
            );
          } else if (created) {
            await run(["pane", "close", created.pane_id]).catch(() => undefined);
          }
          throw error;
        }
      });
    },

    async isAlive(handle) {
      try {
        const owned = requireHerdrHandle(handle);
        if (!socketPath || owned.socketPath !== socketPath) return false;
        const response = await run(["pane", "get", owned.resourceId]);
        const payload = decode(response.stdout, "pane get");
        if (paneFrom(payload).terminal_id !== owned.terminalId) return false;
        return paneHostsPi(payload);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/ownership mismatch|not[_ -]?found/i.test(message)) return false;
        const unavailable = new Error(`HerdR control unavailable: ${message}`);
        unavailable.name = "HerdrUnavailableError";
        throw unavailable;
      }
    },

    async send(handle, message) {
      const owned = await verifyOwnership(handle);
      await run(["pane", "send-text", owned.resourceId, message]);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await run(["pane", "send-keys", owned.resourceId, "enter"]);
    },

    async readTail(handle, lines) {
      const owned = await verifyOwnership(handle);
      const response = await run([
        "pane",
        "read",
        owned.resourceId,
        "--source",
        "recent-unwrapped",
        "--lines",
        String(Math.max(1, Math.floor(lines))),
      ]);
      try {
        const result = decode<{ text?: string; output?: string }>(
          response.stdout,
          "pane read",
        );
        return result.text ?? result.output ?? response.stdout;
      } catch {
        return response.stdout;
      }
    },

    async close(handle) {
      return serializeLaunch(async () => {
      if (
        handle.backend === "herdr" &&
        handle.workspaceId &&
        handle.workspaceGroup
      ) {
        const key = workspaceGroupKey(handle.socketPath, handle.workspaceGroup);
        const group = groupedWorkspaces.get(key);
        if (!group || group.workspaceId !== handle.workspaceId) {
          await run(["pane", "close", handle.resourceId]);
          return;
        }
        if (!group.paneIds.delete(handle.resourceId)) return;
        if (group.paneIds.size > 0) {
          await run(["pane", "close", handle.resourceId]);
          return;
        }
        groupedWorkspaces.delete(key);
        await run(["workspace", "close", handle.workspaceId]);
        return;
      }
      if (handle.backend === "herdr" && handle.workspaceId) {
        await run(["workspace", "close", handle.workspaceId]);
        return;
      }

      const owned = await verifyOwnership(handle);
      await run(["pane", "close", owned.resourceId]);
      });
    },
  };
}

export function createDefaultHerdrTerminalBackend(
  env: NodeJS.ProcessEnv = process.env,
): TerminalBackend {
  return createHerdrTerminalBackend({ env });
}

function syncRun(args: readonly string[], socketPath: string): string {
  return execFileSync("herdr", args, {
    encoding: "utf8",
    env: { ...process.env, HERDR_SOCKET_PATH: socketPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function createSyncHerdrControl(
  env: NodeJS.ProcessEnv = process.env,
  run: (args: readonly string[], socketPath: string) => string = syncRun,
) {
  return {
    exists(handle: HerdrTerminalHandle): boolean {
      if (!env.HERDR_SOCKET_PATH || env.HERDR_SOCKET_PATH !== handle.socketPath)
        return false;
      try {
        return (
          paneFrom(
            decode(
              run(["pane", "get", handle.resourceId], handle.socketPath),
              "pane get",
            ),
          ).terminal_id === handle.terminalId
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/not[_ -]?found/i.test(message)) return false;
        const unavailable = new Error(`HerdR control unavailable: ${message}`);
        unavailable.name = "HerdrUnavailableError";
        throw unavailable;
      }
    },
    send(handle: HerdrTerminalHandle, message: string): void {
      if (!this.exists(handle)) throw new Error("HerdR ownership mismatch");
      run(["pane", "send-text", handle.resourceId, message], handle.socketPath);
      sleepSync(300);
      run(["pane", "send-keys", handle.resourceId, "enter"], handle.socketPath);
    },
    close(handle: HerdrTerminalHandle): void {
      if (
        handle.backend === "herdr" &&
        handle.workspaceId &&
        handle.workspaceGroup
      ) {
        const key = workspaceGroupKey(handle.socketPath, handle.workspaceGroup);
        const group = groupedWorkspaces.get(key);
        if (!group || group.workspaceId !== handle.workspaceId) {
          run(["pane", "close", handle.resourceId], handle.socketPath);
          return;
        }
        if (!group.paneIds.delete(handle.resourceId)) return;
        if (group.paneIds.size > 0) {
          run(["pane", "close", handle.resourceId], handle.socketPath);
          return;
        }
        groupedWorkspaces.delete(key);
        try {
          run(["workspace", "close", handle.workspaceId], handle.socketPath);
        } catch (error) {
          if (!isMissingWorkspace(error)) throw error;
        }
        return;
      }
      if (handle.backend === "herdr" && handle.workspaceId) {
        try {
          run(["workspace", "close", handle.workspaceId], handle.socketPath);
        } catch (error) {
          if (!isMissingWorkspace(error)) throw error;
        }
        return;
      }
      if (!this.exists(handle)) throw new Error("HerdR ownership mismatch");
      run(["pane", "close", handle.resourceId], handle.socketPath);
    },
  };
}
