# Effect v4 runtime validation

Validated on 2026-08-30 for #158 against the pre-migration `origin/main` commit `2077607`.

## Dependency contract

The only Effect ecosystem dependency is `effect`, exactly pinned to `4.0.0-beta.102` in both `apps/backend/package.json` and `packages/wire-schema/package.json`. The lockfile resolves the same exact version for both importers. No `@effect/*` package is installed.

## Production bundle

Measured with `pnpm --filter @caelestis/backend exec wrangler deploy --dry-run --outdir <temporary-directory>` after building the shared, wire-schema, and backend packages in separate worktrees.

| Build | Upload | Gzip |
| --- | ---: | ---: |
| Pre-migration `2077607` | 1424.11 KiB | 296.59 KiB |
| Effect runtime after #158 | 1560.62 KiB | 323.53 KiB |
| Cached live-sync stack through #206 | 1647.93 KiB | 342.12 KiB |
| Final change from pre-migration | +223.82 KiB (+15.72%) | +45.53 KiB (+15.35%) |

## Request-boundary microbenchmark

The comparison builds each revision, creates the backend with memory adapters, warms each endpoint 100 times, then measures nine runs of 2,000 sequential requests while consuming every response body. Values are the median milliseconds per request. This isolates runtime and route-boundary overhead; it does not model network, D1, or R2 latency.

| Endpoint | Pre-migration `2077607` | Effect runtime after #158 | Change |
| --- | ---: | ---: | ---: |
| `GET /health` | 0.0071 ms | 0.0088 ms | +0.0017 ms |
| `GET /manifest?season=0` | 0.0246 ms | 0.0322 ms | +0.0076 ms |

The measured boundary overhead remains below one hundredth of a millisecond on the SQL-backed manifest path and is negligible beside production network and storage latency.

## Validation matrix

- `pnpm --filter @caelestis/backend test`
- `pnpm check`
- `pnpm test`
- `pnpm --filter @caelestis/backend build`
- `pnpm --filter @caelestis/backend exec wrangler deploy --dry-run --outdir <temporary-directory>`
- `pnpm test:release`
- `git diff --check`
