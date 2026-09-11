# #355 Use Wplace's user-template store for local templates

## Summary

Make Wplace own personal template artwork and placement. Derive Caelestis's local rendering records from native templates. Preserve Caelestis metadata and server ownership.

## Acceptance criteria

- [ ] Native personal templates appear in Caelestis with stable identity.
- [ ] Native and Caelestis creation, placement, artwork edits, and deletion stay synchronized.
- [ ] Existing local artwork, placement, metadata, and version history survive migration and interruption.
- [ ] Server templates retain server ownership and the existing publish/copy workflow.
- [ ] Unsupported native data and storage failures preserve existing artwork.

## TODOs

- [~] Add a native-store adapter based on Wplace's current APIs, with focused contract tests.
- [ ] Integrate native ownership, resumable migration, and derived local records with storage tests.
- [ ] Validate native interaction and recovery, add release notes, and run project checks.

## Notes

- The supplied worktree and branch `t3code/issue-355` were clean at task start.
- Live inspection on 2026-09-11 found native metadata in `localStorage['template-overlays']`.
- Native PNG sources live in IndexedDB `wplace-templates`, version 3, store `images`. The same database contains `editor-drafts` and `editor-documents`.
- The native metadata singleton exposes `add`, `update`, `remove`, `getById`, `subscribeChange`, `reorder`, and `commitPendingChanges`.
- Metadata persistence is debounced by 120 ms. Reordering persists but does not emit a change event.
- The native blob API emits save/delete events after transaction completion. Its renderer reloads sources only for saves with origin `remote`.
- Native templates with `serverManaged` are excluded from personal persistence. Preserve this distinction.
- Native imports use original image dimensions plus geographic bounds, palette mode, quantizer, dithering, tags, visibility, and placement state.
- Wplace's personal store only represents world-map bounds. Asked Mia whether alliance-local templates should retain Caelestis storage.
- Chromium initially ran without CDP. Mia authorized restarting it with debugging. Native API inspection uses an isolated browser context with no personal templates.
- Downloaded deployed Wplace modules to `/tmp/caelestis-355-native`; verified their exports in the actual Wplace page.
