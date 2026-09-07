# #259 Add tree and preview-grid template display modes

## Summary
Add a locally persisted grid presentation to the existing userscript template browser.
Reuse its ordered entries, folder expansion, progress, and action intents.

## Acceptance criteria
- [x] Compact accessible switcher; tree default; local preference restoration.
- [x] Artwork, name, dimensions, ownership, and existing progress on cards.
- [x] Folder grouping, search, sorting, focus, visibility, and actions survive switching.
- [x] Responsive pointer, touch, keyboard, light, and dark presentation.
- [x] Tests cover switching, restoration, grouping, and action parity.

## TODOs
- [x] Carry preview data and persisted display mode through the existing adapter; test restoration.
- [x] Render responsive artwork cards and switcher using shared row interactions; test action parity.
- [x] Verify grouping and rendering in both themes and panel widths; add release note and complete checks.

## Notes
- Worktree is clean on t3code/9ca68230. Issue is open.
- No existing .plans convention; retain this execution record with the change.
- Current filters are name search, surface scope, and publication visibility. Use the existing builder unchanged.
- Previews use the same indexed source artwork as overlays. Missing server pixels show an explicit unavailable state until sync supplies them.
- TODO 1 validation: shared/UI builds and all 80 state tests pass.
- TODO 2 validation: UI check has no warnings/errors; 93 UI tests pass; UI build passes. Preview sampling is bounded to 256 pixels per edge and tests preserve transparency.
- Real Wplace CDP check found card menus retained trigger focus. Added menu focus, arrow navigation, and a focus-return test. Removed duplicated source names from card folder paths.
- Narrow real panels exposed folder-control overflow; controls now wrap below the folder name under 24rem.
- Older open userscript tabs overwrite the shared catalog settings record. Store display mode under its own userscript-manager/localStorage key. Tests cover both storage paths, failed writes, and catalog replacement without losing the mode.
- Harness renamed the working branch to t3code/address-issue-259 during execution; retain that branch.
- Final tests: 185 shared, 95 UI, and 1,152 userscript tests pass across the full run and focused retries. Three existing files hit timeouts under heavy local load; all 145 tests in those files passed when rerun serially with the normal timeout.
- Builds, userscript/UI typechecks, repository lint, and all 32 release-tooling tests pass.
- Real Chromium CDP verification: grid survives Wplace reload alongside an older tab; 47 template cards share the tree's keys; search finds Box art; progress expands; touch opens the menu; arrow keys move menu focus and Escape restores it. Light/dark at 270px and wide panels have no horizontal overflow. Screenshots are local at /tmp/caelestis-259-verify.
