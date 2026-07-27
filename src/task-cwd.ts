import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

export type TaskCwdResolution =
  | { kind: "resolved"; cwd: string }
  | { kind: "invalid"; message: string };

export function resolveTaskCwd(
  callerCwd: string,
  requestedCwd: unknown,
  persistedCwd?: string,
): TaskCwdResolution {
  const candidate = requestedCwd === undefined ? persistedCwd : requestedCwd;
  if (candidate === undefined) return { kind: "resolved", cwd: callerCwd };
  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    candidate.length > 4096 ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(candidate) ||
    !isAbsolute(candidate)
  ) {
    return {
      kind: "invalid",
      message: "Task cwd must be an absolute path to an existing directory.",
    };
  }

  try {
    if (!statSync(candidate).isDirectory()) {
      return {
        kind: "invalid",
        message: "Task cwd must be an absolute path to an existing directory.",
      };
    }
    return { kind: "resolved", cwd: candidate };
  } catch {
    return {
      kind: "invalid",
      message: "Task cwd must be an absolute path to an existing directory.",
    };
  }
}
