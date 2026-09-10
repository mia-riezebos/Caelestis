# Self-hosting Caelestis

One Node process serves the backend, SvelteKit frontend, and WebSockets. It supports these independent adapter choices:

| Data | Cloudflare | Self-hosted |
| --- | --- | --- |
| Relational records | D1 | SQLite or PostgreSQL, including CNPG |
| Blobs and social images | R2 | Filesystem or S3-compatible storage |
| Live state, counters, and jobs | Durable Objects | Persistent coordinator tables in the selected database |

Use exactly one active application replica. PostgreSQL itself may have replicas and failover through CNPG.
The application connects to the writable primary and holds an ownership lock on its database connection.
Losing that connection stops the server. Kubernetes can then restart it against the new primary.
Use a direct connection or session pooling. Transaction-pooling proxies cannot retain this ownership lock.

SQLite holds a kernel-managed lock in a sibling `.owner` file. Process exit releases the lock, including a crash.
Use a local filesystem or block-backed persistent volume with working POSIX locks. Network filesystems are unsupported for SQLite.
The chart rejects multiple replicas and uses `Recreate` updates. Horizontal application scaling requires a future coordination adapter.

## Run with Docker

Build from a checkout with Docker:

```sh
docker build --build-arg CAELESTIS_BUILD_ID="$(git rev-parse HEAD)" -t caelestis:local .
docker volume create caelestis-data
docker run -d --name caelestis --restart unless-stopped \
  --read-only --tmpfs /tmp \
  -p 127.0.0.1:3000:3000 -v caelestis-data:/data \
  --env-file .env caelestis:local
```

Create `.env` with a private `ADMIN_TOKEN`, `SERVER_NAME`, and the current `SEASON`.
Generate the admin token with `openssl rand -hex 32`. Keep the file private and outside Git.
Open `http://localhost:3000` for the frontend. Configure userscripts with `http://localhost:3000/backend`.
The frontend uses a persisted, automatically generated read-only token. That token stays on the server.
Admin API calls use `Authorization: Bearer <ADMIN_TOKEN>`. Existing token-management APIs still apply.

The default stores SQLite, coordinator state, and object files in `/data`.
The image runs as UID/GID 1000. Bind-mounted directories must be writable by that user.
Put an HTTPS reverse proxy in front for remote access. Forward WebSocket upgrades and allow long-lived connections.
Set `ORIGIN` to the public HTTPS origin so SvelteKit generates the correct public URLs.
Health endpoints are `/health/live` and `/health/ready`. Prometheus metrics are at `/metrics`.
Readiness checks database access. Request logs use JSON and omit authorization values and query strings.
SIGTERM stops admission, closes WebSockets, and drains active work. The process allows 30 seconds before forced exit.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST`, `PORT` | `0.0.0.0`, `3000` | Shared HTTP listener |
| `ORIGIN` | request origin | Public frontend origin, for example `https://caelestis.example.com` |
| `DATA_DIRECTORY` | `/data` in the image; `./data` from source | Persistent local directory |
| `DB_ADAPTER` | `sqlite` | `sqlite` or `postgres` |
| `SQLITE_FILE` | `$DATA_DIRECTORY/caelestis.sqlite` | Database file; keep its WAL and owner files beside it |
| `DATABASE_URL` | unset | PostgreSQL URL without SSL query parameters |
| `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` | Driver defaults | Alternative PostgreSQL connection fields |
| `PG_TLS_MODE` | `verify-full` | `verify-full`, `require` (encryption without certificate verification), or `disable` |
| `PG_TLS_CA_FILE` | system roots | CA certificate bundle for PostgreSQL |
| `PG_TLS_CERT_FILE`, `PG_TLS_KEY_FILE` | unset | Optional PostgreSQL client certificate and key |
| `OBJECT_STORAGE` | `filesystem` | `filesystem` or `s3` |
| `OBJECT_DIRECTORY` | `$DATA_DIRECTORY/objects` | Filesystem object root |
| `S3_BUCKET` | required for S3 | Existing application bucket |
| `S3_ENDPOINT` | AWS endpoint | Generic S3 endpoint, including scheme |
| `S3_REGION` | `AWS_REGION` or `us-east-1` | Signing region |
| `S3_FORCE_PATH_STYLE` | `false` | Enable path addressing for providers that require it |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` | standard AWS credential chain | S3 credentials; workload credentials also work |
| `SERVER_ID` | generated and persisted | Optional stable server identity override |
| `SERVER_NAME`, `SERVER_DESCRIPTION` | `Caelestis`, unset | Public server details |
| `SEASON` | `0` | Current canvas season |
| `ADMIN_TOKEN` | unset | Bootstrap administrator credential |
| `OPEN_ACCESS` | `false` | Existing open-access mode; booleans must be `true` or `false` |
| `CAELESTIS_READ_TOKEN` | generated and persisted | Optional existing active read-only token for the frontend |
| `BASE_PATH` | `/backend` | Backend mount; `/backend` remains a compatibility alias |
| `TILE_BLOB_GC_MODE` | `dry-run` | Set `delete` to enable deletion of unreferenced tile blobs |
| `REPLICAS`, `SHARD_STRATEGY` | `1`, `single` | Other values fail startup |

Keep databases and buckets dedicated to one server. Sharing a bucket across unrelated database instances is unsupported.
S3 credentials need object get, put, delete, and bucket listing. Conditional creation must support `If-None-Match: *`.
The server does not create buckets. Configure bucket encryption and transport through the provider.
Filesystem objects keep bytes and metadata together in atomic `.object` files. Treat that directory as adapter-owned storage.

## Kubernetes and CNPG

Start from [`deploy/helm/cnpg-s3.example.yaml`](../deploy/helm/cnpg-s3.example.yaml).
Set `database.host` to your CNPG cluster's `-rw` service.
Set `database.existingSecret` to its application secret with `username`, `password`, and `dbname` keys.
Use the application database owner, which needs permission to create and migrate tables. Do not use the PostgreSQL superuser.
Set `database.tls.existingSecret` to the cluster CA secret containing `ca.crt`.
Keep `database.tls.mode: verify-full` and use a service hostname covered by the certificate.
See [CNPG application connections](https://cloudnative-pg.io/docs/devel/applications/) for its service and secret conventions.

CNPG's object-store backup integration stores PostgreSQL backups. It does not serve application blobs.
Configure a separate application bucket and S3 endpoint, even when the same object service holds both.
See [Barman Cloud backup concepts](https://cloudnative-pg.io/plugin-barman-cloud/docs/concepts/).

Create `server.existingSecret` with `ADMIN_TOKEN` and optional server credentials.
Create `storage.s3.existingSecret` with the standard AWS credential variable names.
Secret contents belong in Kubernetes Secrets or your external secret manager, outside Helm values.
The chart also supports `extraEnv` entries with `secretKeyRef` for other credentials.
For filesystem storage or SQLite, leave persistence enabled and configure your storage class or existing claim.
For PostgreSQL plus S3, `/data` only holds disposable social-rendering cache, so persistence may be disabled.

```sh
helm upgrade --install caelestis deploy/helm/caelestis \
  -f deploy/helm/cnpg-s3.example.yaml \
  --set image.tag=YOUR_IMAGE_TAG --wait --timeout 10m
