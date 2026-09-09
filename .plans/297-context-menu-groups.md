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
- [x] Shorten the backfill and canvas artwork labels, size the menu so rows stay on one line, and add the Changeset.
- [x] Run project checks and verify the built userscript in the existing Chromium over CDP.
- [x] Audit the frontend and userscript UI in the browser and report what most needs work.
- [x] #325 and #328: press-and-hold opens the context menu on touch; hide the row meter and hover actions on hover-less devices in tree mode; fly-to becomes a hover action and the first context menu item for server templates too.
- [x] #329: Appearance uses the tune icon.
- [x] #330: confirm the disabled overlay rail icons already carry their reason as a tooltip and there is no rail button for Use canvas artwork; close with a comment.
- [x] #326: the viewer opens on the whole capture rectangle and the card preview draws the same surrounding area over OSM tiles.
- [x] #327: compact GitHub-style contribution calendar with weekday and month axes and today in the last column.
- [x] Changesets, checks, browser verification, PR body update.

## Notes
- Shared UI validation: 26 tree tests, svelte-check and biome pass. Submenu placement is `position: fixed` beside the trigger so the menu's scroll clip cannot cut it off.
- Final gate: `pnpm check`, `pnpm lint` and `pnpm build` pass. `pnpm test` passes backend (590), ui (137) and all menu suites; the only failures are `display-mode.test.ts` (happy-dom exposes no `localStorage` under Node 26.5), `dev-watch.test.mjs` and the frontend dense-capture social render test (timing under parallel load, passes alone). None of those files differ from main.
- Real browser (background Chromium tab on wplace.live, 1280×800 and 375×700): every admin row is one line at 12.5rem; six separators; ArrowDown walks rows, ArrowRight opens Mark as… with focus on Finished, ArrowLeft returns to the trigger, Escape closes only the submenu first; touch tap opens the submenu and tapping Frozen on the dev-server "Box art" template set `timelapseFrozen` on and then off again; the submenu flips to the left edge at phone width.
- Userscript validation: 20 tree-action tests and tsc pass.
- Audit follow-ups (Mia's decisions, in this PR): touch press-and-hold owns the menu because iOS never fires `contextmenu` for touch; a 450ms hold with 10px slop, the trailing click and `contextmenu` swallowed, touch drags yield to the hold. `(hover: none)` hides the row meter and hover actions in tree mode only. Fly-to moved into the hover actions and leads every template menu. The viewer opens on `timelapseCaptureRect` and the card draws the same rect, so both share the GIF's framing over OSM. The calendar keeps up to 26 weeks, drops the oldest columns to fit, and labels Mon/Wed/Fri plus each month's first column. Verified in Chromium: touch-emulated 375px panel shows full names, hold opens the menu, tap does not, folder tap still expands; frontend cards and viewer centre the art inside its surroundings; the phone calendar fits 21 columns without overflow. #330 needed no change: rail controls already use `aria-disabled` with the reason as `title`.
- UI audit (real userscript on wplace.live and the local frontend, 1280×800 and 375-wide, light and dark), ranked: (1) at phone width the tree truncates every name to three or four characters because the progress meter keeps its desktop width; (2) Appearance sliders shrink to 27px tracks at phone width, below any touch target; (3) two servers both named "Caelestis" are indistinguishable in the tree, Settings and the frontend, so rows need a host hint when names collide; (4) the frontend template viewer leaves the artwork in the left third of a large empty teal map that stays light in dark mode; (5) the frontend contributions calendar spends about 300px on 30px circles for one active day; (6) template rows carry an always-visible magnifier glyph between icon and name, and hovering swaps the progress meter for unlabeled tag and chevron icons; (7) the panel's palette icon for Appearance sits beside Wplace's own palette rail button; (8) the canvas overlay card renders "Use canvas artwork" as a text link and its rail shows greyed move and delete icons with no reason. Nothing in the audit is changed by this branch. The full userscript run also fails `display-mode.test.ts` (no `localStorage` in that environment) and `dev-watch.test.mjs` under parallel load; both pass or are untouched on main's green CI and do not involve menus.
- Group order: navigate (Go to), organise (New folder, Import, Move, Copy, Export), publish (Claim, Publish, Publish folder, Dismiss grief alert), state (Mark as…), artwork (Replace artwork, Use canvas artwork, Backfill), edit (Rename), danger (Delete).
- Submenu items are `menuitemcheckbox` rows. Choosing Finished while finished reopens the template; Frozen while frozen thaws it, so the reopen and thaw verbs go away.
- The Backfill dialog keeps its long heading; the menu row reads "Backfill history".
- The overlay menu keeps "Use canvas artwork" per `packages/ui/src/overlay/DESIGN.md`. Measured in the real panel at 14px: the 11rem menu wrapped "Use canvas artwork" to two lines and the backfill row to three. At 12.5rem every row, including "Use canvas artwork" and "Dismiss grief alert", is one 32px line, so only the backfill label changed and the tree keeps the overlay's wording.
