# TODO

- [ ] Fix remaining parent-image/blur bleed through full-screen child overlays. Root cause confirmed upstream: pi-tui 1.0.4 `compositeTuiLine` returns base image lines unchanged and drops the overlay row. Mitigation committed `9a579f0`: scoped `compositeLineAt` override on the TUI instance while the child overlay is open (image rows take the overlay's opaque row; original restored on dispose); RED→GREEN 31/31 overlay-composite tests, full 631/631, typecheck/build/diff-check pass. User must /reload and visually confirm the blur band is gone on Ghostty; if the kitty image layer still shows through, an upstream delete/restore mechanism is the remaining follow-up.
- [x] Restore subagent-configured tools on the durable backend without weakening containment. Committed `a176382`.

- [x] Upgrade Pi dependencies and safely enforce durable/child tool and MCP policies; remove optional-dependency eager loads, cover failure/cancel usage, and complete independent review.
- [x] Apply and verify the theme-resolved child overlay background fix without changing thinking or tool styles; final independent review approved. Work record: [.pi/artifacts/TODO.md#2026-10-06---upgrade-durable-safely](.pi/artifacts/TODO.md#2026-10-06---upgrade-durable-safely).
