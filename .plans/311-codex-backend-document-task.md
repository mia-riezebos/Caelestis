# Backend task: region claims are vector documents (issue #311, round 4)

You implemented the presence backend and region claims in this worktree (`apps/backend/src/work/
regions.ts`, `apps/backend/src/work/*region-store*.ts`, `apps/backend/src/presence-object.ts`, the
presence schemas in `packages/wire-schema/src/index.ts`). The claim model changed once more, and
this is the final shape of it: a claim is a small **vector document** of shapes that add to or
subtract from the claimed pixels, kept editable. The server still only validates and derives
bounds; it never rasterises.

Only edit files under `apps/backend/` and `packages/wire-schema/`. Do not run `git commit`,
`git stash`, or `git checkout`. Do not edit `packages/shared/` or `apps/userscript/`.

Read first: `packages/shared/src/region-shape.ts` and the `RegionClaim` / `RegionClaimRequest`
types in `packages/shared/src/presence.ts`.

- `RegionShape` now has a fifth kind, `path`: `{ kind: 'path', nodes: PathNode[], closed: boolean,
  width: number }`, where `PathNode = { x, y, in?: Point, out?: Point }` with finite numbers (not
  necessarily integers) bounded by 4,000,000 in absolute value; `width` in `0..MAX_STROKE_WIDTH`;
  an open path needs `width > 0`; node count in `(closed ? 3 : 2)..MAX_PATH_NODES`.
- `RegionItem = { id: string (1..64 chars), shape: RegionShape, op: 'add' | 'subtract' }`.
- `RegionDocument = { items: RegionItem[] }` with `1..MAX_REGION_ITEMS` items and unique ids.
- `RegionClaim.document: RegionDocument` replaces `shape`. `RegionClaimRequest.document` replaces
  `shape`. `rect` stays as the server-derived bounding box, now from `regionDocumentBounds`, which
  returns null when no item adds anything (reject that with 400).

## What to change

- Wire schema: `PathNode`, `Point`, the `path` branch of `RegionShape`, `RegionItem`,
  `RegionDocument`; `RegionClaim` and `RegionClaimRequest` carry `document`. Mirror `isRegionShape`,
  `isRegionItem`, and `isRegionDocument` from shared exactly, and keep every `assertExact` passing
  for both `Type` and `Encoded`.
- Storage: keep the existing `shape` text column and store `JSON.stringify(document)` in it (no
  migration needed for that). On read, parse it: if it validates with `isRegionDocument` use it;
  if it validates with `isRegionShape` (a row written before documents existed) wrap it as
  `{ items: [{ id: 'legacy', shape, op: 'add' }] }`; if it is null or invalid, wrap the row's
  `x, y, w, h` as a rectangle the same way. Update the memory store the same way. `updateRegion`
  takes a document now.
- `putRegion`: validate `request.document` with `isRegionDocument`, derive
  `rect = regionDocumentBounds(document)`, 400 when null, then the existing checks: rect within
  the surface (`presenceRectWithinSurface`), `rect.w * rect.h <= MAX_PRESENCE_REGION_PIXELS`, the
  optional template hint. Same-claimant or admin re-put updates the document and label in place.
- The presence Durable Object needs no logic change; check its tests still validate the `regions`
  and `presence-ready` payloads against the new schema.

## Tests

Update the region tests to documents: create, list, read back with the same items, idempotent
re-put, update by claimant, conflict, delete. Add: a document mixing a star, a subtracted
rectangle, and an open stroked path round-trips; a legacy single-shape row reads back wrapped in a
document; a document with only subtractions is a 400; a path with an invalid node fails wire
decoding; `regionDocumentBounds` matches the stored `rect`.

## Done means

`pnpm --filter @caelestis/wire-schema test`, `pnpm --filter @caelestis/backend test`,
`pnpm --filter @caelestis/backend check`, and `pnpm biome check apps/backend packages/wire-schema`
pass. Paste the tail of each, list every file changed, and say clearly if anything blocked you.
