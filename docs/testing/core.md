# Core test rewrite map

This is the Phase 1 map for `@caelestis/shared`, `@caelestis/wire-schema`, and
`@caelestis/storage`. It was made from production exports and package scripts only;
existing tests, helpers, and their history are deliberately out of scope.

The default suite must stay fast. Coverage numbers are diagnostic only. Each test below
exists to protect a public result, accepted wire value, persisted object, or adapter
guarantee.

## Shared

| Production module | Public contract to protect | Fresh coverage boundary |
| --- | --- | --- |
| `backfill.ts` | Archive/backfill types describe explicit gaps as `null`, immutable bases, and job progress. | Compile-time import/type use through backend consumers; no runtime-only test. |
| `bitmask.ts` | Base64 is canonical; bit packing is MSB-first; unpack requires the exact byte length. | Unit round trips for partial bytes and invalid alphabet, padding, and length. |
| `client-metrics.ts` | CORS-safelisted `Accept` encoding is bounded and parsing is conservative. | Unit encode/decode valid dimensions, malformed/unknown parameters, and comma-separated headers. |
| `count.ts` | Exact, compact, and pixel-count formatting preserve magnitude and locale. | Unit boundary table around compact rounding and bigint/locale output. |
| `hash.ts` | `sha256Hex` returns lowercase SHA-256 for portable bytes. | One known digest vector. |
| `index.ts` | Package root exposes the supported public API. | Compile-time smoke import only; individual module contracts carry behavior. |
| `live.ts` | Tile upload framing separates bounded JSON header and bytes; server events are frame-safe; snapshots assemble only one complete bounded transfer. | Unit binary round trip plus malformed length/JSON/oversize rejection; snapshot ordering, duplicates, expiry/reset, and completion. |
| `live-paint.ts` | Paint reports partition into bounded ordered base64 parts; assembler rejects contradictory/expired/excessive input and emits once. | Unit partition/reassemble, malformed base64, missing/duplicate/conflicting parts, size/part bounds, TTL cleanup. |
| `manifest.ts` | Manifest and template interfaces retain nullability, time units, chunk hashes, and surface semantics. | Compile-time consumer fixture through wire-schema; no runtime logic here. |
| `mismatch-mask.ts` | CMM1 encodes a tile-local rectangle and four 2-bit classes; decoder rejects non-canonical data. | Unit round trip including odd pixel count and lookup; bad magic, dimensions, length, and reserved class. |
| `palette.ts` | The 64 wplace entries, index ordering, free/premium split, and transparent index are stable protocol data. | One snapshot-like literal contract: size, transparent final entry, representative fixed indices, and RGB/index alignment. |
| `png.ts` | Decodes 8-bit non-interlaced grey/RGB/indexed/GA/RGBA PNG to straight RGBA; canonical indexed files can retain indices; encoder writes the canonical 64-entry palette. | Hand-built minimal PNG fixtures cover every supported colour type, all five filters, indexed `PLTE`/`tRNS`, grey/RGB transparency, encoder→indexed-decoder round trip, non-canonical indexed fallback, and abort. Reject bad signature/chunk layout, missing IHDR/IDAT/PLTE, unsupported depth/type/interlace/filter/index, bad zlib, truncation, and inflated data shorter or longer than declared dimensions. Resource tests use declared dimensions as the only bound: a tiny header with an over-inflating stream proves streaming rejection; arithmetic/allocation-overflow dimensions prove a `PngError` rather than an arbitrary application pixel cap. |
| `presence.ts` | Rect geometry, grid quantisation, draft masks, and deterministic user colours agree with presence messages. | Unit geometry matrix, draft encode/decode and invalid masks/counts, structural guards, stable colour selection. |
| `quantise.ts` | RGBA maps to the nearest palette entry, alpha below 128 is absent, and report totals describe the mapping. | Unit transparent threshold, exact/near/tie palette choices, repeated colours, and all report fields. |
| `region-shape.ts` | Valid editable shapes remain bounded; geometry, rasterisation, subtraction, components, and containment agree at pixel centres. | Unit representative rectangle/ellipse/polygon/star/path/pixel masks; invalid limits; outline/bounds/translation; raster round trip; document add/subtract and diagonal components. Use small shapes in default tests and one separate near-limit work-budget check. |
| `shortcuts.ts` | Keyboard strokes normalize, match/release, persist bounded overrides, resolve defaults, assign without collisions, and render platform labels. | Unit browser-independent stroke fixtures for modifiers, repeated keys, invalid persisted data, conflicts, and mac/windows labels. |
| `slice.ts` | Placed indexed artwork becomes only non-empty tile chunks, with painted bbox and denominator; unsupported placements fail loudly. | Unit transparent margins, sparse cross-tile artwork, tile seams, input mismatch, invalid/non-integral origin, and all canvas edges. |
| `slug.ts` | Node slugs normalize Unicode and replace astral code points predictably. | Small Unicode/whitespace/punctuation table. |
| `tags.ts` | Tags normalize names and reject invalid, duplicate ids/names, and excess entries. | Unit NFC/case-fold identity and acceptance/refusal boundaries. |
| `telemetry.ts` | Shared telemetry types define wire payload nullability and protocol versions. | Compile-time fixture decoded by wire-schema; no runtime code here. |
| `template-filters.ts` | Filter parsing/search and URL-state changes have stable visible selection semantics. | Unit query parsing, unknown values, multi-filter intersection, and canonical URL params. |
| `template-sort.ts` | Sort keys give deterministic template ordering. | Unit ties and each declared sort mode. |
| `template-surface.ts` | World/alliance surfaces validate pairings, map to bounds, compare, and form stable keys. | Unit every kind, invalid alliance id, equality, bounds, and key. |
| `tiles.ts` | Tile keys and Web Mercator/canvas transforms stay canonical; timelapse capture plans have bounded, deduplicated coverage. | Unit key edge cases, coordinate round trips/tolerance at equator and Mercator limits, wrapping, capture seams/aspect, inclusion, cap, and deduplication. |
| `time.ts` | Branded seconds/millis are compile-time units. | Compile-time use only. |
| `uuid.ts` | UUIDv7 is lowercase/canonical and monotonically ordered within equal milliseconds. | Controlled clock/randomness unit test for shape, timestamp bits, same-millisecond increment, clock advance, and payload rollover. |
| `work.ts` | Work filtering, claimant extraction, and structural guards preserve status/priority/identity constraints. | Unit filter combinations and invalid boundary objects. |
| `work-client.ts` | Optimistic work mutations update collection state, reconcile responses, and roll back failed actions. | Unit a real in-memory `WorkCollection` with controlled fetch outcomes: create/edit/claim/release/assign, response replacement, rejection, and concurrent stale response. |

