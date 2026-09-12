# Dawn paint underreporting, September 11

Investigated September 12, 2026. Source checkout: `eea150bc`; userscript release checked: `userscript-v0.9.0`.

**Confirmed defect:** a valid large paint report can exceed the live server's 65,536-character message limit. The server closes the socket before ingestion. A subsequent smaller report succeeds. This reproduces Dawn's reported pattern, but her original request has not been captured, so the incident attribution remains unconfirmed.

## Production evidence

Read-only D1 queries identify Dawn as `4dragonwings`, Wplace ID `2714778`. For September 11 UTC, all her accepted events belong to Box art, template `01a039fd-d400-77a3-ae3b-26e87596e81b`:

| Accepted at (UTC) | Placed |
| --- | ---: |
| 05:27:18 | 2 |
| 21:38:21 | 601 |
| 21:39:06 | 62 |
| 21:39:10 | 6 |
| 21:39:19 | 1 |
| 21:42:40 | 2 |
| **Total** | **674** |

The persisted event accounting, contribution row, and painter buckets all sum to 674. The frontend's `/api/telemetry/contributions` response agrees. The evening events total 672, matching the value in Mia's screenshot. The screenshot shows an hourly pace, not a separate cumulative pixel count; its timezone is unknown.

There are no additional Dawn event claims with empty accounting in this window, nor a second painter ID matching Dawn/dragon. The same user has 5,513 credited pixels on September 8 and 3,217 on September 9. No contributions appear on September 10 or 12 at inspection time. The missing batch has no persisted claim to replay.

This rules out aggregation or a dashboard-only display problem for the six accepted events. It does not show whether the missing report was never sent, rejected before persistence, or failed during ingestion.

## Reproduction

The client serializes the whole report in `requestLivePaint`, in `apps/userscript/src/server-sync-coordinator.ts`. It has no outgoing paint fragmentation. `StatusReadModelObject.webSocketMessage` rejects text above `MAX_LIVE_CLIENT_MESSAGE_CODE_UNITS`, before schema decoding or recording. Both paths are present in v0.9.0 and the inspected checkout.

A local test uses the real live-message handler, real schema decoding, and the SQLite-backed D1 adapter. It creates a published template and sends fully accepted, unique on-template pixels. Only the Worker shell, blob storage, socket, and counter RPC are faked.

| First report | Serialized characters | First result | Contribution total after another 601 pixels |
| --- | ---: | --- | ---: |
| 6,000 pixels | 66,285 | Close 1009, `live message too large`; no acknowledgement | **601**, expected 6,601 |
| 5,900 pixels | 65,185 | Recorded | **6,501**, as expected |

Both reports pass the wire schema. The first run fails in 688 ms; the smaller control passes in 676 ms. These counts are illustrative: coordinate and colour digit lengths determine the exact cutoff.

The client retries the same event without reducing its size. Pending paint observations live in memory, so reloading cannot reliably recover an unacknowledged batch. This is a transport contract mismatch, not a reason to remove all message bounds. A repair needs bounded large-paint transport while preserving event identity, attribution, and retry semantics.

Permanent regression coverage now lives in [the backend live-paint tests](../../apps/backend/src/live-paint.test.ts). From the repository root:

```sh
pnpm --filter @caelestis/shared build
pnpm --filter @caelestis/wire-schema build
pnpm --filter @caelestis/backend exec vitest run src/live-paint.test.ts
pnpm test:live-paints
```

## Separate ingestion failures

September 11 Analytics Engine metrics estimate **566 HTTP 500 paint responses and five HTTP 200 responses**. Counts include retries and sampling weights; they do not represent unique lost batches. HTTP failures span 01:33:54–23:59:07 UTC. Early requests align with another painter's persisted events, so those failures are not evidence specific to Dawn.

The metrics omit user IDs and individual v2 paint messages. The WebSocket handler catches ingestion errors and sends `error: unavailable` without logging the exception. Historical Workers-log access returned HTTP 403 with the current OAuth credential. Consequently, the HTTP exception cause and Dawn's historical WebSocket close code remain unverified.

Queries used the documented [Analytics Engine SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/) and [Workers telemetry query API](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/). No production paint requests, writes, configuration changes, or deployments were performed.

## Steps to share with Dawn

1. Before the next normal painting session, open Developer Tools → Network and enable Preserve log. Note the exact userscript version and local timezone. Keep the current Wplace tab open if a batch goes missing.
2. For a small test, commit 10–20 new pixels inside Box art. Note the time and check whether the dashboard's contribution total rises. Keep further commits at or below 1,000 pixels as a temporary workaround for the confirmed message-size problem.
3. If a normal larger batch fails to appear, inspect the `telemetry/live` WebSocket's Messages panel. Look for its outgoing `paint-report`, matching `paint-result`, or a disconnect with code `1009` / `live message too large`. Also inspect the Wplace `/paint` response's `painted` count. No outgoing report points to client capture, identity, settings, or coverage; `forbidden` points to report permissions; `unavailable` points to ingestion failure; `partial` means accepted pixels did not match the submitted list.
4. Share the time/timezone, pixel count, and those message/response fields. Omit cookies, authorization headers, and WebSocket protocol credentials. No need to spend thousands of pixels solely to reproduce this.

Mia subsequently confirmed Dawn's missing commit contained roughly 6,000 pixels. This matches the reproduced size failure; the original close frame remains unavailable.

## Repair for issue #368

Servers advertise `livePaintParts: 1`. Small reports retain their existing format. Large reports use individually acknowledged fragments, followed by one final accounting result. The userscript serializes transfers per server. Reconnects restart with the original event ID; server-side accounting remains idempotent.

Each encoded message stays within 64 KiB. Assemblies and reports undergoing accounting share an 8 MiB byte budget, with at most four authenticated socket owners. Incomplete assemblies expire after 30 seconds of inactivity. Complete-event decoding and accounting start only after all parts arrive, and retain their memory reservations until finished. Eviction or disconnect discards incomplete state; the sender can restart. The whole-report bound supports 100k pixels with substantial headroom. Unsupported older servers get no oversized message, and the client logs the terminal compatibility error.

`pnpm test:live-paints` bundles the production Worker and exercises it in Wrangler's local workerd runtime. D1, R2, WebSockets, and the counter Durable Object are real local bindings. All persistence is ephemeral and outbound external requests are blocked. A 100,000-pixel report across two templates, followed by a complete replay, credits exactly 50,000 pixels per template and 100,000 pending counter pixels. In the final instrumented run, both transfers used 108 frames and took 112 ms; sampled Worker heap rose from 8.2 MiB to at most 21.1 MiB. These are local measurements, not production latency or peak-memory guarantees.

The source fix is implemented for #368. Deployment remains separate; the temporary batch-size workaround above applies until the updated client and server are deployed.
