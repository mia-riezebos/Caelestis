# Sync observability baseline

This is the measurement contract for the invocation-reduction work in PRD #150. It separates
required paint and tile writes from avoidable synchronization reads without recording tokens,
usernames, URLs, template identifiers, hashes, or pixel payloads.

## Pre-change baseline

On 2026-08-30, 5–6 active users produced more than 20,000 Worker invocations in 24 hours. The two
steady client loops alone explain that order of magnitude:

| Loop | Per client | Five clients/day | Six clients/day |
| --- | ---: | ---: | ---: |
| Status, every 30 seconds | 2,880/day | 14,400 | 17,280 |
| Manifest, every 60 seconds | 1,440/day | 7,200 | 8,640 |
| Total polling floor | 4,320/day | 21,600 | 25,920 |

This floor excludes page loads, retries, frontend reads, tile offers/uploads, paint reports, admin
traffic, and the six-hour server mirror. It is therefore a conservative model, not a billing total.

## Capture a comparable window

Capture a representative 24-hour window from the backend Worker:

```sh
pnpm --filter @caelestis/backend exec wrangler tail caelestis-backend --format json > sync-baseline.ndjson
```

Stop the command after the window, then summarize it:

```sh
pnpm --filter @caelestis/backend sync:summary -- sync-baseline.ndjson > sync-baseline.json
```

Use the same duration and a recorded active-client count for every comparison. Compare
`invocations`, `requests`, `preflights`, `by_route_client_version`, `by_sync_mode`, `d1.rows_read`,
and `tile_offer`. `requests` excludes CORS preflights so application traffic remains comparable;
`invocations` includes them so the summary still reconciles to Worker usage. In
particular:

- `paint-report`, `tile-upload`, and accepted tile offers are required reporting traffic.
- `compatibility-poll` is the avoidable steady-state fallback targeted by the PRD.
- `response-applied` is a read triggered by a response already carrying useful synchronization
  context; later slices should remove it where that response can carry the state directly.
- `recovery` covers connects, page loads, state changes, and future reconnect/revision recovery.
- `live` is reserved for the revisioned live channel introduced by later slices.

`d1.rows_read_exact` comes from D1 result metadata for `all`, `run`, and `batch` calls.
`d1.rows_read_lower_bound` counts rows returned through `raw` and `first`, whose Worker API results
do not expose D1 metadata. Cloudflare's D1 dashboard remains authoritative for billed rows read.

## Event schema

Every backend request emits one `caelestis.sync.request` structured log with bounded fields for
route, method, status, client/build version, transport, sync mode/reason, cache outcome, duration,
D1 work, and tile-offer outcomes. Dynamic path segments and query strings are normalized to route
names before logging. Invalid client-supplied dimension values collapse to `unknown` or `none`.
The backend only preserves the exact userscript version and frontend commit configured by the
deployment; spoofed or stale build strings collapse to the single `unknown` bucket.
Open-access userscript reads carry these dimensions in reserved query parameters so observability
does not turn CORS-simple GETs into extra preflight invocations. Requests that already require a
preflight use the headers, and those `OPTIONS` calls are classified as `cors-preflight`.
