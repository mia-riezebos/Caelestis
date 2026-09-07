# #280 Update template to match current state

## Summary
Composite committed Wplace pixels over the current target and save a new version from either template menu.

## Acceptance criteria
- [ ] Both menus call the same permission-checked action.
- [ ] Opaque art replaces target pixels; transparent art preserves them. Drafts are excluded.
- [ ] Missing art prevents saving; failures leave the previous target active.
- [ ] Identity, bounds and metadata survive; previous image versions remain stored.
- [ ] Image consumers and server alarm comparisons use the new version without paint contributions.

## TODOs
- [x] Add atomic local artwork version persistence and focused storage tests.
- [x] Implement complete committed-art capture and a shared update operation with focused tests.
- [~] Connect both menus, add release notes, validate the UI and run project checks.

## Notes
- Harness renamed the supplied branch to `t3code/address-issue-280` during inspection; retain it in the supplied worktree.
- No existing plan directory; keep this task plan with the implementation.
- UI direction: reuse existing menu buttons and context rows, with one identical action label and pending/error feedback.
- Local metadata-only saves currently reuse stored pixels, so artwork replacement needs an explicit persistence operation.
- Storage validation: 104 tests pass across persist, local-store and server-cache; userscript typecheck passes.
- Capture/action validation: 15 tests pass; userscript typecheck passes. Server alarm baselines already reset on version changes.
