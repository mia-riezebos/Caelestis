# #265 Ship a portable Docker image and Helm chart

## Summary

Keep Cloudflare supported and add a single-process Node deployment with SQLite or PostgreSQL/CNPG and filesystem or S3 object storage. Preserve existing behavior, durable jobs, and live reconciliation. Package the server and frontend as a versioned image and Helm chart.

## Acceptance criteria

- [ ] Database and object-storage adapters preserve existing contracts.
- [ ] Portable runtime supports every existing backend and frontend feature.
- [ ] Accepted events, jobs, and live revisions recover after restart without duplicate effects.
- [ ] One active application owner is enforced for local and PostgreSQL deployments.
- [ ] Docker and Helm support local disk and existing CNPG/S3 connections, migrations, TLS, health checks, and graceful shutdown.
- [ ] Shared conformance, PostgreSQL, restart, image, and chart checks pass.
- [ ] Release automation, documentation, Changesets, and PR are complete.

## TODOs

- [x] Extract portable relational execution and add SQLite with migrations and shared conformance coverage.
- [x] Add PostgreSQL/CNPG with explicit SQL dialect behavior, migrations, and real PostgreSQL conformance coverage.
- [x] Add filesystem/S3 object adapters and portable social-image storage contracts with conformance coverage.
- [x] Extract Durable Object domain behavior and implement persisted portable coordination, jobs, and ownership with restart tests.
- [x] Assemble the Node HTTP/WebSocket runtime and portable SvelteKit frontend with end-to-end validation.
- [x] Fence PostgreSQL migrations on the ownership connection and reject unsupported coordinator formats.
- [x] Preserve durable counter wakeups when reads overlap newly accepted events.
- [x] Package Docker and Helm, add release/CI checks, and document configuration and upgrades.
- [ ] Run final validation, add Changesets, rebase, and file the PR.

## Notes

- Workspace and branch are supplied by the harness: t3code/cloud-independent-adapters. Initially clean.
- PostgreSQL/CNPG is required in the first release. The application supports one active replica; the CNPG database may have replicas.
- Cluster-specific S3 provider is unknown. Use configurable S3 endpoint, region, bucket, credentials, and path-style addressing.
- No production or daily-driver runtime changes are authorized. Tests use isolated local data and ports.
- Publication is delivered as release automation; publishing a release or merging is outside this implementation turn.
- SQLite extraction validated with backend typecheck and 276 storage/work tests across memory, D1, and SQLite. Reopen, rollback, and migration checksum tests pass.
- Docker Desktop was stopped. Started it for disposable PostgreSQL/S3/image validation; production services remain untouched.
- Mia requested complete cross-provider data export/import for later implementation. Filed #350 in v2; keep export/import implementation outside #265.
- PostgreSQL 17 runs in disposable container caelestis-265-postgres on 127.0.0.1:55465. 352 adapter/work tests passed with the PostgreSQL adapter enabled. Serializable duplicate-event checks pass across four adapters; migration/schema/reconnect tests also pass.
- PostgreSQL uses explicit null/JSON/aggregate SQL expressions, quoted conflict columns, bigint history arithmetic, and serializable batches with bounded serialization retries. Runtime configuration will expose CNPG credentials and TLS.
- Object storage passes 16 conformance tests against filesystem, real Miniflare R2, and disposable MinIO. Frontend social images pass 17 focused tests; frontend and storage typechecks pass. Filesystem envelopes publish bytes and metadata atomically and preserve conditional creation across instances.
- Counter and live coordinators now share their domain implementation across runtimes. Portable state and wakeups use the selected database. SQLite uses a kernel-backed ownership lock; PostgreSQL holds ownership on the same non-reconnecting connection used for application queries.
- Validated 25 counter tests, 37 live coordinator tests, 352 existing adapter/work tests, and new SQLite/PostgreSQL restart, transaction, retry, and ownership checks. One prepared-worker fixture regression was fixed and its 49-test worker/live pass rerun. Backend typecheck passes.
- One Node listener now serves Hono, SvelteKit, and authenticated v1/v2 WebSockets. It starts durable backfill, verification, mirror, garbage-collection, and social-refresh jobs. Social rendering runs in a worker thread; independent actors run concurrently with bounded concurrency.
- End-to-end HTTP/SSR/WebSocket restart tests pass with SQLite and PostgreSQL, including frontend credential secrecy and persisted server identity. Node frontend build, frontend/backend typechecks, 23 frontend server/proxy tests, and 10 social-rendering tests pass. Cloudflare Worker dry-run build also passes.
- Final review moved PostgreSQL migrations onto the owned connection and added an explicit coordinator format guard. Twelve coordinator tests and 38 PostgreSQL/lifecycle/ownership/server tests pass. The broad suite passed 770 backend tests, 153 frontend tests, and 16 storage tests; one PostgreSQL setup hook exceeded 10 seconds under concurrent builds and passed on focused retry with a 30-second hook limit.
- A new race test reproduced an older empty counter read deleting a concurrent event's wakeup. Alarm planning now serializes independently from counter ingestion; all 39 counter/portable coordinator tests pass.
- Docker runs read-only as UID 1000 and passes real HTTP/SSR/WebSocket, social worker, object persistence, ownership, and restart checks with SQLite/filesystem and PostgreSQL/S3. Grype reports no fixable vulnerabilities after removing unused npm/Yarn and upgrading the affected Debian library. Helm default, CNPG/S3, and migration resources pass strict kubeconform validation. Actionlint and 39 release-tooling tests pass.
- Release automation runs only after an approved app release. It publishes both CPU architectures, immutable app-version pairs, digest-pinned OCI charts, migration hashes, and checksums. No artifact publication or deployment was performed in this turn.
