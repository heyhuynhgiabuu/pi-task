const queuedAdmissions = new Map<string, Promise<void>>();

export async function serializeTaskAdmission<T>(
  key: string | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (!key) return operation();

  const previous = queuedAdmissions.get(key);
  let release: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = (previous ?? Promise.resolve()).catch(() => undefined).then(() => current);
  queuedAdmissions.set(key, queued);

  try {
    await previous;
    return await operation();
  } finally {
    release!();
    if (queuedAdmissions.get(key) === queued) queuedAdmissions.delete(key);
  }
}
