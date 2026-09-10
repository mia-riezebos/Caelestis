# #265 Ship portable backend and frontend images, adapters, and Helm chart

## Summary

Keep Cloudflare supported and add separate Node backend and frontend containers with SQLite, PostgreSQL/CNPG, or MariaDB and filesystem or S3 storage. Preserve existing behavior, durable jobs, and live reconciliation. Package both images and the Helm chart together.

## Acceptance criteria

- [x] Database and object-storage adapters preserve existing contracts.
- [x] Portable runtime supports every existing backend and frontend feature.
- [x] Accepted events, jobs, and live revisions recover after restart without duplicate effects.
- [x] One active application owner is enforced for local and PostgreSQL deployments.
- [x] Docker and Helm support local disk and existing CNPG/S3 connections, migrations, TLS, health checks, and graceful shutdown.
- [x] Shared conformance, PostgreSQL, restart, image, and chart checks pass.
- [x] Release automation, documentation, and Changesets are complete.

## TODOs

- [x] Split runtime images and wire frontend HTTP/WebSocket access to the backend; validate authentication and restart behavior.
- [x] Add composable PostgreSQL, S3, and external CNPG examples; update Helm and publication for both images.
- [x] Add MariaDB migrations, configuration, SQL compatibility, ownership, and real database coverage, including Compose and Helm examples.
- [x] Extract portable relational execution and add SQLite with migrations and shared conformance coverage.
- [x] Add PostgreSQL/CNPG with explicit SQL dialect behavior, migrations, and real PostgreSQL conformance coverage.
- [x] Add filesystem/S3 object adapters and portable social-image storage contracts with conformance coverage.
- [x] Extract Durable Object domain behavior and implement persisted portable coordination, jobs, and ownership with restart tests.
- [x] Assemble the Node HTTP/WebSocket runtime and portable SvelteKit frontend with end-to-end validation.
- [x] Fence PostgreSQL migrations on the ownership connection and reject unsupported coordinator formats.
- [x] Preserve durable counter wakeups when reads overlap newly accepted events.
- [x] Package Docker and Helm, add release/CI checks, and document configuration and upgrades.
- [x] Run final validation and add Changesets before rebasing and filing the PR.

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
- Final repository validation passed `pnpm check`, `pnpm test --concurrency=1` (2,694 package tests plus fixture/capacity/social/progress scripts), lint, and 39 release-tooling tests. The last counter fix passed 41 focused Cloudflare/SQLite/PostgreSQL coordinator and Node server tests, backend typecheck, and a Cloudflare dry-run build. The CNPG/S3 chart includes a public HTTPS origin and renders with its existing server Secret intact.
- Follow-up adds root `compose.yaml`, `.env.example`, persistent storage, image/port overrides, and Compose startup coverage in CI. Compose configuration and actionlint pass locally; Docker Desktop is stopped. The prior remote image/chart checks passed, while runtime setup failed on an S3 connection reset. Its bounded readiness retry now includes connection resets.
- Mia selected Docker Hub username `miacx`, then requested separate images. Both `miacx/caelestis-backend` and `miacx/caelestis-frontend` return public 404s. Compose, Helm, and release automation now use those repositories and publish two digest manifests. Helm archives remain in GHCR. Repository creation, credentials, and actual publication remain outside this implementation turn.
- Added MariaDB 11.8 on request, including strict InnoDB schema, binary text comparison, JSON and conditional-write compatibility, serializable batches, connection ownership, TLS, and an interrupted-DDL journal. Shared contracts and coordinator/server tests passed 293 assertions; 71 focused assertions passed after final JSON and Unicode fixes. Bootstrap read credentials cannot equal the admin token or revive a revoked token.
- Separate images pass real HTTP, SSR, authenticated WebSockets, scheduled rendering, object persistence, ownership rejection, and restart checks with SQLite/filesystem, PostgreSQL/S3, and MariaDB/S3. Backend rendering reads the backend directly and does not depend on the frontend process.
- All six Compose combinations (three databases, each with filesystem or S3) started successfully and served the frontend and read API. Frontend containers receive no database/admin credentials. External CNPG Compose configuration validates; local, CNPG/S3, MariaDB/S3, and migration charts pass strict Kubernetes schema validation.
- Workspace typechecks, both Cloudflare builds, workflow validation, 39 release tests, and 10 social-rendering tests pass. Local image scanning could not download its vulnerability database because the host has only 2.4 GiB free; the scanner removed its partial download. CI builds and scans both images. No broad cache cleanup was performed.
- The full backend suite passes 778 tests with MariaDB enabled (two PostgreSQL-only tests skipped in this pass); all 153 frontend tests pass. Dedicated MariaDB migration tests also cover semicolons and comment markers inside SQL literals.
