const STALE_EXTENSION_CTX_RE =
  /(?:this extension ctx is stale|captured pi or command ctx|stale after session replacement|stale after session reload|ctx is stale after)/i;

export function isStaleExtensionCtxError(error: unknown): boolean {
  if (typeof error === "string") return STALE_EXTENSION_CTX_RE.test(error);
  if (error instanceof Error) return STALE_EXTENSION_CTX_RE.test(error.message);
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  for (const value of [record.message, record.error, record.reason]) {
    if (typeof value === "string" && STALE_EXTENSION_CTX_RE.test(value)) {
      return true;
    }
  }
  return false;
}

export function ignoreStaleExtensionCtx(fn: () => void): void {
  try {
    fn();
  } catch (error) {
    if (!isStaleExtensionCtxError(error)) throw error;
  }
}
