# TODO

- [x] Prepare v0.14.2: a `read` of a running agent now says its text is the previous run's message and that the result self-delivers, `list` says the same in one clause, and the README records why `read` stays (cross-session and subagent→main are the only channels `task` cannot reach). Typecheck and 862/862 tests pass locally. Releasing to the registry stays a manual step.

- [x] Prepare v0.14.1: the task widget and `/task` panel no longer redraw endlessly when a tool call's text holds a line break (#34), a durable child now gets its agent body as `instructions`, and the lock-held error names another copy of pi-task in the same process instead of a bogus "another Pi process (pid <own pid>)". Typecheck, build, tests and the tarball content checked locally; the durable-child fix was also seen working live (a canary child quoted its role text). The `/reload` cause of the original incident is inferred, not reproduced. Releasing to the registry stays a manual step.

- [x] Prepare v0.14.0: HerdR rejected-start cleanup and shell-ready wait (#31, #32), durable hard timeout, lost-notice replay, `conversation_id` rejected on durable, `unknown_task_id`, task state line. Typecheck, build, tests (823+) and two independent review passes done locally; `max_turns` on durable, a subagent depth counter and removing `compare` are not done. npm publish remains manual.

- [x] Upgrade to `@earendil-works/*` 1.4.0 and fix the resulting breakage (released in 0.13.0). Adapter gains `getAuth`, which pi-ai ≥1.4 binds eagerly in `withClientIdentity` — without it `Harness.open` throws `Cannot read properties of undefined (reading 'bind')` before any task is admitted (20 of 84 `durableBackend` tests fail without it). Both docs got the now-required `checkpointWhen` (base every 64 deltas); `restartLimit: Infinity` restores pre-1.4 resume behavior; fast mode forwards `telemetry`/`identity`. Verified: typecheck, build, 769/769 tests; durable backend runs against pi-durable 1.3.0 and 1.4.0, old build reproduces the crash on 1.4.0; v1→v2 migration exercised on a copy of the real 5690-task store. Note the migration is one-way.

- [x] Agent messaging, steps 0–2 (uncommitted; see CHANGELOG Unreleased). Durable store lock (`src/subagent/durable-store-lock.ts`), one store per session, in-session messaging (`src/agent-messaging.ts`), cross-session mesh (`src/session-mesh.ts`). Verified by tests and live on two Pi sessions.
- [ ] Deferred from agent messaging: socket-lock fallback for filesystems that cannot host sockets; Windows untested; legacy-row store-gate edge cases; session-id sanitization can collide (the lock refuses); history browsing is scoped to one store; no close-on-idle (a process keeps the stores it opened until exit); a narrow capability-check vs steer race when a run is replaced; `read` of this session's own store can resume its work; the inbox count check is not atomic.

- [x] Fix #30: terminal Pi resumes get a fresh per-request turn budget; preserve lifetime stats and baseline/grace across parent restart. Parent verified 715/715 tests, typecheck/build/smoke and regression RED on pre-fix source; independent review has no blockers. No live model/TUI validation. Work record: [.pi/artifacts/TODO.md](.pi/artifacts/TODO.md).

- [x] Prepare v0.11.8: shorter `task` tool description guidance and dev dependencies on Pi 1.3.0; typecheck, tests, build and tarball verified locally. npm publish remains manual.

- [x] Prepare v0.11.7 for Pi 1.2.0: durable tool results use pi-durable's `output` field, dev dependencies on Pi 1.2.0 and TypeScript 7.0.2; typecheck, tests, build and tarball verified locally. npm publish remains manual.

- [x] Prepare verified v0.11.6 with the `task` delegation skill and shorter tool descriptions; 697 tests/typecheck/build/smoke pass and the clean-staged tarball includes the guide. GitHub publication is tracked in [.pi/artifacts/TODO.md](.pi/artifacts/TODO.md); npm publish remains manual.

- [x] Add the on-demand parent `task` skill (`/skill:task`) and shorten task descriptions without changing the API or validation. Child/CLI `--no-skills` isolation and packaging verified; 697 tests/typecheck/build/smoke pass, independent review has no remaining major findings. Estimated always-visible cost ~945 → ~895 tokens including incremental skill metadata; only-skill header and on-demand body cost are reported separately. Live TUI/model behavior remains unverified.

- [x] Align child TPS with the user's main `tps.ts` definition (whole run including tools, minus UI prompt waits), not the per-response metric in GitHub v0.11.4. Local correction passes 682 tests/typecheck/build/smoke; independent review has no blockers, persisted read-only view records TPS (new children only); user live confirmation on a NEW child pending. No further bump/commit/tag/release before the user sees child TPS. Work record: [.pi/artifacts/TODO.md](.pi/artifacts/TODO.md).

- [x] Add authoritative per-response child TPS and prepare verified v0.11.4 with approved picker fixes, advisor example, and prepack cleanup; 678 tests/typecheck/build/smoke pass and independent TPS review has no blockers. Authorized commit/tag/GitHub publication tracked in the work record; npm publish remains manual. Work record: [.pi/artifacts/TODO.md](.pi/artifacts/TODO.md).

- [x] Fix `/agents` arrow-key routing after another extension replaces pi-task's editor; recheck factory ownership and use modal fallback. Window both inline/modal long lists. RED-first regressions and 677 tests/typecheck/build/smoke pass; independent review completed with no blockers; user confirmed the live behavior works well. Work record: [.pi/artifacts/TODO.md](.pi/artifacts/TODO.md).

- [x] Prepare and verify v0.11.2 with Pi 1.1.0 dev pins, child tool padding, and the unreleased child fixes; 665 tests/typecheck/build/smoke and package-content checks pass. GitHub publishing tracked in [.pi/artifacts/TODO.md](.pi/artifacts/TODO.md).

- [x] Simplify issue #29 fixture cleanup without production changes or weakened assertions; 663 tests/typecheck and both independent audits pass.

- [x] Fix issue #29 by preserving native APPEND_SYSTEM discovery in Pi CLI children; verified on Pi 1.0.4 with 663 tests and independent review. Legacy hook contract covered; full Pi 1.0.0 runtime unverified. Work record: [.pi/artifacts/TODO.md](.pi/artifacts/TODO.md).

- [x] Fix the child overlay blur band. Root cause (worker muwcevcf-d687, byte+pixel+Ghostty-source confirmed): pi's Assistant/UserMessageComponents prefix OSC 133;A semantic-prompt markers to their first line; the overlay's 1-cell left padding lands the marker at column 1, and spec-compliant terminals (OSC 133;A = fresh line: CR+index when x!=0; Ghostty Terminal.zig:2258-2276) abandon the rest of the row at default background — the grey blur band. Fix committed `aeaa4e2`: strip OSC 133 markers from pane lines (theme-independent, covers all pane subviews). Upstream report to pi recommended (those components emit OSC 133;A on their first line, breaking hosts that render them with left padding). Full gates 639/639 pass; awaiting user visual confirmation.
- [x] Drop the synthetic "Took 0.0s" from settled historical tool rows (the remaining visible render artifact in the 12:40 screenshot). Committed `99c473c`: the pane only stamps execution start for live items (`inProgress === true`), so completed tools no longer fabricate a duration; live Elapsed ticker preserved and covered by tests. Full gates 633/633, typecheck/build/diff-check pass. User must /reload to pick this up.
- [x] Restore subagent-configured tools on the durable backend without weakening containment. Committed `a176382`.

- [x] Upgrade Pi dependencies and safely enforce durable/child tool and MCP policies; remove optional-dependency eager loads, cover failure/cancel usage, and complete independent review.
- [x] Apply and verify the theme-resolved child overlay background fix without changing thinking or tool styles; final independent review approved. Work record: [.pi/artifacts/TODO.md#2026-10-06---upgrade-durable-safely](.pi/artifacts/TODO.md#2026-10-06---upgrade-durable-safely).
