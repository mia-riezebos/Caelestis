# #311 Explore region claims and live painter viewport indicators

## Summary
Painters on the same artwork cannot see where the others are. Add a Google Docs style presence
channel over WebSockets: each online painter shares the world-pixel rect their viewport covers and
the rect (plus a small bitmask) of the pixels they have drafted. Painters can also claim a region of
a template; claims are the only thing stored in the database. The userscript draws all three under
the template layer as low-opacity tinted rects so finished art covers them. Everything is toggleable.

## Acceptance criteria
- [ ] Other online painters' viewports draw beneath the artwork as a dashed, very low opacity rect in their colour.
- [ ] A painter with an open draft draws as a solid, slightly more opaque rect over the drafted pixels' bounds; drafted pixels inside it are tinted.
- [ ] Region claims persist in D1, list per template, and draw as a solid low-opacity region with the claimant's name.
- [ ] A painter can claim the region they are looking at, or their draft's bounds, and release their own claims.
- [ ] Indicators disappear within a few seconds of the painter closing the tab or losing the socket.
- [ ] Sharing my viewport and showing others' indicators are separate toggles that persist.
- [ ] Traffic stays bounded: one upstream message per 2 s at most while panning, 1 s while drafting, a 30 s heartbeat otherwise; each downstream tick carries at most 64 nearby peers.

## TODOs
- [x] Shared presence contract: types, limits, rect helpers, and mask encoding in `packages/shared/src/presence.ts` with tests.
- [x] Backend (Codex): `PresenceObject` Durable Object with hibernating sockets, `/telemetry/presence` upgrade route, wire-schema events, interest-managed 1 s broadcast tick, region claim table plus `/work/regions` routes, tests.
- [x] Userscript presence client: open the socket per connected server, throttle viewport and draft publishing, keep peer state, and reconnect.
- [x] Userscript presence GL layer: draw peer viewports, drafts, and region claims beneath the template layer.
- [x] Userscript controls: share and show toggles in the panel, claim and release region actions, claimant labels.
- [x] Changesets for backend and userscript; run backend, userscript, and shared tests, typecheck, and lint.

### Review round 2: a region claim tool with shapes
- [x] Shared `RegionShape` contract (rectangle, ellipse, polygon with corner count, star with point count and inner radius) as whole-pixel sets: scanline rasteriser, bounds, pixel hit test, translate, with tests; claims carry a shape and a server-derived bounding rect.
- [~] Backend (Codex): shape column and migration, wire schemas, shape validation on `PUT /work/regions/:id`, same-claimant update on re-put, tests.
- [x] Userscript claim rendering: claims and the tool preview rasterise to nearest-sampled masks with crisp edge pixels.
- [x] Userscript claim tool: a mode that works in explore and paint, captures pointer input over the map, draws the chosen shape by drag, selects your saved claims on click, moves them with ⌘ or Ctrl drag, exposes resize and inner-radius handles, Enter saves, Delete removes, Escape leaves.
- [x] Claim tool toolbar element in `@caelestis/ui`: shape picker, corner and point inputs, pixel count, save, delete, cancel; entry from the In progress drawer and the M and L keys.
- [x] Tests for the tool (8), presence layer order (4), shape maths (6); typecheck, lint, full suites.

## Notes
- The existing `/telemetry/live` socket in `StatusReadModelObject` is capped at 256 subscribers per season and already carries tile uploads. Presence gets its own Durable Object keyed by season and surface so it can hold thousands of hibernating sockets without touching the status model.
- Cloudflare bills incoming hibernated WebSocket messages at 20:1 against requests and does not bill outgoing ones, so the client is the throttle point. Server ticks batch changes and only send peers whose rect intersects the subscriber's viewport padded by one tile.
- Draft masks live only in Durable Object memory. After hibernation the 30 s client heartbeat restores them; attachments carry rects only, keeping under the 2 KiB attachment limit.
- Region selection reuses what the painter already has: the current viewport or the draft bounds. No new drag gesture.
- Codex runs with `gpt-6-astra` on the backend while I build the userscript side. It does not commit; I review the diff and commit it.
- The userscript has its own `ServerInfo` parser in `server-manifest.ts`; the `presence` flag had to be added there as well as in shared, or the capability was dropped on read.
- Mia's round-2 review: region claims are a tool with shapes (rectangle, ellipse, polygon, star), usable in explore and draft; M opens it with a rectangle and L with an ellipse; hover, click to select, ⌘-drag to move, Delete removes; shapes must be nearest-neighbour and aliased with no half pixels. L used to toggle the Wplace theme; that moved to N.
- Pixel exactness: every shape is defined by integers and rasterised by pixel-centre membership in shared; the GL layer uploads that mask as an R8 texture with nearest sampling, so the tint stops on pixel edges. Circles became ellipses defined by a whole-pixel box for the same reason.
- Mia's round-3 review: your own claims draw as outline only, under the art, unless the claim tool is open; others' claims and viewports keep their current look.
- Mia's review: viewports must not hide under the art; only drafts and claims do. Two custom layers now share one program: `caelestis-presence` below the outline and pixel art, `caelestis-presence-viewports` above the markers and below Wplace's crosshair.
- Presence is world-surface only in this slice. Alliance artboards are a separate canvas and keep no presence socket yet.
- Validation so far: shared presence tests (7), userscript presence client (10) and geometry (8) tests, plus state, layer, manifest, panel, and main suites; userscript `tsc` and ui `svelte-check` clean.
- Codex backend report, verified locally: wire-schema 180 tests, backend 628 tests, backend `tsc`, and biome all pass. Full userscript suite 1340 tests, ui 140 tests, frontend `svelte-check` clean.
- Codex flagged two contract limits: `PresenceRect` cannot express negative alliance HQ coordinates, and read-scoped credentials never see peers because their updates are ignored. Both are acceptable for this world-only slice; alliance presence needs a signed rect later.
- Revocation reaches hibernating presence rooms through the status object: connecting a revocable token records the room key there, and `closeCredential` fans out to it.
- The D1 migration `0021_amazing_blindfold.sql` creates `work_regions`; it applies on deploy and has not run in production yet.
- Not verified in a browser: no running Wplace session with a presence-capable server exists yet. First real check after deploy: two tabs, same server, each should draw the other's dashed viewport and see the headcount in the In progress drawer.
