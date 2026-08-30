# Capacity metrics

Issue #159 establishes the comparison format for the cached live-sync PRD. Backend requests write
one non-blocking point to the `caelestis_request_metrics` Workers Analytics Engine dataset. Static
frontend traffic stays in Cloudflare's built-in `caelestis-frontend` Worker analytics: routing every
asset through application code solely to duplicate that count would create the invocations this PRD
is meant to remove.

## Captured baseline

The original production observation covered 24 hours with five to six active users and exceeded
20,000 total Worker requests. The dashboard-rounded top paths in the supplied capture were:

| Traffic class | Path | Requests |
| --- | --- | ---: |
| Status | `/backend/telemetry/status` | 8.79k |
| Manifest | `/backend/manifest` | 3.79k |
| Tile offer | `/backend/telemetry/tiles/offers` | 2.08k |
| Frontend | `/` | 1.26k |

Source: [24-hour Cloudflare top-path capture](https://i.mia.cx/file/2026/08/e28d618d-c538-455b-ac55-67f4f1d71532).

Future comparisons must record the UTC window, active-client count, backend request totals, frontend
request totals, required paint/tile writes, avoidable reads, D1 rows read, and any incomplete D1
measurement. Keep the five traffic classes above separate even when presenting a combined total.

## Dataset contract

The arrays passed to `writeDataPoint` have a fixed v1 meaning:

| Column | Meaning |
| --- | --- |
| `index1` | Normalized route; the sampling key |
| `blob1` | Schema version (`v1`) |
| `blob2` | Normalized method and route template |
| `blob3` | HTTP method |
| `blob4` | Client (`userscript`, `frontend`, `third-party`, or `unknown`) |
| `blob5` | Bounded client version |
| `blob6` | Sync transport (`none`, `live`, `response-applied`, `recovery`, or `compatibility-poll`) |
| `blob7` | Bounded reconciliation reason |
| `blob8` | Cache outcome |
| `blob9` | Tile-offer batch outcome |
| `blob10` | HTTP status |
| `double1` | Request count (always 1 before sampling) |
| `double2` | Request duration in milliseconds |
| `double3` | D1 rows read |
| `double4` | D1 rows written |
| `double5` | D1 queries whose result exposed metadata |
| `double6` | D1 queries whose API discarded metadata |
| `double7` | Tile offers requested |
| `double8` | Tile offers accepted for upload |
| `double9` | Tile offers already known |
| `double10` | Tile offers rejected as irrelevant |

D1 exposes exact row metadata from `all`, `run`, and every batch result. The binding wrapper
implements ordinary `raw` reads through `run`, preserving the array result Drizzle expects while
retaining the metadata. `first`, `exec`, and the unused `raw({ columnNames: true })` overload do not
expose it; those calls increment `double6` instead of pretending they read zero rows. This makes gaps
visible in every route comparison.

The metrics layer stores no URL query, raw route parameter, authorization value, token digest,
username, user agent, tile coordinate, hash, or pixel payload. Unknown paths collapse to `other`.
Client metadata uses a short vendor media type in the CORS-safelisted `Accept` header so anonymous
cross-origin reads do not gain a preflight.

## Repeatable queries

Use a fixed UTC start and end in place of the relative interval when capturing a release comparison.
Analytics Engine sampling is accounted for with `_sample_interval`.

```sql
SELECT
  blob2 AS route,
  blob4 AS client,
  blob5 AS client_version,
  SUM(_sample_interval * double1) AS requests,
  SUM(_sample_interval * double3) AS d1_rows_read,
  SUM(_sample_interval * double4) AS d1_rows_written,
  SUM(_sample_interval * double6) AS d1_queries_without_row_metadata
FROM caelestis_request_metrics
WHERE timestamp >= NOW() - INTERVAL '24' HOUR
GROUP BY route, client, client_version
ORDER BY requests DESC
```

```sql
SELECT
  blob6 AS sync_transport,
  blob7 AS reconciliation_reason,
  blob8 AS cache_outcome,
  SUM(_sample_interval * double1) AS requests,
  SUM(_sample_interval * double3) AS d1_rows_read
FROM caelestis_request_metrics
WHERE timestamp >= NOW() - INTERVAL '24' HOUR
GROUP BY sync_transport, reconciliation_reason, cache_outcome
ORDER BY requests DESC
```

```sql
SELECT
  blob9 AS batch_outcome,
  SUM(_sample_interval * double1) AS batches,
  SUM(_sample_interval * double7) AS offers_requested,
  SUM(_sample_interval * double8) AS offers_accepted,
  SUM(_sample_interval * double9) AS offers_already_known,
  SUM(_sample_interval * double10) AS offers_rejected
FROM caelestis_request_metrics
WHERE timestamp >= NOW() - INTERVAL '24' HOUR
  AND blob2 = 'POST /telemetry/tiles/offers'
GROUP BY batch_outcome
ORDER BY batches DESC
```

Query the same UTC window in Workers Analytics for `caelestis-frontend` and record its request total
alongside these backend results. Paint reports (`POST /telemetry/paints`) and tile writes
(`PUT /telemetry/tiles/:x/:y/:hash`) must remain separate from avoidable sync reads when calculating
the PRD's 90 percent reduction target.
