# TODO

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
