# Backend task: live painter presence over WebSockets (issue #311)

You are implementing the backend half of a Google Docs style presence feature for a pnpm monorepo
(Cloudflare Workers, Hono, Effect, Drizzle on D1, Durable Objects). The frontend/userscript half is
being built by someone else at the same time in this same worktree. Only edit files under
`apps/backend/` and `packages/wire-schema/`. Do not run `git commit`, `git stash`, or `git checkout`.
Do not edit `packages/shared/` (its contract is fixed) or `apps/userscript/`.

Read these first, in this order:

1. `packages/shared/src/presence.ts` — the wire contract and all limits. Import everything from
   `@caelestis/shared`. Do not redefine constants.
2. `apps/backend/src/status-read-model-object.ts` — the existing hibernating WebSocket Durable
   Object. Copy its patterns: `acceptWebSocket` with tags, `serializeAttachment`, `getWebSockets`,
   `setWebSocketAutoResponse('ping','pong')`, `webSocketMessage`, `webSocketClose`, and the
   `createLiveSessionFence` idea for serialising attach/revoke.
3. `apps/backend/src/routes/telemetry.ts` lines 210–310 — how `/telemetry/live` authenticates a
   WebSocket upgrade via `liveAuthorization` (the token rides in `sec-websocket-protocol`) and hands
   off to the DO through `options.connectStatusLive`. Mirror this exactly for presence.
4. `apps/backend/src/app.ts`, `apps/backend/src/worker.ts`, `apps/backend/wrangler.toml`,
   `apps/backend/src/worker-configuration.d.ts` — how DOs are bound, exported, and migrated.
5. `apps/backend/src/routes/work.ts`, `apps/backend/src/work/use-cases.ts`,
   `apps/backend/src/work/store.ts`, `apps/backend/src/db/schema.ts`, `apps/backend/src/ports/sql-store.ts`,
   `apps/backend/src/adapters/cloudflare/d1-sql-store.ts` — how persisted coordination records are
   modelled, validated, stored, and routed.
6. `packages/wire-schema/src/index.ts` — Effect Schema for every wire type, with `assertExact`
   checks against the shared TypeScript types at the bottom. Add presence schemas the same way.
7. `apps/backend/src/status-read-model-object.test.ts` and `apps/backend/src/routes/work.test.ts`
   (or `work/routes.test.ts`) — how DOs and routes are tested with vitest and the SQLite D1 helper.

## What to build

### 1. Wire schema

In `packages/wire-schema/src/index.ts` add Effect schemas for `PresenceRect`, `PresenceDraft`,
`PresenceClientEvent`, `PresencePeer`, `RegionClaim`, `PresenceServerEvent`, and
`RegionClaimRequest`, bounded by the constants in shared. `assertExact` each against the shared
type, both `Type` and `Encoded`, like the existing live schemas. The draft mask check must mirror
`isPresenceDraft` in shared.

### 2. `PresenceObject` Durable Object

New file `apps/backend/src/presence-object.ts`, exported from `worker.ts`, bound as `PRESENCE` with
class `PresenceObject`, added to `wrangler.toml` with a new `[[migrations]]` tag `v5`
(`new_sqlite_classes`), and typed in `worker-configuration.d.ts` by hand in the same style as the
other bindings (note the comment in `env.d.ts` about that file being generated; add the binding
line so the build passes).

One object per `season:surfaceKey` (use `templateSurfaceKey` from shared). Name it via
`namespace.getByName(...)`.

`fetch` accepts only WebSocket upgrades and reads the same headers the status DO reads
(`x-caelestis-season`, `x-caelestis-token-hash`, `x-caelestis-client-hash`,
`x-caelestis-credential-scope`, `x-caelestis-anonymous`, `x-caelestis-revocable`, metric client
headers), plus `x-caelestis-surface-kind`, `x-caelestis-alliance-id`, `x-caelestis-painter-id`
(non-negative integer) and `x-caelestis-painter-name` (URL-encoded, 1–128 chars). The route layer
sets these. Reject with 400 on malformed values.

