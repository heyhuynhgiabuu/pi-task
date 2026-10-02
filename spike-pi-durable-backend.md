# Spike plan: pi-durable backend for SDK tasks

Status: **M0 + M1 + M2 + M3 done (2026-10-02) — M4 go/no-go pending.** Decision owner: repo owner.
Reference: <https://earendil.com/posts/pi-durable/>, `packages/durable/test/examples/22-subagent-foreground.ts`.

> **M0 result.** `@earendil-works/pi-durable@1.0.0` aligns exactly with pi
> 1.0.0 (pi-ai ^1.0.0, chord ^1.0.0, typebox 1.3.27 — no version fork).
> `spikes/pi-durable/m0-hello-harness.ts` proves SQLite persistence across
> reopen, exactly-once resubmission by `requestId`, and SIGKILL-mid-tool
> resume via `harness.resume()` with a `replay: "safe"` tool. Findings in
> `implementation-notes.md`.
>
> **M1 result.** `spikes/pi-durable/m1-subagent-replay.ts` runs
> `runDurableSubagent()` — find-before-create keyed by the caller's owner key
> (session doc; M2 upgrades to the native `ownerTaskId` index), exactly-once
> `requestId`, SIGKILL-mid-tool rerun completes in the same child with no
> twin. Gotchas: raw `tx.createConversation` copies no agent (children need
> `configure(tx, id, { model })`), drafts must be read inside their commit,
> and settled records carry machine-readable `reason`.

## Why

The SDK backend runs the child in-process through Pi's SDK. When the parent
process dies mid-task, the child dies with it. The terminal/herdr backends
survive parent death, but only inside tmux or HerdR. `@earendil-works/pi-durable`
(experimental) offers conversations that survive process death, exactly-once
submissions, and ownership-tree aborts — the same semantics pi-task currently
emulates with JSON registries, delivery guards, and pid-based recovery.

The pattern half of this work is already shipped: replay-safe fresh starts
(`78227db`) apply pi-durable's find-before-create to the registry-based
backends. This spike evaluates the framework half.

## Hypothesis

A `durable` execution backend (`PI_TASK_BACKEND=durable`) can run an SDK task
as a pi-durable conversation over SQLite such that: the parent is `kill -9`ed
mid-run, the parent restarts, the task continues from its last checkpoint, and
the result is delivered exactly once.

## Questions the spike must answer

1. **Credential bridge (biggest risk).** pi-durable builds its own model
   registry via `createModels()` + providers that read env keys. Pi's stored
   credentials, OAuth logins, and `models.json` providers (the session's
   `modelRegistry`) do not transfer. Scope the spike to API-key providers, or
   build a bridge from pi's runtime auth into pi-durable's `models`?
2. **Harness placement.** One storage owner per database; no cross-process
   locking. Candidate: `<piDir>/durable/agent.sqlite`, owned by the parent pi
   process, reopened on restore. Two concurrent pi sessions in one repo would
   contend — per-session database files, or single-owner with attach clients?
3. **Child tooling.** A durable conversation runs pi-durable tools
   (`CodingTools`: read/write/edit/bash via a `NodeExecutionEnv`), not pi's
   extension suite — no pi skills, no pi-task inside the child. Acceptable for
   headless subagent runs? This changes what an agent's `tools:` frontmatter
   means on this backend.
4. **Lifecycle mapping.** pi-task states (running/wrap-up/timeout/delivery) and
   the existing history rows, widget, and steering map onto durable
   conversation state; abort ownership: foreground → `ownership: {kind:"task"}`,
   background → `{kind:"conversation"}`.
5. **Version pinning.** pi-durable is experimental ("API changes without
   notice"); pin the exact version, isolate all imports behind the existing
   backend-selection seam (`selectBackend`), and keep the default backends
   untouched.

## Milestones

- **M0 (½ day) — hello harness.** Install pinned deps; a script that opens a
  SQLite harness, runs one conversation, reopens after `kill -9`, and resumes.
  Confirms pi-ai/chord version alignment with pi 1.0.0.
- **M1 (1–2 days) — durable subagent prototype.** `runDurableSubagent()`
  outside the extension: find-before-create by owner key, submit with
  `requestId: task:<id>`, wait, return the answer text. Kill -9 mid-run, rerun,
  assert exactly-once.
- **M2 (2–3 days) — integration.** `PI_TASK_BACKEND=durable` behind an explicit
  env flag; receipts, history rows, widget rows, steering (queued follow-up),
  and abort mapped; comparison mode explicitly unsupported at first.
- **M3 — chaos + delivery.** Crash matrix (mid-turn, mid-tool, parent restart
  twice), exactly-once delivery through the existing guard, usage/cost surfaced
  in task details from `docs["pi.usage"]`.
- **M4 — go/no-go.** Promote to a documented backend, or archive the spike and
  keep the pattern-level adoption.

## Non-goals

- Replacing terminal/herdr backends (pane observability remains the default
  where available).
- Multiplayer/remote surfaces, Cloudflare/Bun deployment.
- Making pi-durable a peer dependency of the published package before M4.
