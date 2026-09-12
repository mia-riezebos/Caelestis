# #355 Use Wplace's user-template store for local templates

## Summary

Synchronize world templates bidirectionally with Wplace's normal personal gallery. Mirror built-in alliance templates only from Wplace into Caelestis. Keep Caelestis HQ, banner, and avatar templates separate; never put them in Wplace's alliance gallery.

## Acceptance criteria

- [x] Native personal templates appear in Caelestis with stable identity.
- [x] Native and Caelestis creation, placement, artwork edits, and deletion stay synchronized.
- [x] Existing local artwork, placement, metadata, and version history survive migration and interruption.
- [x] Server templates retain server ownership and the existing publish/copy workflow.
- [x] Unsupported native data and storage failures preserve existing artwork.
- [x] Placed native alliance templates mirror one-way into Caelestis and retain Wplace ownership.
- [x] Caelestis HQ, banner, and avatar templates keep separate storage and never enter Wplace's alliance gallery.

## TODOs

- [x] Add a native-store adapter based on Wplace's current APIs, with focused contract tests.
- [x] Integrate native ownership, resumable migration, derived local records, and the alliance wrapper with storage tests.
- [x] Validate native interaction and recovery, add release notes, and run project checks.
- [x] Confirm two-way normal-gallery sync and one-way alliance-to-Caelestis mirroring.

## Notes

- Follow-up: mirror personal world-template tag assignments in both directions. Keep names beyond Wplace's normalization/24-character bound, assignments beyond eight, and tags beyond its 64-entry catalog in Caelestis. Mia explicitly chose retaining extras locally.
- Tag reconciliation keeps a durable assignment baseline alongside the local template. Tag assignments and this baseline commit in one transaction; artwork edits preserve it. Native catalog-only cross-tab edits also fence stale writes.
- Native tag deletion removes unused mirrored local labels but preserves HQ/folder assignments. Local rename/delete retires an unused native label only when no other native template uses it, including server-managed rows.
- Tag follow-up validation: 1,362 userscript tests, workspace typechecks, lint, userscript build, and 37 release checks pass. Actual deployed Wplace APIs pass round-trip/reload, native tag lifecycle, eight-assignment and 64-catalog overflow, HQ separation, and unused catalog cleanup. Native colours and unrelated/server-managed templates survive. Evidence is in `/tmp/caelestis-native-tags-qa/observed.json`; the isolated context was disposed.

- The supplied worktree and branch `t3code/issue-355` were clean at task start.
- Live inspection on 2026-09-11 found native metadata in `localStorage['template-overlays']`.
- Native PNG sources live in IndexedDB `wplace-templates`, version 3, store `images`. The same database contains `editor-drafts` and `editor-documents`.
- The native metadata singleton exposes `add`, `update`, `remove`, `getById`, `subscribeChange`, `reorder`, and `commitPendingChanges`.
- Metadata persistence is debounced by 120 ms. Reordering persists but does not emit a change event.
- The native blob API emits save/delete events after transaction completion. Its renderer reloads sources only for saves with origin `remote`.
- Native templates with `serverManaged` are excluded from personal persistence. Preserve this distinction.
- Native imports use original image dimensions plus geographic bounds, palette mode, quantizer, dithering, tags, visibility, and placement state.
- Final scope clarification: two-way sync applies only to the normal personal gallery. Keep built-in alliance templates visible in Caelestis, with no reverse sync or changes to Wplace's alliance gallery. The existing implementation already follows this direction.
- Chromium initially ran without CDP. Mia authorized restarting it with debugging. Native API inspection uses an isolated browser context with no personal templates.
- Downloaded deployed Wplace modules to `/tmp/caelestis-355-native`; verified their exports in the actual Wplace page.
- Adapter validation: 10 focused tests and userscript typecheck pass. Actual Wplace APIs created, renamed, moved, rendered, and deleted a 2x2 fixture in the isolated context; native locks survived metadata edits.
- Integration validation: actual Wplace APIs migrated legacy artwork, applied native moves/renames, accepted Caelestis pixel replacements, and removed derived records after native deletion.
- Real panel rename and visibility edits updated native metadata and survived reload under the same local identity.
- Native alliance fixtures validate exact HQ/draft placement, ownership, independent copies, and discarded responses after canvas changes. The actual tree component renders the wrapper at desktop and phone widths; Copy to Local preserves the Wplace source.
- The isolated browser has no authenticated alliance account. Native alliance response contracts were inspected in deployed code; authenticated server reads remain a manual verification item.
- Wplace does not refresh its metadata singleton across tabs. The adapter refuses stale metadata reads/writes after another tab changes storage; reloading Wplace restores that tab. Native artwork hashes still detect shared image changes.
- Final workspace typechecks, lint, userscript build, and 37 release-workflow checks pass. The parallel workspace test run hit the existing dense social-render test's 5-second timeout; its isolated retry passed in 584 ms. The final userscript run passes all 1,352 tests across 118 files.
- Rebased onto current `origin/main` with no changes needed. Repeated the actual Wplace migration/edit/delete roundtrip after adding the stale-tab guard; every check passed.
- Focused adapter, ownership, alliance wrapper, and tree tests pass (32 tests). Prior full userscript run passed 1,346 tests; its file-watcher timeout passed on an isolated retry.