Capacity: refuse with 503 and `Retry-After: 30` past `MAX_PRESENCE_SUBSCRIBERS` sockets or
`MAX_PRESENCE_SUBSCRIBERS_PER_CLIENT` for one `clientHash`. Only `credentialScope` of `report` or
`admin` may publish (`presence-update`); a `read` socket can connect and observe but its updates are
ignored. Revocable credentials are re-checked against D1 on attach exactly like the status DO.

Attachment (must stay well under 2 KiB): `sessionId` (16 hex chars from `crypto.getRandomValues`),
season, surface, painter identity, `clientHash`, `credentialScope`, `viewport` rect or null,
`draftRect` or null, `draftPixels` count, `lastSeenAt` ms. Draft masks live only in an in-memory
`Map<sessionId, string>`; after hibernation the client's 30 s heartbeat resend restores them.

On accept: send `presence-ready` with the new session id, `online` (count of open sockets), the
peers relevant to this subscriber (see interest rules), and all region claims for this surface.

`webSocketMessage`:

- Text only. Close 1009 if longer than `MAX_PRESENCE_MESSAGE_CODE_UNITS`. Decode with the wire
  schema; ignore undecodable messages (do not close, a buggy client should not lose its socket).
- Rate limit per socket: more than `MAX_PRESENCE_MESSAGES_PER_SECOND` in a rolling second closes
  it with 1008. Keep the counter in memory keyed by session id; a fresh counter after hibernation
  is fine.
- `presence-heartbeat`: update `lastSeenAt`.
- `presence-update`: apply the present fields (absent means unchanged, `null` clears). Quantise
  rects with `quantiseRect`. Reject (ignore) rects outside `templateSurfaceBounds(surface)`. Update
  `lastSeenAt`. Mark the session dirty and arm the tick.

Tick: one `setTimeout` of `PRESENCE_TICK_MS` armed on the first dirty session, never more than one
pending. On fire, for every open socket compute the peers it should see and send one
`presence-delta` with `upsert` (peers that are dirty or newly in range) and `remove` (session ids
that left range, closed, or are stale). Track per-socket the set of session ids last sent, in
memory; after hibernation that set is empty, so the first tick re-sends everything relevant, which
is the correct recovery. Sessions with `lastSeenAt` older than `PRESENCE_STALE_MS` are closed with
1000 and removed. Skip sending to a socket whose delta is empty.

Interest rules: a subscriber with a viewport sees peers whose `peerRect` intersects
`padRect(viewport, PRESENCE_INTEREST_PADDING)`, nearest `MAX_PRESENCE_PEERS` by
`rectCentreDistance`. A subscriber with no viewport sees nothing but `online`. A subscriber never
receives its own session.

`webSocketClose`/`webSocketError`: drop memory for that session and mark peers dirty so the next
tick sends its removal. Note the DO does not know which sockets saw it; removals go to every
socket whose last-sent set contains that id.

Also expose RPC methods (this DO extends `DurableObject` so the worker can call them):
`publishRegions(season, surface)` reloads region claims from D1 and broadcasts a `regions` event to
every open socket, and `closeCredential(tokenHash)` closes sockets for a revoked token like the
status DO does. Wire `closeCredential` into the same place the status DO's is called from token
revocation (search for `closeCredential` in `routes/tokens.ts` or the use case behind it).

### 3. Region claims in D1

Drizzle table `work_regions` in `schema.ts`: `id` text PK (UUIDv7), `season` integer, `surface_kind`
text, `alliance_id` integer nullable, `template_id` text, `claimant_user_id` integer,
`claimant_name` text, `x`, `y`, `w`, `h` integers, `label` text, `created_at` integer, index on
(season, surface_kind, alliance_id, template_id). Generate the migration with
`pnpm --filter @caelestis/backend db:generate` and check the SQL it produced is sane; if
`drizzle-kit` cannot run, write `migrations/0021_work_regions.sql` by hand and add the matching
entry to `migrations/meta/_journal.json` in the same format as the previous entries.

Store methods on the SQL store port (`sql.work` or a new `sql.regions`): `listRegions(season,
surface, templateId?)` ordered by `created_at`, capped at `MAX_PRESENCE_REGIONS`; `createRegion`;
`deleteRegion(id)`; `readRegion(id)`. Implement for D1 and for any in-memory adapter the tests use.

