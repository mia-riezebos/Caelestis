# #331–334 History charts and timelapse controls

## Summary
Keep timelapse controls stationary, extend rolling pace and ETA periods, add bulk painter selection, and include imported history in pace and contributions.

## Acceptance criteria
- [ ] Missing tile coverage never shifts the viewer controls (#331).
- [ ] Pace offers 3d, 7d, and 30d; daily and longer windows connect imported and reported data without inventing subdaily archive activity (#332).
- [ ] ETA uses a selectable longer period and describes partial coverage (#333).
- [ ] Painter lines have bulk show/hide controls (#334).
- [ ] Remove the painter metric selector from the legend.
- [ ] Contributions include imported progress without attributing it to painters or double-counting live days.

## TODOs
- [x] Keep missing-coverage feedback inside the fixed viewer and validate the layout change.
- [ ] Add bounded bulk painter selection, remove the metric selector, and validate selection behavior.
- [ ] Unify imported and live rolling pace, add longer windows and imported contribution days, and test coverage boundaries.
- [ ] Add persisted ETA periods, validate partial coverage and the frontend, then file the PR.

## Notes
- Worktree started clean on t3code/fix-backfilled-pace-graphs. All four issues are open.
- Imported snapshots measure net correct-pixel change; reported history measures placements. Preserve that distinction in tooltips.
- No production, live database, or daily-driver server changes.
- #331: notice now sits inside the fixed-height viewer. Frontend client/SSR build and diff check pass; browser layout check follows with final validation.
