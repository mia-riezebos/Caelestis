# Backend task: accept the raster region shape kind

Repo: this worktree, branch `t3code/add-collaborative-websocket-editing`, PR #362. Do NOT commit or
stage anything; leave the diff in the working tree and report what you changed and how you verified
it. Only touch `apps/backend` and `packages/wire-schema`. Do not touch `packages/shared` (already
done and built), the userscript, or the ui package.

## What changed in shared

`packages/shared/src/region-shape.ts` gained a sixth `RegionShape` kind:

```ts
| {
    readonly kind: 'pixels'
    readonly x: number
    readonly y: number
    readonly w: number
    readonly h: number
    /** Row-major bitmask over the box, base64, MSB first (see bitmask.ts packBits). */
    readonly mask: string
  }
```

Validation in `isRegionShape`: the box is an integer box like rectangle/ellipse (`x, y >= 0`,
`1 <= w, h <= MAX_REGION_SHAPE_EXTENT`), `w * h <= MAX_RASTER_BITS` (262_144, exported from
shared), and `isPackedBits(mask, w * h)` from `bitmask.ts` (length `ceil(ceil(bits/8)/3)*4` and
base64 alphabet). `REGION_SHAPE_KINDS` now starts with `'pixels'`. `regionShapePixels`,
`regionShapeBounds`, `translateRegionShape`, `regionShapeContainsPixel`, and `regionShapeOutline`
all handle it. Shared is built; import from `@caelestis/shared` as usual.

## What to do

1. `packages/wire-schema/src/index.ts`: add the `pixels` member to the `RegionShape` union so that
   the `assertExact<Exact<Schema.Schema.Type<typeof RegionShape>, Shared.RegionShape>>()` check
   still holds. Use the existing `RegionBox` fields plus a `mask: Schema.String` bounded to the
   largest packed length for `MAX_RASTER_BITS` bits (`ceil(ceil(262144/8)/3)*4 = 43_696`
   characters). The union's existing `.check(booleanFilter(isRegionShape, ...))` already enforces
   the exact mask length and alphabet per shape, so a bounded string is enough at the field level.
2. Backend: make sure region claim validation (`PUT /work/regions/:id`, the region store, and
   whatever rasterises or bounds a document server-side) accepts a document containing a `pixels`
   item and derives its rect correctly. Look for any place that switches on `shape.kind` or lists
   kinds and add the case; `regionDocumentPixels` / `regionDocumentBounds` from shared should
   already cover the rect. Keep the existing `MAX_PRESENCE_REGION_PIXELS` area check.
3. Tests: in `packages/wire-schema/src/index.test.ts` add a case that a valid `pixels` shape
   decodes and that a mask of the wrong length or a box over `MAX_RASTER_BITS` is rejected. In the
   backend region route tests (`apps/backend/src/presence/routes.test.ts` or wherever
   `PUT /work/regions/:id` is exercised) add a happy path saving a document with one `pixels` item
   and reading it back with the same mask, plus a rejection of a wrong-length mask.

## Verify before reporting

```
pnpm --filter @caelestis/wire-schema test
pnpm --filter @caelestis/wire-schema exec tsc -p tsconfig.json
pnpm --filter @caelestis/backend test
pnpm --filter @caelestis/backend exec tsc -p tsconfig.json
pnpm biome check apps/backend packages/wire-schema
```

If the default pnpm launcher refuses to run, use the installed pnpm binary directly as you did
before. Report the exact commands and results.
