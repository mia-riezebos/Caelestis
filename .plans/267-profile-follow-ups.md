# #267 Complete draft performance validation and profiler follow-ups

## Summary

Finish the post-#268 audit by making performance reports reproducible, validating world and alliance drafts, and recording dispositions for conditional experiments.

## Acceptance criteria

- [x] Reports identify build, environment, camera, template visibility, paint state, and action timestamps.
- [x] Capture, occupancy, notifications, and GPU uploads have attributable counters; sampling and unsupported signals are explicit.
- [ ] Matched Box Art/all-template runs cover browser zoom 100% and 25%, profiler on/off, and native draft actions.
- [ ] Live HQ/picture/banner validation covers draft correctness and recovery; submission races use existing deterministic fixtures.
- [ ] A report records evidence, limitations, and dispositions for each optional experiment.

## TODOs

- [x] Add reproducible profile context, bounded action markers, and explicit signal support with focused tests.
- [x] Add capture, occupancy, notification, and GPU upload attribution with focused tests.
- [~] Record world/alliance validation and experiment dispositions, then run final checks.

## Notes

- Worktree and branch remain `/Users/mia/.t3/worktrees/Caelestis/t3code-725af136`, `t3code/verify-issue-267-status`; clean at start.
- Existing profiler includes draft/server timing, chronological aggregate p95, last-600 frame intervals, last-512 task samples, renderer gauges, and idle GPU-query retirement.
- Debug counters already contain some capture reasons/pixel counts but are lifetime totals outside profile reports.
- Debug Chromium is reachable at 127.0.0.1:9222. Browser verification owns a new task-labelled tab and temporary evidence only.
- No public paint, production configuration changes, or daily-driver reloads are part of validation.
- TODO 1 validated with 12 profile tests, userscript typecheck/build, and focused Biome checks. Reset now excludes the preceding frame interval. Browser zoom stays unknown until explicitly supplied; DPR and pinch scale remain separate.
- TODO 2 validated with 53 focused tests and all 1,154 userscript tests (102 files), typecheck/build, and focused Biome checks. GPU results and observed queue age are fenced across profile resets.
- Independent CLI verification could not connect to CDP because its sandbox returned EPERM. Parent verified PID 64777 is Chromium, owns port 9222, and opened a new task tab through CDP. The existing user tab is unchanged.
