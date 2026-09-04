import { execFile } from "node:child_process";
import { chooseTmuxSplitDirection } from "../helpers.js";

export type TerminalBackendKind = "tmux" | "herdr";
export type ExecutionBackendKind = "sdk" | TerminalBackendKind;
export type RequestedBackendKind = "auto" | ExecutionBackendKind;

export type TerminalHandle =
  | {
      backend: "tmux";
      resourceId: string;
    }
  | {
      backend: "herdr";
      resourceId: string;
      socketPath: string;
      terminalId: string;
      /** Captured Pi agent identity for destructive cleanup after restart. */
      agentName?: string;
      foregroundProcessGroupId?: number;
      workspaceId?: string;
      workspaceGroup?: string;
    };

export type HerdrTerminalHandle = Extract<TerminalHandle, { backend: "herdr" }>;

export interface TerminalLaunchInput {
  cwd: string;
  command?: string;
  agentArgs?: readonly string[];
  initialPrompt?: string;
  label?: string;
  direction?: "right" | "down";
  env?: Record<string, string>;
  remainOnExit?: boolean;
  workspaceGroup?: string;
}

export interface CommandRunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  /** Kill timeout for the child process; defaults to CLI_TIMEOUT_MS. */
  timeoutMs?: number;
}

/**
 * Upper bound for backend CLI invocations (tmux/herdr). A wedged CLI call
 * awaited inside the polling tick would otherwise hold the inFlight latch
 * forever and stall every background task's completion and timeout checks.
 */
export const CLI_TIMEOUT_MS = 30_000;

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode?: number;
}

export interface CommandRunner {
  run(
    command: string,
    args: readonly string[],
    options?: CommandRunOptions,
  ): Promise<CommandResult>;
}

export interface TerminalBackend {
  readonly kind: TerminalBackendKind;
  available(): Promise<boolean>;
  launch(input: TerminalLaunchInput): Promise<TerminalHandle>;
  isAlive(handle: TerminalHandle): Promise<boolean>;
  send(handle: TerminalHandle, message: string): Promise<void>;
  readTail(handle: TerminalHandle, lines: number): Promise<string>;
  close(handle: TerminalHandle): Promise<void>;
}

class CommandFailedError extends Error {
  constructor(
    message: string,
    readonly stdout: string,
    readonly stderr: string,
    readonly exitCode?: number,
  ) {
    super(message);
    this.name = "CommandFailedError";
  }
}

/**
 * Human-readable failure reason for a backend launch error, including the
 * CLI's stderr/stdout tail when available. Used by launch failure returns so
 * the underlying cause (e.g. herdr's "no confirmed lifecycle transition")
 * reaches the caller instead of being masked by a generic message.
 */
export function describeCommandFailure(error: unknown): string {
  if (!(error instanceof Error)) {
    return error === undefined || error === null ? "unknown error" : String(error);
  }
  if (error instanceof CommandFailedError) {
    const output = (error.stderr.trim() || error.stdout.trim()).slice(-400);
    if (output) return `${error.message}: ${output}`;
  }
  return error.message;
}

export function createDefaultCommandRunner(): CommandRunner {
  return {
    run(command, args, options = {}) {
      return new Promise<CommandResult>((resolve, reject) => {
        const child = execFile(
          command,
          [...args],
          {
            cwd: options.cwd,
            env: options.env,
            encoding: "utf8",
            maxBuffer: 4 * 1024 * 1024,
            timeout: options.timeoutMs ?? CLI_TIMEOUT_MS,
            killSignal: "SIGKILL",
          },
          (error, stdout, stderr) => {
            if (error) {
              reject(
                new CommandFailedError(
                  `${command} exited unsuccessfully`,
                  stdout,
                  stderr,
                  typeof error.code === "number" ? error.code : undefined,
                ),
              );
              return;
            }
            resolve({ stdout, stderr, exitCode: 0 });
          },
        );

        if (options.input !== undefined) {
          child.stdin?.end(options.input);
        }
      });
    },
  };
}

function lastNonEmptyLine(value: string): string | undefined {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
}

function positiveLineCount(lines: number): number {
  if (!Number.isFinite(lines)) return 1;
  return Math.max(1, Math.floor(lines));
}