```

The chart creates the application, Service, optional Ingress, and optional PVC. It does not provision CNPG or S3.
Ingress TLS uses an existing TLS Secret. Add ingress-controller annotations for your WebSocket timeout policy.
Set `server.origin` to the public HTTPS origin in your Helm values.
Service-account token mounting is disabled. If you use workload identity, adapt the chart's pod configuration to that provider.

## Migrations, upgrades, and rollback

Startup acquires ownership before applying migrations or accepting traffic.
SQLite uses the existing D1 migration sequence. PostgreSQL has its own equivalent baseline and ordered migrations.
Both adapters record migration checksums and reject modified migration files.
Coordinator format 1 includes durable JSON state, scheduled wakeups, counters, and retry/idempotency records.
Counter acceptance and flush acknowledgements retain the existing retry semantics.
Backfills, alarm verification, tile mirroring, garbage collection, and daily social rendering resume from durable wakeups.
The social renderer runs in a worker thread. Other jobs run in the main process with bounded concurrency.

For an upgrade, stop the old application and take a consistent database-and-object backup first.
With the chart, an explicit migration phase is available:

```sh
helm upgrade caelestis CHART --version CHART_VERSION -f my-values.yaml \
  --set replicaCount=0,migration.enabled=true --wait --wait-for-jobs --timeout 15m
helm upgrade caelestis CHART --version CHART_VERSION -f my-values.yaml \
  --set replicaCount=1,migration.enabled=false --wait --timeout 10m
```

The migration Job retries while the previous owner shuts down. It uses the same image, storage, secrets, and ownership checks.
For Docker, stop the old container and run the new image with the same environment and volumes:

```sh
docker run --rm --env-file .env -v caelestis-data:/data IMAGE \
  node apps/backend/dist/node/main.js migrate
```

Migrations have no automatic down direction. An older binary may not understand a newer schema.
Rollback requires restoring the pre-upgrade database and matching object backup, then starting the previous pinned image.
A Helm rollback alone does not reverse database changes. PVCs carry Helm's keep policy and survive uninstall.
Stop the application before copying SQLite and filesystem data. For PostgreSQL/S3, back up both while writes are stopped.
Include coordinator tables and tokens when backing up PostgreSQL. A CNPG database backup alone does not include application objects.
Portable admin export/import across providers is tracked separately and is not part of this release.

## Versions and development checks

Approved app releases publish multi-platform `linux/amd64` and `linux/arm64` images to `ghcr.io/mia-riezebos/caelestis`.
An image tag names both app versions, for example `backend-1.2.3-frontend-4.5.6`.
Its Helm version is `1.2.3+frontend.4.5.6`, stored at `oci://ghcr.io/mia-riezebos/caelestis/charts/caelestis`.
OCI represents the chart version's `+` as `_`. Pass the original version to Helm.
Published charts pin the image digest. Pin chart versions when upgrading.
Server GitHub Releases contain the chart, image digest, migration checksums, app versions, commit, and `SHA256SUMS`.
The workflow refuses to replace an existing artifact with different content.
Chart or shared-package changes that affect the server need a Changeset for the affected backend/frontend app.

From source, use Node 24.20.0 and the repository's pinned pnpm:

```sh
pnpm install --frozen-lockfile
CAELESTIS_TARGET=node pnpm --filter @caelestis/backend... --filter @caelestis/frontend... build
node apps/backend/dist/node/main.js
node scripts/test-portable-image.mjs caelestis:local
```

The image test creates and removes its own PostgreSQL, S3, network, containers, and volumes.
CI runs database contracts, restart tests, both deployment builds, image checks, vulnerability scans, and Helm schema validation.
Cloudflare remains the default frontend build target. Existing Wrangler configuration and deployment commands still apply.