## Wire schema

`packages/wire-schema/src/index.ts` is one production module. Test schemas through
`Schema.decodeUnknown`/`encode` at its public exports, using compact valid factories owned by the
new suite. Every case below has an accepted base value plus one focused invalid mutation.

| Schema group | Contracts and boundary cases |
| --- | --- |
| Presence and region (`PresenceRect` through `PresenceServerEvent`) | Integer/area/string/array ceilings; optional versus explicit `null`; draft masks; session and UUID shapes; every event discriminator; region shape/item/document structural validity; claim expiry and ownership fields. |
| Manifest catalog (`ServerInfo`, `Node`, `Chunk`, `Template`, `Manifest`) | UUID/hash/time ranges, canonical world/signed tile keys, path Unicode and ASCII-only folding, parent adjacency and unique paths, compatibility flags (`liveSync`/`liveSyncMax`), optional tags/surface/work revision, null node ids, finished timestamps, unique tiles/chunks, bbox wrapping, chunk-to-bbox intersection, total-pixel capacity, and aggregate manifest bounds. Include legacy omissions that must decode and contradictory nullability that must not. |
| Paint and live input (`PaintPixels` through `LiveSyncClientEvent`) | Equal pixel vectors, local/global coordinate limits, no duplicate pixels/tiles, painted ≤ submitted, optional delivery ids, offer/recipient caps, part index/total/chunk limits, unique projections, and subscription uniqueness/ranges. Decode every v1/v2 event form to protect compatibility. |
| Status and telemetry responses (`TileOfferBatch` through `AlarmsResponse`) | Nullable success/error outcomes, counter ordering, sorted/unique lists, aligned history/day buckets, resolution ladders, response-pair optionality, bounded collections, frame order, and alarm time ordering. Cover decoder/encoder round trips for each response family and invalid mutations for each cross-field invariant. |
| Type agreement | Retain `tsc -p tsconfig.check.json`; its exact type assertions protect shared/wire nullability and field compatibility without duplicate runtime assertions. |

