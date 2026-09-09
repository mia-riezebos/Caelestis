# #331–334 History charts and timelapse controls

## Summary
Keep timelapse controls stationary, extend rolling pace and ETA periods, add bulk painter selection, and include imported history in pace and contributions.

## Acceptance criteria
- [x] Missing tile coverage never shifts the viewer controls (#331).
- [x] Pace offers 3d, 7d, and 30d; daily and longer windows connect imported and reported data without inventing subdaily archive activity (#332).
- [x] ETA uses a selectable longer period and describes partial coverage (#333).
- [x] Painter lines have bulk show/hide controls (#334).
- [x] Remove the painter metric selector from the legend.
- [x] Contributions include imported progress without attributing it to painters or double-counting live days.

## TODOs
- [x] Keep missing-coverage feedback inside the fixed viewer and validate the layout change.
- [x] Add bounded bulk painter selection, remove the metric selector, and validate selection behavior.
- [x] Unify imported and live rolling pace, add longer windows and imported contribution days, and test coverage boundaries.
- [x] Add persisted ETA periods, validate partial coverage and the frontend, then file the PR.

## Notes
- Worktree started clean on t3code/fix-backfilled-pace-graphs. All four issues are open.
- Imported snapshots measure net correct-pixel change; reported history measures placements. Preserve that distinction in tooltips.
- No production, live database, or daily-driver server changes.
- #331: notice now sits inside the fixed-height viewer. Frontend client/SSR build and diff check pass; browser layout check follows with final validation.
- #334 and legend: 24 focused tests pass, including bulk actions with an active search and request bounds.
- #332 and imported contributions: all 126 frontend tests pass; Svelte check passes. Complete trailing intervals preserve negative progress, missing coverage, and live precedence.
- Final implementation: 127 frontend tests pass; focused painter/ETA/window rerun passes 30 tests. Frontend check/build, repository lint, and 32 release checks pass.
- Browser verification passed with local fixtures on template/folder routes, desktop/phone, both themes, keyboard controls, persistence, and reduced motion. Missing notices cause zero slider movement.
- PR #335 is open. Code review belongs to the bots; babysitting reacts to their findings.
- Runtime QA found and fixed imported contribution days being cut off at creation instead of the first reported bucket.
- First bot reviews raised six threads: singleton pace visibility, painter-only axis visibility, two annual ETA refresh/read findings, heatmap scaling, and daily capture drift. Fixes preserve observed daily averages, assign gains to the newer UTC capture date, and reuse the permanent retained tier for all ETAs.
- Review-fix validation: 131 frontend tests, Svelte check, build, lint, and release checks.
