# #280 Update template to match current state

## Summary
Composite committed Wplace pixels over the current target and save a new version from either template menu.

## Acceptance criteria
- [x] Both menus call the same permission-checked action.
- [x] Opaque art replaces target pixels; transparent art preserves them. Drafts are excluded.
- [x] Missing art prevents saving; failures leave the previous target active.
- [x] Identity, bounds and metadata survive; previous image versions remain stored.
- [x] Image consumers and server alarm comparisons use the new version without paint contributions.

## TODOs
- [x] Add atomic local artwork version persistence and focused storage tests.
- [x] Implement complete committed-art capture and a shared update operation with focused tests.
- [x] Connect both menus, add release notes, validate the UI and run project checks.

## Notes
- Harness renamed the supplied branch to `t3code/address-issue-280` during inspection; retain it in the supplied worktree.
- No existing plan directory; keep this task plan with the implementation.
- UI direction: reuse existing menu buttons and context rows, with one identical action label and pending/error feedback.
- Local metadata-only saves currently reuse stored pixels, so artwork replacement needs an explicit persistence operation.
- Storage validation: 104 tests pass across persist, local-store and server-cache; userscript typecheck passes.
- Capture/action validation: 15 tests pass; userscript typecheck passes. Server alarm baselines already reset on version changes.
- Final validation: pnpm check, pnpm test, pnpm lint and pnpm build passed. After browser fixes, userscript tests (1,170), UI tests (89), both package checks, lint and userscript build passed.
- Actual userscript verification used the existing Chromium on CDP 9222. After a foreground-tab correction, all further targets used Target.createTarget with background:true and persistent focus emulation.
- Imported a temporary 4x4 .wplace template over real Wplace art. Both menu actions and Enter activation created durable versions. Five brown committed pixels replaced red; eleven transparent art pixels retained red. Reload preserved current pixels and immutable history.
- Inspected 1280px and 320px layouts in light and dark themes. Fixed context-menu icon shrinking beside the new label.
- Live QA caught geographic imports with everPlaced=false; their existing coordinates are now accepted. Only unplaced plain images and active moves are blocked.
- Deleting a local template also deletes its archived images in the same transaction.
- Server writes and live paint submissions were not exercised; the backend version and alarm tests cover those existing paths.
- Screenshots and browser evidence remain outside the repository at /tmp/caelestis-280-verify.7BN8gg.
