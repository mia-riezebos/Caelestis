# Backend API versioning

The Worker mounts the backend beneath `BASE_PATH`. The included deployment uses `/backend`.
Application routes use an explicit version beneath that base path, such as `/backend/v1/manifest`.
The operational health check remains at `/backend/health` and does not belong to an application API
version.

## Compatibility aliases

The unversioned application paths are aliases for v1. Both prefixes mount the same Hono router, so
methods, authentication, bodies, responses, caching, CORS, and WebSocket behavior cannot drift.
Bundled clients use `/v1`; the aliases exist for older userscripts, frontends, and self-hosted
clients.

Do not remove an alias while a supported client release still calls it. Before removal:

1. Publish the versioned client release and its migration note.
2. Keep the alias for the documented support window.
3. Confirm every bundled release in the support window uses the versioned path.
4. Announce the removal, then remove the alias in a separate breaking backend change.

## Introducing an incompatible version

Do not change v1 in place. Build a separate router for the new contract and mount it at the next
version prefix. Keep the v1 router mounted for its support window. Move bundled clients only after
the new router has compatibility coverage for reads, writes, errors, binary assets, and live
upgrades. An unversioned alias stays attached to its documented version until its own retirement.
