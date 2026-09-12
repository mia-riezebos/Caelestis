# Backend task: fix the open review findings on PR #362

Repo: this worktree, branch `t3code/add-collaborative-websocket-editing`. Do NOT commit or stage
anything; leave the diff in the working tree and report per finding what you changed and how you
verified it. Only touch `apps/backend` and `packages/wire-schema`. The shared package is mine; where
a finding needs a shared change I say so and have already made it (rebuild is done).

Each finding below is a real defect confirmed by reading the code. Fix each at the boundary that
prevents it, with a test that pins the behaviour. Keep changes small and coherent.

## 1. Ghost peers after hibernation (`apps/backend/src/presence-object.ts` around `sent` and `tick`)

`sent` (which peers each subscriber has been told about) is process memory. After the Durable
Object hibernates and wakes on a peer's close, `previous` is empty for every subscriber, so no
`remove` is sent and clients keep rendering that peer until their own socket reconnects.

Fix: when a subscriber has no `sent` entry at tick time (a wake after hibernation), send it a
fresh `presence-ready` (the client replaces its whole peer map on that event; see
`apps/userscript/src/presence-client.ts` `applyServerEvent`) instead of a delta. Then record `sent`
for it as usual. Test: attach two sockets, deliver a ready to both, recreate the object over the
same state (simulate hibernation by constructing a new instance with the same `state`), close one
socket, tick, and assert the survivor receives a `presence-ready` whose peers omit the closed one.

## 2. Claim ownership is forgeable (`apps/backend/src/work/regions.ts`, `routes/work.ts`)

`putRegion` stores `request.actor` as the claimant and `deleteRegion` authorises against the
body-supplied actor, so any report-scope token can overwrite or delete another painter's claim by
naming their `wplaceUserId`. The server cannot verify a Wplace id, but it can bind a claim to the
credential that created it.

Fix: persist the creating caller's `tokenHash` with the claim (new column via a migration; treat
existing rows as owned by nobody in particular: allow the first matching-actor writer to adopt
them, or admins). On update and delete, require `caller.tokenHash` to equal the stored one, or
the caller to be admin scope; keep the actor-id check too, so a shared token still needs the
right painter id. Return 403 otherwise. Do not expose the token hash on the wire. Tests: a second
token cannot delete or overwrite the first token's claim; the same token can; an admin can.

## 3. Shared tokens hit the per-client socket cap (`apps/backend/src/routes/telemetry.ts` `/presence`)

For authenticated connections `clientHash` is just the token hash, so an alliance sharing one
report token is capped at `MAX_PRESENCE_SUBSCRIBERS_PER_CLIENT` (4) sockets in total. Fix: require
the `clientId` query parameter (a UUID v7 the userscript already sends via `liveClientId` for the
anonymous case; check `apps/userscript/src/presence-client.ts` `open()` and make it always send
it, which I will do on my side: assume `clientId` is present for every connection) and derive
`clientHash` from `tokenHash + clientId` for authenticated connections too, keeping `tokenHash`
for revocation. Reject a missing or malformed `clientId` with 400 for every connection. Test both.

## 4. Binary frames bypass the rate limit (`apps/backend/src/presence-object.ts` `webSocketMessage`)

Non-string frames return before the size check and the per-socket rate limiter, so a client can
send binary frames at any rate and never be closed. Fix: count every frame against the limiter
before the string check, and close binary senders with 1003 (unsupported data). Test it.

## 5. Interest filter ignores a peer's viewport when it has a draft (`presence-object.ts` `relevant`)

`peerRect(peer)` (shared) returns the draft rect when a draft exists, else the viewport, so a
painter with a distant draft becomes invisible to a subscriber standing next to their viewport.
Fix in the backend only: consider a peer relevant when either its draft rect or its viewport
intersects the subscriber's interest rect, and measure distance to the nearer of the two. Test:
a peer whose viewport is near and whose draft is far is still delivered.

## 6. Region request bodies are fully buffered before the size check (`routes/work.ts`)

`await c.req.text()` reads the whole body before comparing its length. Fix: reject early when
`content-length` exceeds `MAX_REGION_REQUEST_LENGTH`, and otherwise read the body stream in
chunks, aborting with 413 as soon as the running byte count passes the limit. Test a
content-length rejection and a chunked over-limit rejection.

## 7. Updating a claim keeps the old `templateId` (`work/regions.ts` `putRegion` / `updateRegion`)

The existing-claim path passes only shape and label to `updateRegion`, so a claim moved onto or
off a template keeps its stale hint. Fix: persist `request.templateId` (validated the same way as
on create) on update. Test: put with template A, put again with null, list filtered by A is empty.

## 8. Oversized shapes in a document (`work/regions.ts` validation)

`regionDocumentBounds()` ignores subtract items, so a document with a 1x1 add and a subtract path
spanning millions of pixels passed the area check while `regionDocumentPixels()` then tried to
allocate the subtractor's whole mask. I have tightened the shared validation: `isRegionShape`
now rejects any path whose node/handle bounds exceed `MAX_REGION_SHAPE_EXTENT` on a side, and
this holds for every item regardless of op. On the backend, add a test that such a document is
rejected with 400 by `PUT /work/regions/:id`, and make sure the route validates every item
through `isRegionDocument` before rasterising anything.

## Verify before reporting

```
pnpm --filter @caelestis/wire-schema test
pnpm --filter @caelestis/backend test
pnpm --filter @caelestis/backend exec tsc -p tsconfig.json
pnpm biome check apps/backend packages/wire-schema
```

If the default pnpm launcher refuses to run, use the installed pnpm binary directly. Report the
exact commands and results, and for finding 2 list the migration file name.
