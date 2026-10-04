# Implementation Notes

## HerdR backend — 2026-07-13

### Deviations

- The first implementation agents timed out after establishing the terminal-backend RED tests. The implementation was completed and verified directly from that partial state.
- HerdR uses CLI wrappers rather than a raw socket client. This follows HerdR's recommendation for orchestration and keeps the initial integration small.
- Initial live smoke was blocked outside HerdR. After restarting Pi inside HerdR 0.7.3, end-to-end launch, durable resume/steering, completion, and orphan-pane cleanup were verified. The smoke exposed runtime timing and CLI-output issues that unit tests did not reproduce.
- Temporary HerdR transport failures remain recoverable instead of being classified as dead panes. Durable records are preserved until the same socket and terminal identity can be validated again.

### Discoveries

- HerdR pane IDs are session-local. Safe control requires the persisted absolute socket path and terminal identity before reading, steering, or closing a pane.
- HerdR's shell can outlive the delegated Pi process. An atomic task-owned exit sentinel distinguishes child exit from shell liveness; a valid Pi JSONL terminal result always takes precedence.
- HerdR `done` and `idle` depend on attention/focus. They are not used as task-result authority.
- Durable resume must deliver the new prompt after reattaching to an already-running task; reattachment alone is not a completed resume operation. HerdR needed a 300 ms gap between `pane run` and a confirming Enter so Pi queues the prompt during an active turn.
- Long wrapper commands must start through `herdr agent start -- sh -lc ...`; sending them into a fresh shell with `pane run` allowed immediate steering to corrupt the still-buffered command.
- HerdR mutation commands can succeed with empty stdout. Only JSON-producing inspection commands should be decoded.
- An autonomous child-side JSONL watcher was removed after live testing showed it could close the HerdR pane before the parent task runner consumed completion, leaving an orphaned in-memory widget entry. Normal cleanup is parent-owned: the wrapper records child exit, while pi-task polling records completion and then closes the pane. Restart restoration handles parent termination.
- The existing code treats all five terminal stop reasons (`stop`, `endTurn`, `length`, `error`, `aborted`) as completed. This integration preserves that behavior.

## pi-durable spike M0 — 2026-10-02

### Scope

M0 of `spike-pi-durable-backend.md`: open a SQLite harness with the faux
provider (no network), prove persistence across reopen, exactly-once
resubmission, and crash-mid-tool resume. Script:
`spikes/pi-durable/m0-hello-harness.ts` (`npx tsx ...`).

### Results (M0 PASS)

- Version alignment holds: `@earendil-works/pi-durable@1.0.0` depends on
  `@earendil-works/pi-ai ^1.0.0`, `@earendil-works/chord ^1.0.0`, and
  `typebox 1.3.27` — exactly the versions pi 1.0.0 and pi-task already pin.
  One copy of pi-ai in the tree, no version fork needed.
- Durability: transcript entries survive harness close/reopen on SQLite.
- Exactly-once: resubmitting the same `requestId` after reopen returns the
  original settled submission verbatim and appends nothing.
- Crash resume: a child process SIGKILLed mid-tool-call leaves the
  submission interrupted; a new process opens the same storage, calls
  `harness.resume()`, the `replay: "safe"` tool reruns, and the submission
  completes with the new process's answer.

### Discoveries

- `Submission.wait()` resolves before the harness closes; reading entry
  content must happen before `harness.close()` — after close, even reads via
  `conversation.commit()` throw "Session is closed".
- The resumed run consumes the *new* process's model responses: the interrupted
  generation is re-issued, not replayed from storage. For M1 this means the
  durable backend's child keeps its own model registry (the credential-bridge
  question in the spike plan is real, not theoretical).
- `replay: "safe"` is load-bearing for resume: without it the interrupted tool
  would be reported to the model instead of rerun — M1 should mark pi-task's
  delegation tool replay-safe only insofar as find-before-create makes it so
  (the pattern `78227db` already implements for the registry backends).

## pi-durable spike M1 — 2026-10-02

### Scope

`runDurableSubagent()` in `spikes/pi-durable/m1-subagent-replay.ts`: the
subagent pattern of example 22 adapted to a caller outside any durable
conversation. Script proves rerun-after-done reuse and SIGKILL-mid-tool
recovery with no twin child.

### Results (M1 PASS)

- Find-before-create via a session-scoped document
  (`defineDoc({ scope: "session" })`): rerun of the same owner key reuses the
  child conversation and the same answer; exactly one child in storage.
- Exactly-once by `requestId: subagent:<ownerKey>`: after a SIGKILL mid-tool,
  the rerun reacquires the interrupted submission, the `replay: "safe"` tool
  reruns, and the submission completes with the new process's answer.

### Discoveries

