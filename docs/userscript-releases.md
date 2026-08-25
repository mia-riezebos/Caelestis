# Userscript releases

The userscript uses a Changesets release pull request. Merging that pull request is the release
trigger. A normal merge to `main` never publishes a new version by itself.

## Add a release note

Run `pnpm changeset` in a pull request with a user-facing userscript change. Select
`@caelestis/userscript`, choose the SemVer bump, and write one short line for users. Changesets uses
that line in both `apps/userscript/CHANGELOG.md` and the GitHub release notes.

Changes that only affect tests, CI, or internal code do not need a changeset.

## Publish

After a changeset reaches `main`, the Userscript release workflow opens or updates one release pull
request. That pull request consumes pending changesets, bumps `apps/userscript/package.json`, and
updates its changelog.

Merging the release pull request publishes:

- `caelestis.user.js`, the stable automatic-update URL;
- `caelestis-vX.Y.Z.user.js`, the immutable versioned installer;
- `SHA256SUMS`, covering both installers.

The workflow builds and tests before it creates the release. It then downloads the published assets
and checks their hashes against the build from the release commit.

## Repository setting

GitHub Actions must be allowed to create pull requests. Enable this once under repository Settings,
Actions, General, Workflow permissions. The workflow itself requests only `contents: write` and
`pull-requests: write` for the release job.
