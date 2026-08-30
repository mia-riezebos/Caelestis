# Cached live-sync acceptance

Issue #167 is the pre-release acceptance gate for the cached live-sync stack. It is intentionally
repeatable without deploying an unmerged PR stack to production. The 24-hour production comparison
below becomes the rollout gate after parent PR #189 is merged and deployed by an operator.

## Five-client result

Run `pnpm capacity:report` and `pnpm test:capacity` from the repository root.

| Measure | Baseline | Five-client healthy-live projection |
| --- | ---: | ---: |
| Avoidable Worker requests | 14,645 conservative lower bound | 975 |
| Reduction | — | 93.34% |
| Tile-offer batches still available at the 90% gate | — | 489 |
| Status and manifest projection RPC reads | — | 970 |
| Authoritative projection rebuilds | — | 194 |
| Cache outcomes | — | 2 miss, 192 stale, 776 hit |
| Raw incoming heartbeat messages | — | 480 |
| Projected billable Durable Object request units | — | 999 |
| Heartbeat wakeups | — | 0 |

The model uses the lower edge of each rounded status, manifest, and tile-offer baseline bucket.
Required paint reports and requested tile writes are excluded and must be reported separately. D1 rows depend on template
and status cardinality; the request metrics record their actual values rather than substituting a
fixed estimate. Five simultaneous projection readers share one rebuild per resource cohort, so 970
reads require at most 194 authoritative rebuilds in this scenario.

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
| Five-client update within two seconds | `status-read-model-object.test.ts`: fans one committed status update out to five clients within two seconds |
| Restart and eviction | `status-read-model-object.test.ts`: persists a reconstructible season projection across object eviction |
| Hibernation and socket attachments | `status-read-model-object.test.ts`: reconstructs hibernating subscriber scope; answers heartbeat pings without waking |
| Revision gaps and stale reads | `server-sync-coordinator.test.ts`: coalesces malformed, out-of-order, and reconnect recovery; discards an in-flight stale snapshot |
| Offline and visibility recovery | `server-sync-coordinator.test.ts`: pauses while hidden or offline and coalesces recovery events |
| Old-server compatibility | `server-sync-coordinator.test.ts`: keeps compatibility polling and opens no socket when capability is absent |
| Authentication scope | `routes/telemetry.test.ts`: authenticates and scope-binds live upgrades before resolving a season object |
| Paint invariants | `telemetry.test.ts`: retries one immutable paint event without changing count, order, or attribution |
| Tile-offer retry compatibility | `telemetry.test.ts`: retries ambiguous old-server responses and explicit server requests |

Healthy live safety reads carry `recovery`; non-live resources and servers without the live
capability carry `compatibility-poll`. Manifest and status reads both record `hit`, `miss`, or
`stale` cache outcomes. The fixed metrics columns also retain D1 rows, required write routes,
reconciliation reasons, and tile-offer outcomes.

## Paint-reporting equivalence

One accepted paint creates one UUIDv7 event per matching server. Every retry sends the byte-identical
body, preserving tile and pixel order, user attribution, event count, and idempotency key. Retry
attempts remain immediate and bounded at three; a terminal failure removes the local dedupe entry so
the existing replay path can try the same logical event again. Tile offers do not gate or reorder the
paint path.

## Build contract

- `effect` is exactly `4.0.0-beta.102` in the backend and wire-schema packages and resolves to that
  version in the lockfile.
- Backend Worker dry-run bundle: 1644.60 KiB upload, 341.43 KiB gzip.
- Userscript bundle: 568,243 bytes.
- Validation commands: `pnpm lint`, `pnpm check`, `pnpm test`, `pnpm build`,
  `pnpm test:release`, and a backend `wrangler deploy --dry-run`.

## Production rollout gate

Do not deploy this branch by itself. After the parent stack is merged and deployed, keep five
healthy clients connected for one fixed 24-hour UTC window, then:

1. Run all three Analytics Engine queries in [capacity-metrics.md](./capacity-metrics.md), recording
   Worker requests, D1 rows, cache outcomes, transport modes, and tile-offer outcomes.
2. Record Durable Object requests and duration for the same UTC window. Keep the raw incoming
   WebSocket-message count distinct from its 20-to-1 billed request units.
3. Record required `POST /telemetry/paints` and `PUT /telemetry/tiles/:x/:y/:hash` traffic separately.
4. Run `pnpm capacity:report -- --tile-offer-batches <measured-batches>` and require
   `reductionPercent >= 90`.
5. Exercise restart/eviction, revision-gap, offline/online, hidden/visible, old-server, and revoked
   credential recovery once during the window; confirm each client converges without a manual
   refresh.

No production result is claimed here: the parent PR remains intentionally unmerged to `main`, so
deploying it for this slice would violate the stack boundary.
