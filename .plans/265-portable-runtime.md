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
- [~] Add filesystem/S3 object adapters and portable social-image storage contracts with conformance coverage.
- [ ] Extract Durable Object domain behavior and implement persisted portable coordination, jobs, and ownership with restart tests.
- [ ] Assemble the Node HTTP/WebSocket runtime and portable SvelteKit frontend with end-to-end validation.
- [ ] Package Docker and Helm, add release/CI checks, and document configuration and upgrades.
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
