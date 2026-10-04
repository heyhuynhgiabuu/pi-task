/**
 * Return true when a PID is live or its liveness cannot be disproved.
 * Reconciliation must only declare an owner gone on a definite ESRCH.
 */
export function isProcessAliveOrUnknown(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}
