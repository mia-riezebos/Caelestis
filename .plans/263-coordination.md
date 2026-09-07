# #263 Coordinate work through existing folders and templates

## Summary

Add shared work items to the existing folder and template hierarchy. Mia's final issue comment replaces separate campaigns with existing nodes and excludes deadlines. Claims coordinate painting without restricting paint or repair actions.

## Scope decisions

- Reuse server folders by stable node ID. Folder renames and moves preserve work associations.
- Link work to stable template IDs. Replacing artwork preserves links; deletion removes live links while retaining the activity history.
- Use existing admin scope for planning and assignment, and report scope for claiming.
- Keep title, description, status, priority, labels, blockers, and activity history from the issue.
- Place work directly under folders/templates. Folders and tags provide grouping; add no separate campaign or milestone model and no deadlines. Mia confirmed this scope in the follow-up.
- Claims use self-reported Wplace username and #id for now, as Mia requested. The stable numeric ID determines claim ownership; usernames are display labels. Existing server scopes still gate claiming versus admin planning/assignment. This does not verify personal identity.
- Future authentication is tracked in #285 and blocks federation #264. Account linking is outside this implementation.
- Do not deploy, migrate a remote database, or change the daily-driver userscript.

## Acceptance criteria

- [x] Admins can create, edit, complete, and reopen work items associated with existing folders and linked templates.
- [x] Authorized painters can claim unclaimed work and release their own claims; admins can assign and reassign.
- [x] Concurrent claims have one winner. A losing client sees the authoritative claimant.
- [x] Users can filter open, claimed, blocked, and completed work by folder, tag, claimant, and linked template.
- [x] Folder and template views expose linked work without adding controls to the painting rail.
- [x] Frontend and userscript share authoritative state and converge after reconnecting.
- [x] State, grouping, claim, and assignment changes have persistent activity history.
- [x] Template replacement preserves links. Deleted templates and folders remain identifiable as removed references; deletion cannot erase history.
- [x] Focused tests cover authorization, concurrent claims, filtering, reconnects, and deletion/replacement.
- [x] The rendered interface works at desktop and phone widths in supported themes.

## TODOs

- [x] Add shared work-item contracts and durable storage with atomic mutations and activity history; validate both SQL adapters and migration behavior.
- [x] Add authorized work-item operations and live synchronization; validate claim races, permissions, retry behavior, and reconnect recovery.
- [x] Add a shared work interface to frontend and userscript folder/template views; validate filtering and the create, claim, release, edit, close, and reopen journeys.
- [x] Complete rendered checks and release notes and run required checks.

Each TODO is one buildable commit, with tests included alongside its behavior. Split a TODO before implementation if discovery gives it more than one independent concern.

## Notes

- Issue is open. Read the body and all comments, including Mia's final comment at https://github.com/mia-riezebos/Caelestis/issues/263#issuecomment-5563495263.
- Supplied worktree is `/Users/mia/.t3/worktrees/Caelestis/t3code-f9062f66`; supplied branch is `t3code/f9062f66`. Initial working tree was clean.
- Backend authorization is in `apps/backend/src/auth/middleware.ts`. Callers prove token scope and token hash, not Wplace account ownership.
- `apps/userscript/src/wplace-account.ts` reads Wplace `/me`. Telemetry attribution is client-supplied and is not an authentication mechanism.
- Frontend connections are in `apps/frontend/src/lib/api/client.ts`. The default Worker proxy provides read access; personal mutations need caller credentials.
- Existing frontend destinations are `apps/frontend/src/routes/folder/[id]/+page.svelte` and `apps/frontend/src/routes/template/[id]/+page.svelte`.
- Existing status synchronization has bounded snapshots and recovery. Extend the established transport after defining the coordination contract.
- Existing manifest and database schemas have no template tag model. Work-item tags cover the issue's labels; cross-template tagging is not implicitly part of this change.
- Grouping and claim identity are confirmed. Filed #285 for the future auth stack and added it as a blocking dependency of #264.
- Storage validation: 10 focused tests pass, including concurrent claims on memory and D1 adapters and migration/schema parity. The D1 test harness serializes transactions to match D1 execution.
- API validation: backend typecheck and 41 focused route, storage, manifest recovery, and versioning tests pass. Work changes advance the existing live manifest version without invalidating tile coverage.
- Git reflog shows an external rename from `t3code/f9062f66` to `t3code/harden-access-token-auth`, before the first commit, at the same base SHA. Continue in this supplied worktree on its current branch.
- Build the actual UI directly. Use existing Chromium.app through CDP with background tabs and a persistent focus-emulation session; never activate Chromium or switch the user's tab.
- Shared WorkBoard now powers the frontend Work destination, collapsed folder/template sections, and the userscript's native dialog from tree menus. Drafts survive live updates; claim conflicts refresh the authoritative owner; Activity includes full revision snapshots.
- Work lists paginate in 500-item responses without imposing a lifetime creation limit. Manifest assembly reads only the aggregate work revision. Storage and client tests cover pagination and invalid cursors.
- Browser validation against disposable local D1 confirms create, claim, release, assignment, edit/cancel, completion/reopening, and cross-tab manifest-driven refresh. An initial apparent live failure was a verification selector reading historical snapshots; focused WebSocket evidence confirms synchronization works.
- Fixed the rendered status label's collision with DaisyUI's global `.status` class by naming it `.work-status`.
- Full typechecks pass. Template replacement/deletion tests preserve stable IDs and activity snapshots, and reject new links to deleted templates. Updated existing partial manifest test doubles for the work store contract.
- Final validation: 2,234 package tests pass with `pnpm exec turbo run test --concurrency=1 -- --maxWorkers=2`; fixture/capacity checks pass. `pnpm check`, `pnpm lint`, `pnpm build`, and all 32 release tests pass. The original unconstrained test run timed out in unrelated count/fixture tests under competing pools; bounded rerun passes without test changes.
- Final Chromium verification passes desktop and 390px light/dark layouts, folder/template filters, native dialog focus, Close, Escape, live updates and reload convergence. The actual userscript dialog was bundled with only connection adapters pointing at disposable local data; no Wplace storage or daily-driver installation was changed. Dialog border-box sizing includes padding in its phone-width limit.
- Local verification report and screenshots are under `/tmp/caelestis-263-verify/`. Deliver through the supplied branch after rebasing onto current `origin/main`; do not merge or deploy.

## Manual review

1. Open `http://127.0.0.1:5196/work` in Chromium. The disposable local connection is already configured with an admin token. Choose New work item, enter a title, folder, tags and linked template, then save.
2. Claim and release the item. Assign another Wplace username and numeric ID, then complete and reopen it. Expand Activity to inspect each saved revision.
3. Edit a field and cancel. Try the status, folder, template, painter and tag filters. Open folder/template pages and expand their linked work sections.
4. Open the same item in a second tab. Change it in the first and verify the second updates without Refresh; reload to confirm the same state.
5. Open `http://127.0.0.1:5197` for the real userscript dialog with disposable connection adapters. Try server, folder and template entries, narrow the window, toggle theme in the frontend, and dismiss the dialog with Escape.
