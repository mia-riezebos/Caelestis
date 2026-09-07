# #257 Add reusable tags to local and server templates

## Summary
Add reusable tags with stable identities. Local tags belong to this browser; each server owns its catalog.
Keep template ownership, pixels, placement, and folder paths intact.

## Acceptance criteria
- [ ] Local tags and assignments survive reloads and migrations.
- [ ] Server tags persist in D1 and sync through v1 manifests.
- [ ] Server mutations require template metadata admin authorization.
- [ ] One compact editor supports creation, renaming, deletion, attachment, and detachment.
- [ ] Search matches tags and retains ancestor folders.
- [ ] Rename and deletion update assignments atomically.
- [ ] Empty, loading, duplicate, invalid, and offline states permit recovery.
- [ ] Focused persistence, authorization, sync, search, and lifecycle tests pass.

## TODOs
- [x] Add server tag persistence, authorized API, and manifest synchronization with focused tests.
- [ ] Add transactional local tag persistence and migration tests.
- [ ] Add the shared tag editor, ownership labels, and hierarchical tag search with focused tests.
- [ ] Verify rendered workflows and repository checks, add release notes, and file the PR.

## Notes
- Work in the supplied branch `t3code/21405b48`; initial working tree is clean.
- Server tags are reusable across its templates. Local tags remain browser-owned.
- Use stable IDs and separate assignments so a rename is one record update; deletion cascades assignments only.
- Existing admin authorization and manifest notifications are the integration points.
- Design follows existing compact controls and theme tokens. Show the owning store in the editor.
- Mia approved implementation. Server adapter, route, and schema drift tests pass (14 tests).
- Backend typecheck passes. Full backend run passed 546 tests; three outdated manifest mocks were fixed and all 10 manifest tests then passed. Shared tag tests (2) and wire-schema tests (178) pass.
- Use the existing debug Chromium.app through CDP for browser verification. Mia explicitly excludes Helium.
