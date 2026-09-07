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

- [ ] Admins can create, edit, complete, and reopen work items associated with existing folders and linked templates.
- [ ] Authorized painters can claim unclaimed work and release their own claims; admins can assign and reassign.
- [ ] Concurrent claims have one winner. A losing client sees the authoritative claimant.
- [ ] Users can filter open, claimed, blocked, and completed work by folder, tag, claimant, and linked template.
- [ ] Folder and template views expose linked work without adding controls to the painting rail.
- [ ] Frontend and userscript share authoritative state and converge after reconnecting.
- [ ] State, grouping, claim, and assignment changes have persistent activity history.
- [ ] Template replacement preserves links. Template and folder deletion cannot erase history or leave invalid active links.
- [ ] Focused tests cover authorization, concurrent claims, filtering, reconnects, and deletion/replacement.
- [ ] The rendered interface works at desktop and phone widths in supported themes.

## TODOs

- [x] Add shared work-item contracts and durable storage with atomic mutations and activity history; validate both SQL adapters and migration behavior.
- [x] Add authorized work-item operations and live synchronization; validate claim races, permissions, retry behavior, and reconnect recovery.
- [ ] Add a shared work interface to frontend and userscript folder/template views; validate filtering and the create, claim, release, edit, close, and reopen journeys.
- [ ] Complete rendered checks and release notes, run required checks, then rebase, push the supplied branch, and file the PR.

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