export function selectTerminalBackend(input: {
  requested: RequestedBackendKind;
  hasHerdr: boolean;
  hasTmux: boolean;
}): ExecutionBackendKind | null {
  if (input.requested === "sdk") return "sdk";
  if (input.requested === "herdr") return input.hasHerdr ? "herdr" : null;
  if (input.requested === "tmux") return input.hasTmux ? "tmux" : null;
  if (input.hasHerdr) return "herdr";
  if (input.hasTmux) return "tmux";
  return "sdk";
}

export interface TmuxTerminalBackendOptions {
  run?: CommandRunner["run"];
}

export function createTmuxTerminalBackend(
  options: TmuxTerminalBackendOptions = {},
): TerminalBackend {
  const defaultRunner = createDefaultCommandRunner();
  const runner: CommandRunner = {
    run: options.run ?? defaultRunner.run,
  };

  return {
    kind: "tmux",

    async available() {
      try {
        await runner.run("tmux", ["-V"]);
        return true;
      } catch {
        return false;
      }
    },

    async launch(input) {
      if (!input.command) {
        throw new Error("tmux backend requires a launch command");
      }
      const configuredMode =
        input.direction === "right"
          ? "horizontal"
          : input.direction === "down"
            ? "vertical"
            : process.env.PI_TASK_TMUX_SPLIT;
      let paneWidth = 0;
      let paneHeight = 0;
      if (configuredMode !== "horizontal" && configuredMode !== "vertical") {
        try {
          const sizeResult = await runner.run("tmux", [
            "display-message",
            "-p",
            "#{pane_width} #{pane_height}",
          ]);
          const [widthRaw, heightRaw] = sizeResult.stdout.trim().split(/\s+/, 2);
          paneWidth = Number(widthRaw);
          paneHeight = Number(heightRaw);
        } catch {
          // Missing geometry falls back to tmux's stacked split orientation.
        }
      }
      const direction = chooseTmuxSplitDirection(
        paneWidth,
        paneHeight,
        configuredMode,
      );
      const result = await runner.run("tmux", [
        "split-window",
        direction,
        "-d",
        "-P",
        "-F",
        "#{pane_id}",
        "-c",
        input.cwd,
        input.command,
      ]);
      const resourceId = lastNonEmptyLine(result.stdout);
      if (!resourceId) {
        throw new Error("tmux did not return a pane id");
      }

      if (input.remainOnExit) {
        await runner.run("tmux", [
          "set-option",
          "-p",
          "-t",
          resourceId,
          "remain-on-exit",
          "on",
        ]);
      }

      return { backend: "tmux", resourceId };
    },

    async isAlive(handle) {
      if (handle.backend !== "tmux") return false;
      try {
        const result = await runner.run("tmux", [
          "display-message",
          "-p",
          "-t",
          handle.resourceId,
          "#{pane_id}",
        ]);
        return lastNonEmptyLine(result.stdout) === handle.resourceId;
      } catch {
        return false;
      }
    },

    async send(handle, message) {
      if (handle.backend !== "tmux") {
        throw new Error("tmux backend cannot send to a non-tmux handle");
      }
      await runner.run("tmux", [
        "send-keys",
        "-t",
        handle.resourceId,
        message,
        "Enter",
      ]);
    },

    async readTail(handle, lines) {
      if (handle.backend !== "tmux") {
        throw new Error("tmux backend cannot read a non-tmux handle");
      }
      const result = await runner.run("tmux", [
        "capture-pane",
        "-p",
        "-J",
        "-S",
        `-${positiveLineCount(lines)}`,
        "-t",
        handle.resourceId,
      ]);
      return result.stdout;
    },

    async close(handle) {
      if (handle.backend !== "tmux") {
        throw new Error("tmux backend cannot close a non-tmux handle");
      }
      try {
        await runner.run("tmux", ["kill-pane", "-t", handle.resourceId]);
      } catch (error) {
        if (!/not found|no such pane|can't find pane/i.test(String(error))) {
          throw error;
        }
      }
    },
  };
}

export function isTerminalHandle(value: unknown): value is TerminalHandle {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.backend !== "string" || typeof candidate.resourceId !== "string") {
    return false;
  }
  if (candidate.backend === "tmux") return true;
  return (
    candidate.backend === "herdr" &&
    typeof candidate.socketPath === "string" &&
    typeof candidate.terminalId === "string"
  );
}
