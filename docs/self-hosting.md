# Self-hosting Caelestis

Separate containers serve the backend and SvelteKit frontend. Choose Node or Bun for the backend; the frontend uses Node.
The frontend forwards backend HTTP and WebSocket requests.
It supports these independent adapter choices:

| Data | Cloudflare | Self-hosted |
| --- | --- | --- |
| Relational records | D1 | SQLite, PostgreSQL including CNPG, or MariaDB 11.8 |
| Blobs and social images | R2 | Filesystem or S3-compatible storage |
| Live state, counters, and jobs | Durable Objects | Persistent coordinator tables in the selected database |

Use exactly one active backend replica. PostgreSQL itself may have replicas and failover through CNPG.
The application connects to the writable primary and holds an ownership lock on its database connection.
Losing that connection stops the server. Kubernetes can then restart it against the new primary.
Use a direct connection or session pooling. Transaction-pooling proxies cannot retain this ownership lock.

SQLite holds a kernel-managed lock in a sibling `.owner` file. Process exit releases the lock, including a crash.
Use a local filesystem or block-backed persistent volume with working POSIX locks. Network filesystems are unsupported for SQLite.
The chart rejects multiple replicas and uses `Recreate` updates. Horizontal application scaling requires a future coordination adapter.
Durable jobs already claim a fenced, renewable lease in `runtime_alarms` before they run, so processes that later share one database run each job once. A crashed owner's claim expires after 30 seconds.

## Choose Node or Bun

Each server release publishes matching backend variants for `linux/amd64` and `linux/arm64`:

| Backend tags | Runtime | Use |
| --- | --- | --- |
| `latest`, `1`, `1.2`, `1.2.3` | Bun 1.4.2 | Default |
| `latest-bun`, `1-bun`, `1.2-bun`, `1.2.3-bun` | Bun 1.4.2 | Explicit Bun |
| `latest-node`, `1-node`, `1.2-node`, `1.2.3-node` | Node 24.20.0 | Explicit Node |

The frontend publishes `latest`, major, minor, and patch tags for its own version.
Patch tags stay immutable. Latest, major, and minor aliases move only when that app receives a release.
Each server release also has a paired tag, for example `backend-1.2.3-frontend-4.5.6`.
The paired backend tag uses Bun. Its `-bun` and `-node` forms select either runtime explicitly.
The frontend uses the unsuffixed paired tag.
Release `versions.json` and image labels record runtime versions; the Dockerfile pins their source images by digest.

Each release publishes the same tested tags to both registries:

| Registry | Backend | Frontend |
| --- | --- | --- |
| Docker Hub | `docker.io/miacx/caelestis-backend` | `docker.io/miacx/caelestis-frontend` |
| GHCR | `ghcr.io/mia-riezebos/caelestis-backend` | `ghcr.io/mia-riezebos/caelestis-frontend` |

Bun uses native HTTP, WebSockets, and SQLite statements behind the portable adapters.
Routes, authentication, claims, coordination, migrations, and transaction rules have one shared implementation.
PostgreSQL, MariaDB, and S3 use the existing drivers under Bun. Bun.SQL does not preserve our JSON/numeric contracts,
and Bun's S3 API lacks the conditional writes and custom metadata required by the object-storage contract.
Filesystem atomic writes and the social renderer use Bun's implementations of the existing filesystem and worker APIs.
Cloudflare Workers remain a separate deployment target. Miniflare is development and test tooling.

To pin a published Bun backend in Compose, set these references in `.env`:

```dotenv
CAELESTIS_BACKEND_IMAGE=miacx/caelestis-backend:backend-1.2.3-frontend-4.5.6
CAELESTIS_FRONTEND_IMAGE=miacx/caelestis-frontend:backend-1.2.3-frontend-4.5.6
```

