# Cached live-sync acceptance

Issue #167 is the pre-release acceptance gate for the cached live-sync stack. It is intentionally
repeatable without deploying an unmerged PR stack to production. The 24-hour production comparison
below becomes the rollout gate after parent PR #189 is merged and deployed by an operator.

## Five-client result

Run `pnpm capacity:report` and `pnpm test:capacity` from the repository root.

| Measure | Baseline | Five-client healthy-live projection |
| --- | ---: | ---: |
| Avoidable Worker requests | 12,570 conservative lower bound | 400 |
| Reduction | — | 96.8178% |
| Required tile-offer batches | 2,075 captured lower bound | Measured separately |
| Status and manifest projection RPC reads | — | 250 |
| Authoritative projection rebuilds | — | 50 |
| Cache outcomes | — | 2 miss, 48 stale, 200 hit |
| Raw incoming heartbeat messages | — | 480 |
| Projected billable Durable Object request units | — | 283 |
| Heartbeat wakeups | — | 0 |

The model uses the lower edge of each rounded status and manifest baseline bucket. Tile offers,
paint reports, and requested tile writes are required report traffic: the rollout records them
separately without treating them as avoidable synchronization. D1 rows depend on template and status
cardinality; the request metrics record their actual values rather than substituting a fixed
estimate. Five simultaneous projection readers share one rebuild per resource cohort, so 250 status
and manifest reads require at most 50 authoritative rebuilds in this scenario. Alarm reads remain
direct and are included in the Worker total without being misreported as projection-cache hits.

The avoidable Worker total also includes five alarm reads after each of the four scheduled scans.
Follow-up alarm reads are data-dependent avoidable work and production measurement records them
rather than assuming they are zero.

The Durable Object total follows Cloudflare's current rules: RPCs, WebSocket connections, and
incoming application messages are requests; incoming WebSocket messages are billed in groups of
20, while outgoing messages are not billed. `setWebSocketAutoResponse` answers the application
heartbeat without waking a hibernating object or accruing duration. See Cloudflare's
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/),
[WebSocket hibernation guide](https://developers.cloudflare.com/durable-objects/best-practices/websockets/),
and [state API](https://developers.cloudflare.com/durable-objects/api/state/).

## Recovery and compatibility matrix

| Contract | Executable coverage |
| --- | --- |
| Five-client update within two seconds | `status-read-model-object.test.ts`: fans one committed update to five sockets; `live-client-acceptance.test.ts`: parses and applies it to five independent client states |
| Restart and eviction | `status-read-model-object.test.ts`: persists a reconstructible season projection across object eviction |
| Hibernation and socket attachments | `status-read-model-object.test.ts`: reconstructs hibernating subscriber scope; answers heartbeat pings without waking |
| Revocation publication fence | `status-read-model-object.test.ts`: marks closing sockets revoked before returning and excludes them from later sends |
| Manifest generation recovery | `status-read-model-object.test.ts`: re-adds an evicted projection without reusing a retired generation after cleanup failure |
| Revision gaps and stale reads | `server-sync-coordinator.test.ts`: coalesces malformed, out-of-order, and reconnect recovery; discards an in-flight stale snapshot |
| Projection D1 attribution | `status-read-model-object.test.ts`, `request-metrics.test.ts`, and `do-status-read-model.test.ts`: collect successful and failed work inside the object and merge it into the originating request point |
| Rejected-offer generation fence | `tile-offer-acknowledgements.test.ts` and `telemetry.test.ts`: reject late settlements from superseded coverage and promptly re-offer the observation |
| Offline and visibility recovery | `server-sync-coordinator.test.ts`: pauses while hidden or offline and coalesces recovery events |
| Old-server compatibility | `server-sync-coordinator.test.ts`: keeps compatibility polling and opens no socket when capability is absent |
| Authentication scope | `routes/telemetry.test.ts`: authenticates and scope-binds live upgrades before resolving a season object |
| Alarm delivery without steady polling | `status-read-model-object.test.ts`: broadcasts alarm reconciliation; `server-sync-coordinator.test.ts`: refreshes alarms from the live event |
| Paint invariants | `telemetry.test.ts`: reports identical accepted-paint callbacks separately and retries one immutable event without changing count, order, or attribution |
| Report response convergence | `telemetry.test.ts`: applies offer and upload status deltas without an additional status read |
| Tile-report invariants | `telemetry.test.ts`: reports matching repeated fetch callbacks in separate valid batches and deduplicates only replay of one observation |
| Tile-offer retry compatibility | `telemetry.test.ts`: retries one observation after an ambiguous old-server response and honors explicit upload requests |

Healthy live safety reads carry `recovery`; non-live resources and servers without the live
capability carry `compatibility-poll`. Manifest and status reads both record `hit`, `miss`, or
`stale` cache outcomes. The fixed metrics columns also retain D1 rows, required write routes,
reconciliation reasons, and tile-offer outcomes.

## Paint-reporting equivalence

One accepted-paint callback creates one UUIDv7 event per matching server, including when consecutive
callbacks have identical payloads and timestamps. Every retry sends the byte-identical
body, preserving tile and pixel order, user attribution, event count, and idempotency key. Retry
attempts remain immediate and bounded at three; a terminal failure removes the local dedupe entry so
the existing replay path can try the same logical event again. Tile offers do not gate or reorder the
paint path. Likewise, every covered Wplace tile-fetch callback receives a distinct observation ID
and is offered; batching never combines two observations for the same tile because the backend batch
contract requires unique tile keys. Offer and upload responses continue carrying status deltas so
these required reports replace, rather than trigger, redundant status refreshes.

## Build contract

- `effect` is exactly `4.0.0-beta.102` in the backend and wire-schema packages and resolves to that
  version in the lockfile.
- Backend Worker dry-run bundle: 1647.93 KiB upload, 342.12 KiB gzip.
- Userscript bundle: 572,666 bytes.
- Validation commands: `pnpm lint`, `pnpm check`, `pnpm test`, `pnpm build`,
  `pnpm test:release`, and a backend `wrangler deploy --dry-run`.

## Production rollout gate

Do not deploy this branch by itself. After the parent stack is merged and deployed, keep five
healthy clients connected for one fixed 24-hour UTC window, then:

1. Run all three Analytics Engine queries in [capacity-metrics.md](./capacity-metrics.md), recording
   Worker requests, D1 rows, cache outcomes, transport modes, and tile-offer outcomes.
2. Record Durable Object requests and duration for the same UTC window. Keep the raw incoming
   WebSocket-message count distinct from its 20-to-1 billed request units.
3. Record required `POST /telemetry/tiles/offers`, `POST /telemetry/paints`, and
   `PUT /telemetry/tiles/:x/:y/:hash` traffic separately.
4. Run
   `pnpm capacity:report -- --tile-offer-batches <measured-batches> --extra-alarm-reads <measured-follow-up-reads>`
   and require `reductionPercent >= 90`; the tile-offer argument records required report volume and
   does not reduce that percentage.
5. Exercise restart/eviction, revision-gap, offline/online, hidden/visible, old-server, and revoked
   credential recovery once during the window; confirm each client converges without a manual
   refresh.

No production result is claimed here: the parent PR remains intentionally unmerged to `main`, so
deploying it for this slice would violate the stack boundary.