Routes on the existing work router (`routes/work.ts`), mounted so the paths are
`/work/regions` and `/work/regions/:id`. All need `read` scope like the rest of work; mutations
need `report`:

- `GET /work/regions?season=&surface=&allianceId=&templateId=` → `{ regions: RegionClaim[] }`.
- `PUT /work/regions/:id` with body `RegionClaimRequest` (validate with the wire schema; the rect
  must be within surface bounds and its area at most `MAX_PRESENCE_REGION_PIXELS`; label at most
  `MAX_PRESENCE_REGION_LABEL` chars, may be empty; `templateId` must be a UUID that exists in the
  template store for that season and surface). Idempotent: an existing id with the same claimant
  returns 200 with the record; a different claimant gets 409. Returns the `RegionClaim`.
- `DELETE /work/regions/:id` with body `{ actor: PainterIdentity }`. Only the claimant (same
  `wplaceUserId`) or an `admin` credential may delete. 404 when absent, 403 otherwise.
- After a successful PUT or DELETE, call `PRESENCE.getByName(...).publishRegions(season, surface)`
  through a port so the use case stays runtime-free (follow how `StatusReadModelService` /
  `publishManifestChange` are wired in `work/use-cases.ts`). In tests the port can be a spy.

### 4. Route for the socket

`GET /telemetry/presence` in `routes/telemetry.ts`, next to `/live`. Same auth. Query: `season`
(must equal `currentSeason`), `surface` (default `world`), `allianceId`, `painterId`, `painterName`,
`client`, `clientVersion`, `clientId` (for anonymous). Validate the painter identity with
`isWorkIdentity` from shared. Hand off via a new `connectPresence` option in `AppOptions`, wired in
`worker.ts` to `env.PRESENCE.getByName(`${season}:${templateSurfaceKey(surface)}`).fetch(...)` with
the headers listed above. Advertise it in `ServerInfo` as `presence: 1` next to `liveSync`. The shared
`ServerInfo` type already has the optional `presence?: 1` field; add
`presence: Schema.optionalKey(Schema.Literal(1))` to the wire-schema `ServerInfo` and set it in
`app.ts` whenever `connectPresence` is configured.

The DO's `fetch` response must set `sec-websocket-protocol` to `PRESENCE_PROTOCOL_V1` when the
client offered it, like the status DO does for its protocols.

## Tests (vitest, in `apps/backend`)

- `presence-object.test.ts`: attach two fake sockets with viewports 500 px apart, publish a draft
  from one, run the tick, assert the other receives `presence-delta` with the peer and mask and the
  first receives nothing about itself; move the second's viewport 5000 px away, tick, assert it gets
  `remove`; exceed the rate limit and assert close 1008; oversized message closes 1009; a `read`
  credential's update is ignored; stale session removed after `PRESENCE_STALE_MS`; a socket without
  a viewport gets deltas with only `online`; over `MAX_PRESENCE_PEERS` peers are capped to the
  nearest.
- `work/regions.test.ts` (or extend the work route tests): create, list, idempotent re-put,
  conflicting claimant 409, delete by other painter 403, delete by admin 200, rect outside bounds
  400, region publish spy called after mutations.
- Wire-schema tests in `packages/wire-schema/src/index.test.ts` for a valid and an invalid draft
  mask and rect.

## Done means

- `pnpm --filter @caelestis/wire-schema test`, `pnpm --filter @caelestis/backend test`,
  `pnpm --filter @caelestis/backend check`, and `pnpm biome check apps/backend packages/wire-schema`
  all pass. Run them and paste the tail of each in your report.
- Nothing under `packages/shared` or `apps/userscript` changed (`git status --short` shows only
  backend, wire-schema, and migration files).
- Your final message lists every file you added or changed, the exact query and header names the
  userscript must send to `/telemetry/presence`, the HTTP shapes of the region routes, and anything
  you could not finish with the reason.

If something in the contract makes the design impossible, say so clearly in the report instead of
changing `packages/shared`.
