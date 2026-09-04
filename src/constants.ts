export const BACKGROUND_CHECK_MS = 10_000; // poll every 10 sec
export const COUNT_POLL_MS = 3_000; // update toolcall counts every 3 sec
export const TASK_TIMEOUT_MS = 30 * 60 * 1_000; // 30 minutes
export const MAX_POLL_ERRORS = 3; // consecutive poll failures before giving up on a task

export const FOREGROUND_PROGRESS_POLL_MS = 1_000;
/**
 * Extra completed assistant turns allowed after the turn limit is reached
 * (issue #19): the wrap-up instruction is steered in, current interactions
 * settle, and the subagent gets this many more turns to deliver its result
 * before the polling loop closes it. Turn counts do not advance while the
 * subagent waits on a human, so a pending permission prompt never burns the
 * grace budget.
 */
export const WRAP_UP_GRACE_TURNS = 10;

/** User-message injected into the subagent when it reaches its turn limit. */
export function turnLimitWrapUpPrompt(limit: number): string {
  return (
    `Your task has reached its ${limit}-turn soft limit. Wrap up now: do not ` +
    "start new work. Deliver your final result in your normal task-result " +
    "format this turn."
  );
}
