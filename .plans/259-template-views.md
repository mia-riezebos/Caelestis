# #259 Add tree and preview-grid template display modes

## Summary
Add a locally persisted grid presentation to the existing userscript template browser.
Reuse its ordered entries, folder expansion, progress, and action intents.

## Acceptance criteria
- [ ] Compact accessible switcher; tree default; local preference restoration.
- [ ] Artwork, name, dimensions, ownership, and existing progress on cards.
- [ ] Folder grouping, search, sorting, focus, visibility, and actions survive switching.
- [ ] Responsive pointer, touch, keyboard, light, and dark presentation.
- [ ] Tests cover switching, restoration, grouping, and action parity.

## TODOs
- [x] Carry preview data and persisted display mode through the existing adapter; test restoration.
- [x] Render responsive artwork cards and switcher using shared row interactions; test action parity.
- [ ] Verify grouping and rendering in both themes and panel widths; add release note and complete checks.

## Notes
- Worktree is clean on t3code/9ca68230. Issue is open.
- No existing .plans convention; retain this execution record with the change.
- Current filters are name search, surface scope, and publication visibility. Use the existing builder unchanged.
- Previews use the same indexed source artwork as overlays. Missing server pixels show an explicit unavailable state until sync supplies them.
- TODO 1 validation: shared/UI builds and all 80 state tests pass.
- TODO 2 validation: UI check has no warnings/errors; 93 UI tests pass; UI build passes. Preview sampling is bounded to 256 pixels per edge and tests preserve transparency.
