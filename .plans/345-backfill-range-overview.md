# #345 Backfill in the time-range overview

## Acceptance criteria
- [x] The overview includes imported and native progress over the full fetched range.
- [x] Archive-only history appears, and unknown coverage remains a gap.
- [x] Window selection continues to work over imported history.

## TODOs
- [x] Use saved progress in the overview, add focused regression coverage and a frontend Changeset, and validate.

## Notes
- The current overview uses only cumulative reported placements. Reuse the chart's observed progress segments; retain the existing placement outline when no progress observations exist.
- Release PR #342 is a separate change and has merged. This branch starts from its merge commit.
- Validation: 150 frontend tests, Svelte check (0 errors/warnings), frontend build, repository lint, and 32 release checks pass.
- Chromium against the local frontend and production read API: overview spans the April–September archive and native observations; dragging the right grip into June updates the chart without changing the overview. Desktop and phone screenshots inspected in both themes; no runtime exceptions. Evidence in /tmp/caelestis-345-qa/result.json.
- Review follow-up: reproduced both live/final anchor bypass of the placement fallback and invisible singleton archive observations. Select saved observations independently of anchors and draw isolated observations as short ticks. All 153 frontend tests pass after the fix; all three new cases failed before it.
