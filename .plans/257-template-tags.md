# #257 Add reusable tags to local and server templates

## Summary
Add reusable tags with stable identities. Local tags belong to this browser; each server owns its catalog.
Keep template ownership, pixels, placement, and folder paths intact.

## Acceptance criteria
- [x] Local tags and assignments survive reloads and migrations.
- [x] Server tags persist in D1 and sync through v1 manifests.
- [x] Server mutations require template metadata admin authorization.
- [x] One compact editor supports creation, renaming, deletion, attachment, and detachment.
- [x] Search matches tags and retains ancestor folders.
- [x] Rename and deletion update assignments atomically.
- [x] Empty, loading, duplicate, invalid, and offline states permit recovery.
- [x] Focused persistence, authorization, sync, search, and lifecycle tests pass.

## TODOs
- [x] Add server tag persistence, authorized API, and manifest synchronization with focused tests.
- [x] Add transactional local tag persistence and migration tests.
- [x] Add the shared tag editor, ownership labels, and hierarchical tag search with focused tests.
- [x] Verify rendered workflows and repository checks, add release notes, and prepare the PR.

## Notes
- Work in the supplied workspace; the harness renamed its branch to `t3code/resolve-issue-257` during implementation. Initial working tree was clean.
- Server tags are reusable across its templates. Local tags remain browser-owned.
- Use stable IDs and separate assignments so a rename is one record update; deletion cascades assignments only.
- Existing admin authorization and manifest notifications are the integration points.
- Design follows existing compact controls and theme tokens. Show the owning store in the editor.
- Mia approved implementation. Server adapter, route, and schema drift tests pass (14 tests).
- Backend typecheck passes. Full backend run passed 546 tests; three outdated manifest mocks were fixed and all 10 manifest tests then passed. Shared tag tests (2) and wire-schema tests (178) pass.
- Use the existing debug Chromium.app through CDP for browser verification. Mia explicitly excludes Helium.
- Local persistence, migration, and server-cache tests pass (30 tests); userscript typecheck passes.
- Build directly in the real codebase. Browser tabs must open in the background without activating Chromium; retain CDP focus emulation for background rendering.
- Shared editor tests pass (4); tree and manifest tests pass (24). UI check reports zero errors or warnings.
- Full parallel tests encountered three backend timeout failures and cancelled the userscript suite. Rerun with bounded concurrency; do not change unrelated test timeouts.
- Browser verification runs separately from /tmp/caelestis-257-verify.4kvZd5 against production components and isolated storage.
- Final package suites pass: 2,239 tests with `pnpm exec turbo run test --concurrency=1 -- --maxWorkers=2`. Fixture (1), capacity (3), and release (32) tests pass. Full check, build, and lint pass.
- Fixed the tag action icon mapping and updated the alliance action expectations. A failing recovery test proved that Reload tags skipped a failed post-save template refresh; retry now completes that refresh without repeating the mutation.
- The separate verifier passed focused checks but its sandbox blocked CDP. Direct background CDP verification then passed the real userscript tag host, shared editor, IndexedDB persistence, portable backend routes, manifest refresh, and hierarchical search. Inspected desktop and phone screenshots in light and dark themes.
- Browser review uses `http://127.0.0.1:41739` with isolated local data and the real backend's memory adapter. D1 persistence is covered separately by SQLite-backed adapter tests. No production migration or deployment ran.
- Added one minor Changeset for the backend and userscript. File the non-draft PR after committing and rebasing this completed implementation.