## Storage

| Production module | Public contract to protect | Fresh coverage boundary |
| --- | --- | --- |
| `index.ts` | Keys cannot escape a namespace; list prefixes and page limits are bounded; `ObjectStorage` return null semantics are uniform. | Unit invalid keys/prefixes/page limits, plus the shared adapter contract below. |
| `filesystem.ts` | Objects preserve bytes/info/metadata/content type; `ifAbsent` is atomic; deletes are idempotent; listing is byte-sorted and cursor-exclusive; corrupt/truncated files fail. | Run the adapter contract against a fresh temp directory. Add a focused two-writer create race and crafted corrupt header/body files. |
| `r2.ts` | R2 binding maps object metadata, conditional creation, batched deletes, and continuation pages into `ObjectStorage`. | Run the same contract against an ephemeral Miniflare R2 binding; add binding-spy tests for `onlyIf`, metadata copy, 1,000-key delete chunks, and truncated cursor propagation. |
| `s3.ts` | S3 commands map metadata, quotes, 404/412, pagination, delete errors, and conditional writes into the common contract. | Run the shared semantic contract against a local S3-compatible endpoint when explicitly requested; default unit tests use a narrow transport seam/command spy to prove request and response mapping without credentials or network. |
| `node.ts` | Environment selects filesystem defaults or validates/builds S3 configuration. | Unit environment matrix for defaults, required bucket, force-path-style validation, endpoint/region fallbacks, and unsupported adapter. |

The shared storage contract performs: missing `head`/`get`; put then `head`/`get` exact
bytes and metadata; replacement; `ifAbsent` winner/loser; duplicate/missing delete; ordered
prefix pages with a cursor; invalid inputs. It runs unchanged for filesystem and R2. S3 gets the
same contract only in its explicitly selected integration command, because it requires a compatible
service.

## Execution plan

Default fast commands after implementation:

```sh
pnpm --filter @caelestis/shared test
pnpm --filter @caelestis/wire-schema test
pnpm --filter @caelestis/storage test
pnpm --filter @caelestis/shared check
pnpm --filter @caelestis/wire-schema check
pnpm --filter @caelestis/storage check
```

Separate, opt-in checks:

```sh
CAELESTIS_TEST_S3_ENDPOINT=http://127.0.0.1:9000 \
  pnpm --filter @caelestis/storage test -- --project s3-integration
pnpm test
```

`pnpm test` remains the repository-wide final check, not a routine loop for this rewrite.

### Explicit execution exclusions

- Do not set a coverage threshold or add cases to raise a percentage; reports only identify gaps.
- Do not allocate images at a synthetic maximum size. PNG resource safety is defined by each
  file's declared dimensions and streaming byte count, so small malicious streams and overflow
  headers exercise the contract without inventing a product limit or exhausting CI.
- Do not fuzz PNG, run multi-megabyte compression benchmarks, or rasterise maximum-size region
  documents in the default suite. They measure platform capacity, not a stable functional result;
  retain a single opt-in near-limit region check if performance work needs it.
- Do not require a networked S3 service, browser, deployment, or production-like credentials for
  default package tests. Miniflare R2 is local; generic S3 parity is opt-in because endpoint
  behavior and startup cost are external.
- Do not test type-only declaration modules at runtime. `tsc` and real schema consumer fixtures
  are the meaningful boundary for `backfill`, `manifest`, `telemetry`, and `time`.

## Phase 2 file plan

- Replace package-local inherited tests with focused `*.test.ts` files beside the modules above.
- Add only suite-owned factories/builders under `packages/wire-schema/src/test/` and
  `packages/storage/src/test/`; no production exports or shared global test state.
- Add a storage Vitest project/config only if needed to keep the opt-in S3 integration test out of
  the default command. The existing package scripts already provide the fast command surface.