Run `docker compose pull`, then `docker compose up -d --no-build --wait` with your usual stack files.
For a local Bun build, use `docker build --target backend-bun -t miacx/caelestis-backend:local .`,
then start Compose with `--no-build`. The existing `backend` Docker target builds Node.
The Bun image aliases `node` to Bun, so existing migration, health-check, and S3 initialization commands use the selected runtime.

Published Helm charts pin the default Bun backend and Node frontend digests. To select Node, override
`image.digest` with the release's `backend-node-image.txt` digest. To select by tag instead, clear that digest:

```sh
helm upgrade --install caelestis oci://ghcr.io/mia-riezebos/caelestis/charts/caelestis \
  --version YOUR_CHART_VERSION -f your-values.yaml \
  --set-string image.tag=YOUR_IMAGE_TAG-node --set-string image.digest= \
  --wait --timeout 10m
```

The chart defaults to Docker Hub. To use GHCR, override `image.repository` and `frontend.image.repository`.
Also set their matching digests from the release's `backend-ghcr-image.txt` and `frontend-ghcr-image.txt` files.
Keep the chart's matching frontend image. The database, object storage, and existing secrets are shared across runtimes.
Switching runtimes at the same app version requires a backend restart and WebSocket reconnect, with no data conversion.
Select the matching unsuffixed or `-bun` image to switch back. For an app-version downgrade, follow the backup/restore procedure below.
The Bun backend requires the separate Node frontend; the optional combined `FRONTEND_HANDLER` mode is Node-only.

## Run with Docker

The repository includes [`Dockerfile`](../Dockerfile), [`compose.yaml`](../compose.yaml), and the [Helm chart](../deploy/helm/caelestis).
For Compose, copy the example environment. Set different private `ADMIN_TOKEN` and `CAELESTIS_READ_TOKEN` values, and the current `SEASON`:

```sh
cp .env.example .env
# Edit .env. Generate each token separately with: openssl rand -hex 32
docker compose up --build -d --wait
```

Compose stores SQLite in its `data` volume and files in its `objects` volume, binding the frontend to localhost:3000.
The frontend shares only the object volume. It receives no database or administrator credentials.
`docker compose down` preserves that volume. The `--volumes` option removes its data.
Set `CAELESTIS_HTTP_PORT` or `CAELESTIS_BIND_ADDRESS` in `.env` to change the host binding.
The container listens on port 3000 regardless of the host port.
Set `CAELESTIS_BACKEND_IMAGE` and `CAELESTIS_FRONTEND_IMAGE` to published references, then use `docker compose pull` and `docker compose up -d --no-build --wait`.
Other adapter settings in `.env` follow the configuration table below. Mount certificate files separately when using a private PostgreSQL CA.

Build from a checkout with Docker:

```sh
docker build --target backend --build-arg CAELESTIS_BUILD_ID="$(git rev-parse HEAD)" -t miacx/caelestis-backend:local .
docker build --target frontend --build-arg CAELESTIS_BUILD_ID="$(git rev-parse HEAD)" -t miacx/caelestis-frontend:local .
docker compose up -d --no-build --wait
```

Create `.env` with a private `ADMIN_TOKEN`, `SERVER_NAME`, and the current `SEASON`.
Generate the admin token with `openssl rand -hex 32`. Keep the file private and outside Git.
Open `http://localhost:3000` for the frontend. Configure userscripts with `http://localhost:3000/backend`.
The backend registers the configured frontend token as read-only on first startup. Both containers receive the same token.
On an existing database, use an active read-only token. Revoked tokens remain revoked and fail startup.
That token stays on the server. The frontend never receives the bootstrap admin token.
Admin API calls use `Authorization: Bearer <ADMIN_TOKEN>`. Existing token-management APIs still apply.

