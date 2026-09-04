# App releases

The userscript, frontend, and backend share one Changesets release pull request. Each app keeps its
own version and changelog. Merging the generated pull request publishes the releases.

## Add a release note

Run `pnpm changeset` in a pull request with a user-visible change. Select every deployable app whose
users can see the change:

- `@caelestis/userscript` owns changes visible in the installed userscript.
- `@caelestis/frontend` owns changes visible on the dashboard.
- `@caelestis/backend` owns user-visible API or server behavior changes.

The internal `shared`, `ui`, and `wire-schema` packages stay unversioned. Never select them in a
Changeset. Record their user-visible changes against every affected app instead. For example, a UI
component change bundled into both the userscript and frontend targets both deployable apps.

Choose each app's SemVer bump and write one short sentence for users. One Changeset can target
multiple deployable apps. Pull-request CI rejects a Changeset that mixes an ignored internal
package with a versioned app.

Changes that only affect tests, CI, or internal code do not need a changeset.

## Publish

After a Changeset reaches `main`, the App release workflow opens or updates one release pull
request. That pull request consumes pending Changesets and updates each affected app's package and
changelog independently.

Merging the release pull request publishes the affected app tags:

- `userscript-vX.Y.Z` remains the repository's latest release and includes both installers plus
  their checksums.
- `frontend-vX.Y.Z` uses a non-latest release and posts to `DISCORD_FRONTEND_RELEASE_WEBHOOK_URL`.
- `backend-vX.Y.Z` uses a non-latest release and does not post to Discord.

Semantic app versions describe releases. Production deployments still use the exact deployment
commit from `github.sha` as their operational build identity.

## Repository setting

GitHub Actions must be allowed to create pull requests. Enable this once under repository Settings,
Actions, General, Workflow permissions. Configure `DISCORD_RELEASE_WEBHOOK_URL` for userscript
announcements and `DISCORD_FRONTEND_RELEASE_WEBHOOK_URL` for frontend announcements.
