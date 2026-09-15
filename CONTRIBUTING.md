# Contributing to Caelestis

Thank you for helping improve Caelestis. By participating, you agree to follow the
[Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities through the
[security process](SECURITY.md), not a public issue.

## Before you start

Search the issue tracker before opening a report. For a larger change, open an issue first so its
behavior and scope are clear. Keep each issue and pull request focused on one coherent change.

## Local setup

Caelestis requires Node.js 22.13 or newer. Corepack installs the pnpm version pinned in
`package.json`.

```sh
corepack enable
pnpm install
pnpm dev
```

`pnpm dev` starts the backend, frontend, and userscript tasks. Cloudflare credentials are optional
for local development. Use a package filter when you only need one app:

```sh
pnpm --filter @caelestis/frontend dev
```

## Checks

Read [TESTING.md](TESTING.md) when adding or reviewing tests. Each case must protect a meaningful
contract and earn its runtime and maintenance cost.

Run focused tests while you work. Before opening a pull request, run every full check affected by
the change:

```sh
pnpm lint
pnpm check
pnpm test
pnpm build
```

`pnpm test` includes tooling, real local persistence, and package interaction contracts. It needs no
database service or browser. Use a package filter and test filename for focused work.

Run these separate checks when the change affects their boundary:

| Command | Boundary and prerequisites |
| --- | --- |
| `pnpm test:shuffle` | Repeat the default suite with shuffled Vitest cases and files. |
| `pnpm test:coverage` | Package line, branch, and function diagnostics in `test-results/coverage/`; no percentage gate. |
| `pnpm test:browser` | Production worker and canvas behavior in disposable debug Chromium; Chromium must be installed. |
| `pnpm test:runtime` | Real HTTP/WebSocket lifecycle with temporary SQLite in Node and Bun; Bun must be installed. |
| `pnpm test:worker` | Worker host configuration and a migrated local D1 binding. |
| `pnpm test:databases` | Shared PostgreSQL/MariaDB contracts in disposable Docker containers, under Node and Bun. |
| `pnpm test:services` | PostgreSQL, MariaDB, and S3 contracts against explicitly supplied disposable endpoints. |

The service command requires `CAELESTIS_TEST_POSTGRES_URL`, `CAELESTIS_TEST_MARIADB_URL`, and
`CAELESTIS_TEST_S3_ENDPOINT`. Each database invocation owns a temporary schema/database.
S3 uses the test credentials and bucket lifecycle in `packages/storage/src/test/contract.test.ts`.
Use `node scripts/test-services.mjs --bun` to repeat those contracts under Bun.

Deployment and load validation remain separate. See [stack testing](docs/stack-testing.md).
The [suite map](docs/testing/README.md) records the chosen contracts and exclusions.

## Release notes

Run `pnpm changeset` for each atomic, user-visible change. Target every affected deployable app:
userscript, frontend, or backend. Do not target shared, ui, or wire-schema directly. Documentation,
tests, and internal maintenance do not need a Changeset.

## Pull requests

- Link the issue the pull request completes with `Closes #N`.
- Use a conventional title such as `fix(userscript): preserve template placement`.
- Rebase on the latest `main` and keep unrelated changes out of the branch.
- Describe the problem, the outcome, and the checks you ran.
- Include before and after evidence for visual changes.
- Allow maintainer edits on pull requests from forks.
