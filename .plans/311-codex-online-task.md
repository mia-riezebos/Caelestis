# Backend task: presence headcount over HTTP

Repo: this worktree. Branch `t3code/add-collaborative-websocket-editing`, PR #362. Do NOT commit or
stage anything; leave the diff in the working tree and report what you changed and how you verified it.
Only touch `apps/backend` and `packages/wire-schema`. Do not touch the userscript, ui, or shared packages.

## Why

The userscript is moving from one presence socket per server to one socket per client. It picks
the server with the fewest painters online among the servers it is connected to, so the busiest
servers get fewer collaboration sockets. To pick, it needs the current headcount of a presence room
over plain HTTP before opening any socket. That request is one Durable Object read; keep it that cheap.

## What to build

1. `GET /telemetry/presence/online?season=<n>&surface=world[&allianceId=<n>]` in
   `apps/backend/src/routes/telemetry.ts`, next to the existing `/presence` upgrade route.
   - Auth: plain HTTP read scope, the same as `GET /work/regions` (`requireScopeEffect(runtime, auth, 'read')`
     or the equivalent already used for read routes in this file). Anonymous read credentials that
     the read routes accept must be accepted here too. No websocket headers involved.
   - Validation mirrors the upgrade route: `season` must be the served season (404 otherwise),
     surface parsed with `templateSurface`, 400 on an invalid surface or alliance id.
   - 404 `{ error: 'not found' }` when presence is not configured (no `connectPresence`).
   - Responds `200 { online: <number of open presence sockets in that room> }`.
   - Cache headers: `cache-control: no-store`.

2. An options seam beside `connectPresence` in `apps/backend/src/app.ts` (and the presence port file
   if that is where `ConnectPresence` lives): `presenceOnline?: (season, surface) => Promise<number>`.
   Wire it in `apps/backend/src/worker.ts` the same way `publishRegions` reaches the Durable Object:
   an RPC method on `PresenceObject` (e.g. `online(): Promise<number>`) that returns
   `this.sockets().length`, which must be correct after hibernation (it is based on
   `state.getWebSockets`). It must not wake up any tick or send anything.

3. Wire schema: add a `PresenceOnline` response schema (`{ online: number, non-negative integer }`)
   in `packages/wire-schema/src/index.ts`, following the file's `assertExact` convention against a
   shared type if one is appropriate; if no shared type exists, define the schema without assertExact
   and say so in your report.

4. Tests: extend `apps/backend/src/presence/routes.test.ts` (or the closest existing suite) with
   the happy path, the 404 without presence, the season mismatch, and the invalid surface case; and
   `apps/backend/src/worker.test.ts` if it covers the presence wiring. Add a Durable Object test for
   `online()` if there is an existing DO test harness for `PresenceObject`.

## Verify before reporting

```
pnpm --filter @caelestis/wire-schema test
pnpm --filter @caelestis/backend test
pnpm --filter @caelestis/backend exec tsc -p tsconfig.json
pnpm biome check apps/backend packages/wire-schema
```

Report the exact commands you ran and their results, the route's final path and response shape, and
anything you were unsure about.
