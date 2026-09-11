# #355 Use Wplace's user-template store for local templates

## Summary

Make Wplace own personal template artwork and placement. Derive Caelestis's local rendering records from native templates. Preserve Caelestis metadata and server ownership.

## Acceptance criteria

- [x] Native personal templates appear in Caelestis with stable identity.
- [x] Native and Caelestis creation, placement, artwork edits, and deletion stay synchronized.
- [x] Existing local artwork, placement, metadata, and version history survive migration and interruption.
- [x] Server templates retain server ownership and the existing publish/copy workflow.
- [x] Unsupported native data and storage failures preserve existing artwork.
- [x] Placed native alliance templates remain Wplace-owned; independent Caelestis copies and extra templates use existing local storage.

## TODOs

- [x] Add a native-store adapter based on Wplace's current APIs, with focused contract tests.
- [x] Integrate native ownership, resumable migration, derived local records, and the alliance wrapper with storage tests.
- [~] Validate native interaction and recovery, add release notes, and run project checks.

## Notes

- The supplied worktree and branch `t3code/issue-355` were clean at task start.
- Live inspection on 2026-09-11 found native metadata in `localStorage['template-overlays']`.
- Native PNG sources live in IndexedDB `wplace-templates`, version 3, store `images`. The same database contains `editor-drafts` and `editor-documents`.
- The native metadata singleton exposes `add`, `update`, `remove`, `getById`, `subscribeChange`, `reorder`, and `commitPendingChanges`.
- Metadata persistence is debounced by 120 ms. Reordering persists but does not emit a change event.
- The native blob API emits save/delete events after transaction completion. Its renderer reloads sources only for saves with origin `remote`.
- Native templates with `serverManaged` are excluded from personal persistence. Preserve this distinction.
- Native imports use original image dimensions plus geographic bounds, palette mode, quantizer, dithering, tags, visibility, and placement state.
- Wplace's personal store only represents world-map bounds. Mia requested a wrapper around the alliance template path, preserving Caelestis ownership and avoiding native alliance limits.
- Chromium initially ran without CDP. Mia authorized restarting it with debugging. Native API inspection uses an isolated browser context with no personal templates.
- Downloaded deployed Wplace modules to `/tmp/caelestis-355-native`; verified their exports in the actual Wplace page.
- Adapter validation: 10 focused tests and userscript typecheck pass. Actual Wplace APIs created, renamed, moved, rendered, and deleted a 2x2 fixture in the isolated context; native locks survived metadata edits.
- Integration validation: actual Wplace APIs migrated legacy artwork, applied native moves/renames, accepted Caelestis pixel replacements, and removed derived records after native deletion.
- Real panel rename and visibility edits updated native metadata and survived reload under the same local identity.
- Native alliance fixtures validate exact HQ/draft placement, ownership, independent copies, and discarded responses after canvas changes. The actual tree component renders the wrapper at desktop and phone widths; Copy to Local preserves the Wplace source.
- The isolated browser has no authenticated alliance account. Native alliance response contracts were inspected in deployed code; authenticated server reads remain a manual verification item.
- Focused adapter, ownership, alliance wrapper, and tree tests pass (32 tests). Prior full userscript run passed 1,346 tests; its file-watcher timeout passed on an isolated retry.
