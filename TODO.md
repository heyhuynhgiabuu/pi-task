# TODO

- [x] Fix remaining parent-image/blur bleed through full-screen child overlays. Root cause: pi-tui 1.0.4 `compositeTuiLine` returns base image lines unchanged and drops the overlay row. Mitigation committed `babab19` (was `9a579f0`, amended into `babab19`): scoped `compositeLineAt` override on the TUI instance while the child overlay is open; original restored on dispose. User screenshot 12:40 confirms the blur band above the tool block is gone.
- [x] Drop the synthetic "Took 0.0s" from settled historical tool rows (the remaining visible render artifact in the 12:40 screenshot). Committed `99c473c`: the pane only stamps execution start for live items (`inProgress === true`), so completed tools no longer fabricate a duration; live Elapsed ticker preserved and covered by tests. Full gates 633/633, typecheck/build/diff-check pass. User must /reload to pick this up.
- [x] Restore subagent-configured tools on the durable backend without weakening containment. Committed `a176382`.

- [x] Upgrade Pi dependencies and safely enforce durable/child tool and MCP policies; remove optional-dependency eager loads, cover failure/cancel usage, and complete independent review.
- [x] Apply and verify the theme-resolved child overlay background fix without changing thinking or tool styles; final independent review approved. Work record: [.pi/artifacts/TODO.md#2026-10-06---upgrade-durable-safely](.pi/artifacts/TODO.md#2026-10-06---upgrade-durable-safely).