- Raw `tx.createConversation({ ownership })` accepts only ownership — no
  `agent`. An ownerless child resolves with NO model (`unanswered`,
  `reason: "no_model"`); the fix is `configure(tx, id, { model })` in the same
  commit (what M2 gets for free: a task-owned child copies its owner's agent).
- `ConversationOwnership` is only `ownerless | task` at creation — M2's
  native find-before-create should key the mapping off `ownerTaskId` inside a
  durable tool call instead of the session document used here.
- Reading a document draft outside its commit throws "Cannot use a settled
  overlay": extract plain data inside the transaction callback.
- `settled` records carry a machine-readable `reason` (e.g. `no_model`) —
  surface it, not just `status`, in M2 receipts.

## pi-durable spike M2 — 2026-10-02

### Scope

`PI_TASK_BACKEND=durable` wired into the extension (M2 of
`spike-pi-durable-backend.md`): backend selection, `executeDurableTask`
(foreground + background), panel steering and stop, `/task cancel` via the
control API, and resume-on-session_start for submissions a previous process
left running. Controller: `src/subagent/durable.ts`; executor:
`src/lifecycle/durable-execution.ts`. Receipts, history rows, widget rows, and
delivery reuse the SDK machinery.

### Discoveries

- pi-durable must stay a dynamic import: static imports would load it in every
  session. Availability is probed once via `import()` and cached.
- `ConversationId` is a branded number per storage; two databases can hand out
  the same numeric id, so ids crossing the backend boundary are stringified
  and mappings keep the native type.
- createModels() lives in `@earendil-works/pi-ai/models`, not the durable root;
  the durable backend uses env-key providers, so OAuth-backed models are
  gated out until the credential bridge exists (documented in README).
- A document draft is a transaction overlay: only plain data extracted inside
  the commit survives (shallow spreads keep tracked nested objects that throw
  "Cannot use a settled overlay" after settle).
- `handleTaskControl` became async (durable cancel awaits the conversation
  abort); tests that called it synchronously were updated.
- Known M2 gaps, deliberately deferred to M3: no SIGKILL chaos matrix against
  the integrated backend, no usage/cost surfacing, steer/abort during the
  window before the mapping doc commit is untested, and completion receipt
  usage totals are zero for durable children.

## pi-durable spike M3 — 2026-10-02

### Scope

Crash matrix through the integrated delivery path
(`test/durableBackend.test.ts`, "SIGKILL mid-tool" case): a child process
starts a durable task whose faux model calls the real `bash` tool with a long
sleep; the parent SIGKILLs it mid-tool; `resumeDurableAfterRestart` (the same
function `session_start` runs) finishes the submission and delivers.

### Results (M3 PASS)

- Exactly one `task-complete` delivery with `resumed: true`, the recovered
  answer, and the durable backend/task id in `details`.
- A second resume pass delivers nothing: settled submissions leave
  `harness.inspect()`, so chaos retries cannot duplicate delivery.

### Discoveries

- `resumeDurableAfterRestart` registers hooks and returns before the resumed
  generations settle — delivery lands on later event-loop turns. Callers that
  assert or report on it must poll or subscribe; production session_start
  wants exactly this fire-and-forget shape.
- Interrupted `bash` is not replay-safe, so the resuming process re-prompts
  the model instead of rerunning the sleep — no stall, and the recovery answer
  comes from the resuming process's own model registry.
- Test seam additions: `runDurableTask` gained `onSubmitted` (durably-admitted
  marker for crash tests) and `resumeDurableAfterRestart` gained
  `databasePath`/`models` passthroughs for faux injection.

## pi-durable spike M4 — 2026-10-02

### Decision

**Promoted.** The durable backend ships as an experimental, explicit-only
backend; the user is dogfooding it (`PI_TASK_BACKEND=durable`). Archiving is
off the table; the spike doc records the decision and the tracked gaps.

### Shipped in M4

- Usage surfacing: `runDurableTask` reads the child conversation's `pi.usage`
  ledger (`UsageDoc`) inside one commit and returns plain totals per
  provider/model and per tool plus whole-child totals; foreground results,
  background task-complete receipts, and resumed deliveries all carry
  `usage` in `details`. `resumeDurableTasks` hooks now pass the ledger too.
- Tests assert the ledger shape (faux models report nothing, so totals are
  zeros — the assertion pins the plumbing, not provider data).

### M4 follow-up — Pi runtime model/auth bridge (2026-10-02)

- Durable runs now use the current `ExtensionContext.modelRegistry` for model
  lookup and request-time `streamSimple`, including OAuth-backed Pi providers.
  The selected session model is the fallback when agent frontmatter has no
  `model`; resume receives the new session's registry. Credentials remain in
  Pi's auth runtime and are not copied to the durable database.
- RED/GREEN integration tests use a faux provider: before the bridge the
  durable child settles with `no_model`; after it, both fresh and resumed
  submissions resolve through the supplied runtime registry.
- `ExtensionContext.modelRegistry` exposes no deferred fetch/cancel methods;
  the durable bridge rejects deferred provider responses explicitly.

### Remaining gaps (tracked in the spike doc)

- Usage is not read on failure paths (failed runs report no ledger).
- Steer/abort racing the mapping-doc commit window remains untested.