The backend stores SQLite and coordinator state in `/data`. Compose mounts shared objects at `/objects`.
The image runs as UID/GID 1000. Bind-mounted directories must be writable by that user.
Put an HTTPS reverse proxy in front for remote access. Forward WebSocket upgrades and allow long-lived connections.
Set `ORIGIN` to the public HTTPS origin so SvelteKit generates the correct public URLs.
Both containers expose `/health/live` and `/health/ready`. Backend Prometheus metrics are at `/metrics` on its internal port.
See [Capacity metrics](#capacity-metrics) for the per-pod connection gauges.
Backend readiness checks database access; frontend readiness checks an authenticated backend read.
Backend request logs use JSON and omit authorization values and query strings.
SIGTERM stops admission, closes WebSockets, and drains active work. The process allows 30 seconds before forced exit.

## Capacity metrics

`/metrics` reports what one backend process holds. A healthy empty process reports zero for every gauge.
A missing scrape means the telemetry is unavailable, not that the pod is empty.
No series uses a user ID, token, client hash, or painter as a label.

| Series | Meaning |
| --- | --- |
| `caelestis_connected_users` | People connected to this process, counted once across presence, live sync, and extra tabs. Authenticated sockets count per credential; anonymous frontend sockets count per browser client. |
| `caelestis_live_sync_connections` | Occupied live-sync slots. Every socket counts, so multi-tab users can exhaust the 256-slot coordinator limit before unique users show pressure. |
| `caelestis_presence_connections` | Open presence sockets. |
| `caelestis_coordinator_connections{kind,coordinator}` | Sockets on the season's live-sync host (`kind="live-sync"`) or on the fullest presence room in that season (`kind="presence"`). `coordinator` is the season; rooms are keyed by caller-chosen surfaces, so they never become labels. |
| `caelestis_coordinator_connection_limit{kind,coordinator}` | The admission limit for that coordinator, so saturation is `connections / limit`. |
| `caelestis_admissions_total{channel}` | Accepted WebSocket upgrades per channel (`live-sync`, `presence`). Counter deltas over 15 and 60 second windows give the gross influx. |
| `caelestis_admission_rejections_total{channel}` | Upgrades refused because a limit was reached. Sustained growth means users are being turned away. |
| `caelestis_live_pending_work` | Socket messages and background work not yet finished by any live host. |
| `caelestis_event_loop_lag_seconds{stat}` | Event-loop delay since the previous scrape, `p99` and `max`. |

These series are the per-shard input for the peer-sharding roadmap in issue #386. Today the application still runs one active replica.
In Kubernetes, scrape each pod directly instead of the Service. With the Prometheus Operator installed, set
`metrics.podMonitor.enabled=true` to render a `PodMonitor` for the `backend` port. Configure the operator's
pod monitor selectors to include the release namespace and, if needed, `metrics.podMonitor.labels`.

## Compose stacks

Run these commands from the repository root. Set the required passwords in `.env`; database and S3 ports stay private.

| Stack | Compose files after `docker compose` | Additional settings |
| --- | --- | --- |
| SQLite + filesystem | `-f compose.yaml` | None |
| PostgreSQL + filesystem | `-f compose.yaml -f deploy/compose/postgres.yaml` | `POSTGRES_PASSWORD` |
| MariaDB + filesystem | `-f compose.yaml -f deploy/compose/mariadb.yaml` | `MARIADB_PASSWORD` |
| SQLite + local S3 | `-f compose.yaml -f deploy/compose/s3.yaml` | `MINIO_ROOT_PASSWORD` |
| PostgreSQL + local S3 | `-f compose.yaml -f deploy/compose/postgres.yaml -f deploy/compose/s3.yaml` | Both passwords |
| MariaDB + local S3 | `-f compose.yaml -f deploy/compose/mariadb.yaml -f deploy/compose/s3.yaml` | Both passwords |
| Existing CNPG + filesystem | `-f compose.yaml -f deploy/compose/cnpg.yaml` | `PGHOST`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `PG_TLS_CA_FILE` |

Append `up --build -d --wait` to start. Use the same `-f` options for subsequent commands, including `down`.
For example:

```sh
docker compose -f compose.yaml -f deploy/compose/postgres.yaml -f deploy/compose/s3.yaml up --build -d --wait
```

The S3 example provisions a dedicated local MinIO bucket. It uses its root credentials for convenience in this local stack.
For an existing S3 service, omit `s3.yaml`. Set `OBJECT_STORAGE=s3`, `S3_BUCKET`, endpoint, and credentials in `.env`.
This works with every database override, including CNPG. Both application containers must use the same object provider and bucket.

### Temporary HTTPS tunnel for Docker testing

Add `-f deploy/compose/cloudflared.yaml` to any Compose stack to expose its frontend through a Cloudflare Quick Tunnel.
The official `cloudflare/cloudflared` container connects to `http://frontend:3000` on the Compose network.
It needs no account, tunnel token, host networking, or router port forwarding. Backend HTTP and WebSockets use the same public origin.

For PostgreSQL and local S3, add these lines to your private `.env` so subsequent commands use the same stack:

```dotenv
COMPOSE_PROJECT_NAME=caelestis-local
COMPOSE_FILE=compose.yaml:deploy/compose/postgres.yaml:deploy/compose/s3.yaml:deploy/compose/cloudflared.yaml
```

1. Run `docker compose up --build -d --wait`.
2. Run `docker compose logs cloudflared` and copy the `https://….trycloudflare.com` URL.
3. Set `ORIGIN` to that URL in `.env`, then run `docker compose up -d --no-deps frontend`.
4. Open that URL. Connect the userscript to the same URL with `/backend` appended, using a token from this test server.

The URL changes when the tunnel restarts. Repeat steps 2 and 3 after that happens.
Run `docker compose stop cloudflared` to close public access while keeping the stack available at localhost.
Run `docker compose down` to stop the stack and preserve its data.

To validate all six database/storage combinations with disposable Docker stacks:

```sh
CAELESTIS_TEST_EXTENDED=true node scripts/test-portable-image.mjs miacx/caelestis-backend:local miacx/caelestis-frontend:local
```

These checks use separate project names and volumes. They cover acceptance, ownership, crash recovery, migrations,
and PostgreSQL/MariaDB connection-loss recovery. They leave the manual test stack running.

To include a real native `.wplace` import in every combination, set `CAELESTIS_TEST_WPLACE` to its local path:

```sh
CAELESTIS_TEST_WPLACE="$HOME/Downloads/Box art.wplace" CAELESTIS_TEST_EXTENDED=true \
  node scripts/test-portable-image.mjs miacx/caelestis-backend:local miacx/caelestis-frontend:local
```

Each stack imports and publishes the embedded PNG at its geographic coordinates through the normal admin API.
Checks compare its manifest geometry and every stored chunk hash after startup, crash recovery, and migration.
The source file stays local. Test results record the imported template name and chunk count.

CNPG runs in Kubernetes. The Compose example connects to an existing primary reachable from the Docker network.
A cluster-only `.svc` hostname usually cannot resolve outside Kubernetes. Use a reachable hostname covered by the database certificate.
`PG_TLS_CA_FILE` names a local certificate file mounted read-only into the backend; the example keeps hostname verification enabled.
For an application running inside the cluster, use the CNPG Helm example instead.

MariaDB uses one InnoDB session with a database-scoped ownership lock. It fails closed if that session disconnects.
Use a direct connection to one writable primary. MySQL and PlanetScale are separate adapters and are not implied by MariaDB support.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST`, `PORT` | `0.0.0.0`, `3000` | Listener in each container; Helm uses port 3001 for the backend |
| `CAELESTIS_SERVER` | `http://backend:3000/backend` | Frontend's internal backend URL, including its mount path |
| `ORIGIN` | request origin | Public frontend origin, for example `https://caelestis.example.com` |
| `DATA_DIRECTORY` | `/data` in the image; `./data` from source | Persistent local directory |
| `OBJECT_DIRECTORY` | `$DATA_DIRECTORY/objects`; `/objects` in Compose | Shared filesystem object directory, mounted into both containers |
| `DB_ADAPTER` | `sqlite` | `sqlite`, `postgres`, or `mariadb` |
| `MARIADB_HOST`, `MARIADB_PORT`, `MARIADB_DATABASE`, `MARIADB_USER`, `MARIADB_PASSWORD` | unset; port `3306` | MariaDB application connection |
| `MARIADB_TLS_MODE` | `verify-full` | `verify-full`, `require`, or `disable`; disable only for a private local connection |
| `MARIADB_TLS_CA_FILE`, `MARIADB_TLS_CERT_FILE`, `MARIADB_TLS_KEY_FILE` | unset | Optional CA and client certificate files |
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
| `CAELESTIS_READ_TOKEN` | required for separate containers | Shared private read-only credential, distinct from `ADMIN_TOKEN` |
| `BASE_PATH` | `/backend` | Backend mount; `/backend` remains a compatibility alias |
| `TILE_BLOB_GC_MODE` | `dry-run` | Set `delete` to enable deletion of unreferenced tile blobs |
| `REPLICAS`, `SHARD_STRATEGY` | `1`, `single` | Other values fail startup |

Keep databases and buckets dedicated to one server. Sharing a bucket across unrelated database instances is unsupported.
S3 credentials need object get, put, delete, and bucket listing. Conditional creation must support `If-None-Match: *`.
The server does not create buckets. Configure bucket encryption and transport through the provider.
Filesystem objects keep bytes and metadata together in atomic `.object` files. Treat that directory as adapter-owned storage.

## Kubernetes and CNPG

Start from [`deploy/helm/cnpg-s3.example.yaml`](../deploy/helm/cnpg-s3.example.yaml).
For MariaDB, use [`deploy/helm/mariadb-s3.example.yaml`](../deploy/helm/mariadb-s3.example.yaml), with its primary hostname, port, application Secret, and CA.
Set `database.host` to your CNPG cluster's `-rw` service.
Set `database.existingSecret` to its application secret with `username`, `password`, and `dbname` keys.
Use the application database owner, which needs permission to create and migrate tables. Do not use the PostgreSQL superuser.
Set `database.tls.existingSecret` to the cluster CA secret containing `ca.crt`.
Keep `database.tls.mode: verify-full` and use a service hostname covered by the certificate.
See [CNPG application connections](https://cloudnative-pg.io/docs/devel/applications/) for its service and secret conventions.

CNPG's object-store backup integration stores PostgreSQL backups. It does not serve application blobs.
Configure a separate application bucket and S3 endpoint, even when the same object service holds both.
See [Barman Cloud backup concepts](https://cloudnative-pg.io/plugin-barman-cloud/docs/concepts/).

Create `server.existingSecret` with different `ADMIN_TOKEN` and `CAELESTIS_READ_TOKEN` values.
Create `storage.s3.existingSecret` with the standard AWS credential variable names.
Secret contents belong in Kubernetes Secrets or your external secret manager, outside Helm values.
The chart also supports `extraEnv` entries with `secretKeyRef` for other credentials.
For filesystem storage or SQLite, leave persistence enabled and configure your storage class or existing claim.
For PostgreSQL plus S3, `/data` only holds disposable social-rendering cache, so persistence may be disabled.

```sh
helm upgrade --install caelestis deploy/helm/caelestis \
  -f deploy/helm/cnpg-s3.example.yaml \
  --set image.tag=YOUR_IMAGE_TAG,frontend.image.tag=YOUR_IMAGE_TAG --wait --timeout 10m
```

The chart creates a pod containing separate backend and frontend images, a Service, optional Ingress, and optional PVC.
It does not provision a database or S3. The frontend mounts only the PVC's object directory.
Ingress TLS uses an existing TLS Secret. Add ingress-controller annotations for your WebSocket timeout policy.
Set `server.origin` to the public HTTPS origin in your Helm values.
Service-account token mounting is disabled. If you use workload identity, adapt the chart's pod configuration to that provider.

## Migrations, upgrades, and rollback

Startup acquires ownership before applying migrations or accepting traffic.
SQLite uses the existing D1 migration sequence. PostgreSQL and MariaDB have equivalent baselines and ordered migrations.
All adapters record migration checksums and reject modified migration files.
MariaDB DDL commits implicitly. Its migration journal detects incomplete migrations and refuses to start until the pre-migration backup is restored.
Coordinator format 1 includes durable JSON state, scheduled wakeups, counters, and retry/idempotency records.
Counter acceptance and flush acknowledgements retain the existing retry semantics.
Backfills, alarm verification, tile mirroring, garbage collection, and daily social rendering resume from durable wakeups.
The social renderer runs in a backend worker thread and reads the backend directly using its private read token.
It keeps working when the frontend is stopped. Other jobs run in the main process with bounded concurrency.

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

Approved app releases publish `linux/amd64` and `linux/arm64` images to Docker Hub and GHCR.
They use immutable patch and tested app-version pair tags, for example `1.2.3` and `backend-1.2.3-frontend-4.5.6`.
Latest, major, and minor aliases move when the corresponding app version changes.
Its Helm version is `1.2.3+frontend.4.5.6`, stored at `oci://ghcr.io/mia-riezebos/caelestis/charts/caelestis`.
OCI represents the chart version's `+` as `_`. Pass the original version to Helm.
Published charts pin both image digests. Pin chart versions when upgrading.
Server GitHub Releases contain the chart, registry-specific Node/Bun backend and frontend digests, runtime and app versions,
migration checksums, image configurations, SBOMs, commit, and `SHA256SUMS`.
The `*-dockerhub-image.txt` and `*-ghcr-image.txt` assets contain immutable references for each registry.
The legacy `*-image.txt` assets continue to identify the Docker Hub images.
The workflow refuses to replace an existing artifact with different content.
Before the first release, create the public `miacx/caelestis-backend` and `miacx/caelestis-frontend` repositories on Docker Hub.
Add a Docker Hub access token with write access as the GitHub repository secret `DOCKERHUB_TOKEN`.
The image workflow signs in as `miacx`. It publishes the linked GHCR packages and Helm chart with the workflow's GitHub token.
GitHub creates new personal GHCR packages as private. The first image release pushes both packages, then stops if anonymous pulls fail.
Open each package's settings, change its visibility to Public, and rerun the release workflow.
The retry verifies the existing images before publishing the GitHub Release.
Chart or shared-package changes that affect the server need a Changeset for the affected backend/frontend app.

From source, use Node 24.20.0 and the repository's pinned pnpm:

```sh
pnpm install --frozen-lockfile
CAELESTIS_TARGET=node pnpm --filter @caelestis/backend... --filter @caelestis/frontend... build
# Run each in its own terminal with the corresponding environment configuration:
node apps/backend/dist/node/main.js
node apps/frontend/node/main.mjs
node scripts/test-portable-image.mjs miacx/caelestis-backend:local miacx/caelestis-frontend:local
```

For Bun, build the same sources and run `bun apps/backend/dist/node/main.js` instead.
Use the Bun version pinned in the Dockerfile. `pnpm --filter @caelestis/backend start:node` and `start:bun`
provide equivalent startup commands from the backend package.

See [stack testing](stack-testing.md) for the CI matrix, isolated CNPG tests, upgrade checks, and one-time account setup.

The image test creates and removes its own PostgreSQL, S3, network, containers, and volumes.
CI runs database contracts, restart tests, both deployment builds, image checks, vulnerability scans, and Helm schema validation.
Cloudflare remains the default frontend build target. Existing Wrangler configuration and deployment commands still apply.
