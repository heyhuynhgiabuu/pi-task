# Design Note: Task-Level Retry for the Durable Backend

Status: proposed — needs owner review before implementation
Parent: P0 roadmap item 3 (retry with backoff), which shipped for the terminal backend
Scope: `src/lifecycle/durable-execution.ts`, `src/subagent/durable.ts` (read-only), tests
Author: implementation session, 2025-11-14

> **Revision (upstream scout, 2025-11-14):** an earlier draft proposed fabricating
> per-attempt request ids (`pi-task:<id>/retry-N-...`) to resume the child.
> That was based on the submission-ledger dedupe contract. The public API since
> pi-durable **1.5.0** (#11043, present in our pinned 1.5.1,
> `dist/harness/types.d.ts:59`) is the `SubmissionDraft` union: retry submits
> `{ type: "continue" }` on the existing context, or `{ type: "input", content }
> for a new user message on the same conversation. `requestId` is idempotency
> (dedupe) only — it is not the continuation mechanism.

## Why durable retry is different from terminal retry

The shipped terminal retry relaunches a **fresh child** on a new pane: same prompt,
same agent config, no memory of the failed attempt. That is the only sensible
semantics for a pane, but it wastes the durable backend's superpower:

> pi-durable ≥1.5.0: `submit({ type: "continue" })` starts a run on the context
> as it is, without a user message. The child keeps its context — it saw its own
> previous attempt, the tool results, and how far it got.

A durable retry is a `{ type: "continue" }` submission on the same child
conversation (falling back to `{ type: "input" }` with the original prompt when
the failed run ended `unanswered`/`nothing_to_answer`). For long tasks this is
strictly better than a fresh run, and it is the documented API, not an emergent
dedupe behavior.

## Attempt identity under the documented API

- Attempt 0 keeps today's behavior: the normal input submission.
- Attempt N (N ≥ 1) re-submits on the SAME child conversation:
  `{ type: "continue" }` when the failed run left an owed answer;
  `{ type: "input", content: originalPrompt }` when it ended unanswered.
- A busy conversation rejects `{ type: "continue" }` with `ConversationBusy` —
  treat that as "attempt still in flight", wait, and re-check rather than
  stacking attempts.
- `requestId` on the retry submission is a FRESH idempotency key (one the
  parent has never used), so the harness does not dedupe it against the
  failed submission. It carries no resume meaning.
- `noteAttemptRequestId` already persists the in-flight attempt id into history
  (`historyRequestId`), so a crash mid-retry recovers the retry attempt, not the
  settled original. The existing recovery flow needs no change for this.

## What must be rebuilt per attempt

The current `executeDurableTask` builds these once and captures them in
closures; retry rebuilds them:

1. **Abort controller.** On a timeout the controller has aborted; rerunning
   with it would cancel instantly. Each attempt gets a fresh
   `AbortController`; `tracker.durableAbortController` (user cancel) and the
   foreground abort forwarding (`forwardForegroundAbort`) must be re-bound to
   the new controller. Re-bind in one place (`beginAttempt`).
2. **Timeout timer.** The per-attempt ceiling arms fresh per attempt (each
   attempt gets the full `timeoutMinutes`, not the remaining budget of the
   failed one). `DurableTaskTimeoutError` classification happens per attempt.
3. **Progress wiring.** `progressTranscript` survives across attempts on
   purpose: the transcript view should show attempt 2 continuing after
   attempt 1. `onWatchError`'s `progressFailureShown` flag resets per attempt.

## Upstream issues (scout verdicts, 2025-11-14)

- **Skip the resume-API ask** — `submit({ type: "continue" })` shipped in
  pi-durable 1.5.0 (monorepo `packages/durable`, PR #11043). Verified in our
  pinned 1.5.1 typings.
- **File: per-submission/per-run wall-clock budget.** Today's only knobs are
  `HarnessSettings.stream.timeoutMs` (per-request stream idleness,
  types.d.ts:495) and `maxTurns` (turn count). No issue exists proposing a
  run-level deadline (scout searched open+closed, `label:durable`). Until it
  ships, pi-task keeps arming its own timer + abort — the mechanism this note
  describes.
- **Reframe the attempt-callbacks ask as state, not callbacks:** attempt
  counts already exist as state (`live.generation.attempt`,
  `live.generation.retry{at,error}`, `pi.durable.phase` telemetry attribute
  with `attempt`). Callback-shaped asks (#11932, #9829, #7649) were all
  closed `no-action` upstream — do not file another. The pi-task-side ask
  would be for a documented attempt index where we render retries.

## Upstream posture on task-level retry (second scout pass, 2025-11-14)

- **No one has asked.** Searched open+closed issues (`auto retry`, `resubmit`,
  `task retry`, `afterFailedRun`, `backoff`, …): every hit is in-run or
  CLI turn-level; no RFC at rfc.earendil.com proposes run-level auto-retry.
- **The docs delegate re-running to the host.** The 1.5.0 migration note:
  *"to run the work again, submit it again (a new input, `compact()`, or a
  new task)"* — `afterFailedRun: keep|continue|withdraw` governs only the
  inputs queued behind the failed run. CONTRIBUTING: "pi's core is minimal…
  if your feature does not belong in the core, it should be an extension."
- **Verdict (b): never asked, not rejected — extension territory.** pi-task
  building it is the right layer; no upstream issue to file.
- **Scope refinement:** with pi-task setting `restartLimit: Infinity`
  (`src/subagent/durable.ts:703`) and `settings.retry` wired, provider-class
  deaths never reach pi-task's settle. What actually settles failed on the
  durable backend: wall-clock **timeout**, `faulted` (tool crash), cancel.
  Of the retryable phases, only **timeout** carries real value — this note's
  retry is effectively "the task blew its ceiling; send it a `continue` so it
  picks its work back up."
- **No upstream enabler:** `afterRun` hooks fire on `RunSummary.reason:
  "answer" | "terminate"` only — a failed run records `runFailure` and never
  reaches the hook (verified in pinned 1.5.1 typings, live.d.ts:221,
  types.d.ts RunSummary). pi-task's own settle path (`onFailed` in
  `startSdkBackgroundTask`) remains the wiring point this note describes.

## Classification and non-goals

`planTaskRetry` (src/lifecycle/retry.ts) is reused unchanged. The settle content
for classification is `failureMessage(error)` / the timeout message. Scope:

- **Retryable:** `phase: "timeout"` (wall clock), plus provider/transient
  wording via the existing `classifyModelFailover` + `transientFailureReason`
  regexes.
- **Not retryable (by construction):** user cancels, aborts, harness `faulted`/
  `failed` submission reasons (already excluded by `NON_MODEL_SUBMISSION_REASON_RE`),
  foreground durable runs, comparison siblings.
- **No double-retry:** pi-durable already retries provider errors *inside* a run
  (model failover chain + harness restartLimit). Task-level retry only fires when
  the whole run died — the same boundary the terminal backend uses.

## Bookkeeping

- Retry count persists on the **history entry** (`upsertTaskSessionHistory`
  with `retryCount`, `nextRetryAt`, `lastRetryReason`), not on
  `task-registry.json` — durable tasks are not in the terminal registry, and
  `recordRetryAttempt` would be a no-op that spams the "registry entry is gone"
  warning. A durable-specific recorder is a thin wrapper around the existing
  history upsert.
- Delivery id stays keyed by the ORIGINAL `startedAt` (completion delivery
  idempotency must not treat a retry's completion as a second task). The
  completion notice's `details` gains `retry_count` and `last_retry_reason`
  for the panel.
- `max_retries` comes from agent frontmatter only for now — no per-call param
  (the param surface is paid on every turn; retries are a policy, not a
  per-delegation decision).

## User visibility

One `notifyUser` warning per scheduling decision, matching the terminal
backend's wording:
`background task <id> failed (<reason>); retry <n>/<max> in <s>s.` — so the
TUI shows a retry is happening and the child is resuming, not restarting.

## Test plan

1. **Pure:** classification of durable failure messages through `planTaskRetry`
   (timeout message → `wall_clock_timeout`; harness fault text → no retry).
2. **Wiring (faux provider, existing durableHardTimeout harness):** a
   `runTask` override that fails transiently on attempt 0 and succeeds on
   attempt 1 → done, history carries `retryCount: 1`, notice has
   `retry_count: 1`.
3. **Timeout retry:** attempt 0 hangs past the per-task ceiling → timeout →
   retry attempt 1 with a NEW request id completes → done. Assert the second
   submission's request id differs (capture via `onRequestId`).
4. **No-retry invariants:** cancel during attempt 0 never retries; exhausted
   allowance settles as before.
5. **Recovery interaction:** a crash between retry scheduling and the child
   start recovers the retry attempt id (existing `noteAttemptRequestId`
   guarantee) — covered by the current recovery tests plus one assertion on
   `durableRequestId` shape.

## Estimated effort and risk

- Effort: M (~200–300 LOC including tests). The restructuring is contained in
  `executeDurableTask`; no public API or schema changes.
- Highest-risk detail: the abort-controller swap. Mitigation: re-bind in one
  place (`beginAttempt`), assert the old controller's signal is already
  aborted before swapping, and cover the user-cancel-during-backoff case in
  test 4.
- Rollback: the feature is additive behind `maxRetries` (absent ⇒ zero
  behavior change); revert is a single-file revert plus the two test files.
