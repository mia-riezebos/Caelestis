# Backend task: region claims carry a shape (issue #311, round 2)

You implemented the presence backend earlier in this worktree (`apps/backend/src/presence-object.ts`,
`apps/backend/src/work/regions.ts`, `apps/backend/src/work/*region-store*.ts`, the `work_regions`
table, and the presence schemas in `packages/wire-schema/src/index.ts`). The shared contract has
changed: a region claim is now a shape, not only a rectangle. Update the backend and wire schema to
match. Only edit files under `apps/backend/` and `packages/wire-schema/`. Do not run `git commit`,
`git stash`, or `git checkout`. Do not edit `packages/shared/` or `apps/userscript/`.

Read first:

1. `packages/shared/src/region-shape.ts` — `RegionShape` (four kinds), `isRegionShape`,
   `regionShapeBounds`, `regionShapeOutline`, `regionShapeContains`, and the limits
   `MIN_REGION_SHAPE_CORNERS`, `MAX_REGION_SHAPE_CORNERS`, `MAX_REGION_SHAPE_RADIUS`.
2. `packages/shared/src/presence.ts` — `RegionClaim` now has `shape: RegionShape` plus `rect`
   (the bounding box, derived by the server). `RegionClaimRequest` now has `shape` instead of
   `rect`.
3. Your existing files listed above, plus `apps/backend/migrations/0021_amazing_blindfold.sql` and
   `migrations/meta/_journal.json`.

## What to change

### Wire schema

Add an Effect `RegionShape` schema (a union of four structs discriminated on `kind`) whose checks
mirror `isRegionShape` exactly: non-negative integer coordinates, positive sizes, radius within
`1..MAX_REGION_SHAPE_RADIUS`, corners within `MIN..MAX_REGION_SHAPE_CORNERS`, rotation an integer
in `0..359`, star `inner` an integer in `1..r-1`. Update `RegionClaim` and `RegionClaimRequest`
schemas to the new shared types and keep the `assertExact` checks passing for `Type` and
`Encoded`. Add wire tests for one valid and one invalid value of each shape kind.

### Storage

Nothing has been deployed, but local D1 databases may have applied migration 0021, so do not edit
it. Add migration 0022 (generate it with `pnpm --filter @caelestis/backend db:generate`, or write
it by hand and add the journal entry in the same format) that adds a nullable `shape` text column
to `work_regions`. On write, store `JSON.stringify(shape)` in `shape` and `regionShapeBounds(shape)`
in `x`, `y`, `w`, `h`. On read, parse `shape` when present and validate it with `isRegionShape`;
when the column is null or invalid, fall back to `{ kind: 'rectangle', x, y, w, h }` so older rows
still load. Update the memory store the same way.

### Use case and route

`putRegion` validates the request shape (the wire schema already decoded it), derives the bounding
rect, and rejects with a 400 validation error when the rect is outside the surface (reuse
`presenceRectWithinSurface`) or its area exceeds `MAX_PRESENCE_REGION_PIXELS`. The idempotent
re-put rule stays: same id and same claimant returns the stored record; a different claimant is a
409. The `RegionClaim` returned and broadcast includes both `shape` and `rect`.

The presence Durable Object needs no logic change; it serialises whatever the store returns. Check
that `presence-ready` and `regions` events still validate against the updated wire schema in its
tests.

## Tests

Update `apps/backend/src/work/regions.test.ts` (or wherever the region tests live) so the create,
list, idempotent re-put, conflict, and delete cases use shapes, and add: a star claim is stored and
read back with its shape and derived rect; a rectangle row with a null `shape` column reads back
as a rectangle shape; a circle whose bounds leave the surface is rejected with 400; a shape with
an out-of-range radius fails wire decoding with 400.

## Done means

`pnpm --filter @caelestis/wire-schema test`, `pnpm --filter @caelestis/backend test`,
`pnpm --filter @caelestis/backend check`, and `pnpm biome check apps/backend packages/wire-schema`
all pass. Paste the tail of each in your report, list every file you changed, and say clearly if
anything in the contract blocked you instead of changing `packages/shared`.
