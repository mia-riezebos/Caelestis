# #297 Group context menu actions and add separators

## Summary
The tree context menu lists every action in one run. Group related actions with hairline separators, keep the grouping order the same for template, folder, and server rows, and keep Delete apart from routine actions. Replace the four lifecycle rows with one "Mark as…" submenu holding Finished and Frozen. Shorten the two labels that wrap so every row stays on one line.

## Acceptance criteria
- [ ] Template, folder, and server menus show the same group order with separators only between non-empty groups.
- [ ] Delete sits in its own trailing group.
- [ ] "Mark as…" opens a submenu with Finished and Frozen, each with an icon and its current state, through hover, keyboard, and touch.
- [ ] Every menu row fits on one line without truncation or an oversized menu.
- [ ] Existing permission checks and arrow-key navigation still hold.

## TODOs
- [x] Extend the shared menu model with item groups, checkable items, and a submenu; render separators and a hover/keyboard/touch submenu in TemplateTree with tests.
- [x] Rebuild the userscript menu entries as ordered groups shared by template, folder, and server rows, with the lifecycle rows replaced by a "Mark as…" submenu carrying Finished and Frozen with checked state; update tests.
- [ ] Shorten the backfill and canvas artwork labels, size the menu so rows stay on one line, and add the Changeset.
- [ ] Run project checks and verify the built userscript in the existing Chromium over CDP.
- [ ] Audit the frontend and userscript UI in the browser and report what most needs work.

## Notes
- Shared UI validation: 26 tree tests, svelte-check and biome pass. Submenu placement is `position: fixed` beside the trigger so the menu's scroll clip cannot cut it off.
- Userscript validation: 20 tree-action tests and tsc pass. The full userscript run also fails `display-mode.test.ts` (no `localStorage` in that environment) and `dev-watch.test.mjs` under parallel load; both pass or are untouched on main's green CI and do not involve menus.
- Group order: navigate (Go to), organise (New folder, Import, Move, Copy, Export), publish (Claim, Publish, Publish folder, Dismiss grief alert), state (Mark as…), artwork (Replace artwork, Use canvas artwork, Backfill), edit (Rename), danger (Delete).
- Submenu items are `menuitemcheckbox` rows. Choosing Finished while finished reopens the template; Frozen while frozen thaws it, so the reopen and thaw verbs go away.
- The Backfill dialog keeps its long heading; the menu row reads "Backfill history".
- The overlay menu keeps "Use canvas artwork" per `packages/ui/src/overlay/DESIGN.md`. Measure the tree row in the browser before deciding whether the tree label also changes.
