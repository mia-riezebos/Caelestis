# Handoff — the userscript render path, browser half

Companion to `handoff.md`, which covers the project as a whole. **This one is for a session on a
machine with a browser and a logged-in wplace account.** The devbox has neither, so everything below
is blocked there.

## Which branch, and how it stacks

Five branches, each based on the one above it. Merge order is strictly bottom-up.

```
main
 └── feat/schema-reland        #34   schema layer
      └── feat/access-tokens   #35   auth
           └── feat/template-ingest      #36   PNG codec, palette, quantise, slice, R2
                └── feat/nodes-and-manifest   #37   seasons, nodes, publication, manifest
                     └── feat/userscript-render-core    ← work here, no PR yet
```

```bash
git fetch --all
git checkout feat/userscript-render-core   # if it exists on the remote
# if it does not, it has not been pushed yet — branch it yourself:
git checkout -b feat/userscript-render-core origin/feat/nodes-and-manifest
pnpm install
```

**Do not rebase the stack.** Each branch is an open PR against the one below it; rebasing one
detaches every PR above it. Add commits on top instead.

If you need the whole stack as one working tree — which you do, to run the server — checking out the
topmost branch is enough. It contains everything below it.

## What is already built, and what is not

Built and green (`pnpm -w test`, ~469 tests):

- The server's whole read surface: `GET /server`, `GET /manifest`, `GET /chunks/:hash`.
- Admin: tokens, nodes, template upload and publish.
- In `@wts/shared`: `decodePng`, `encodeIndexedPng`, the wplace palette with wplace's own indices
  (transparent at 63), `quantiseToPalette`, `sliceTemplate`, `tileKey`/`parseTileKey`.

**The userscript is 18 lines of scaffold.** `apps/userscript/src/main.ts` has a comment describing
the intended shape and no implementation.

Splitting the remaining work by what needs a browser:

| | needs a browser? |
|---|---|
| Tile index — manifest → `Map<TileKey, Placement[]>` | no |
| Chunk store — fetch by hash, decode, cache | no |
| Compositor — stamp template pixels over tile pixels | no |
| **The `fetch` shim, installed before wplace captures `fetch`** | **yes** |
| **Confirming the tile URL pattern and transport** | **yes** |

The first three are pure functions over data and belong in vitest. Only the shim genuinely needs the
live page — so build the rest green first and spend browser time only on what nothing else can
verify.

## Recon the browser session has to do first

The shim cannot be designed without these answers, and none of them can be determined from the
devbox. Record findings in `.scratch/v1/issues/13-render-path.md`.

1. **How does wplace request a tile?** `fetch`, `XMLHttpRequest`, an `<img>` src, or a
   `createImageBitmap` on a `Response`? The interception point differs for each, and a shim on
   `fetch` catches none of the others.
2. **What is the exact tile URL?** `06-recon-tile-serving` records
   `https://backend.wplace.live/files/s{season}/tiles/{x}/{y}.png` — confirm it still holds, and note
   whether the season segment is stable within a session.
3. **Does wplace capture `fetch` early?** If its bundle stores a reference at module scope before our
   `@run-at document-start` runs, patching `window.fetch` afterwards is invisible to it. This is the
   single most likely reason the whole approach fails, so test it before building on it.
4. **What is wplace's CSP?** Read the response headers. Relevant to whether a blob-URL Worker is
   possible later, and to ticket 30's WASM question.
5. **Is the tile response opaque?** Check `Access-Control-Allow-Origin` on the tile CDN. If the
   response is opaque, its pixels cannot be read to composite over — which changes the design from
   "draw over the real tile" to "draw only our chunks and let wplace's own tile show through".
6. **What does a 404 tile look like?** `06-recon-tile-serving` says in-range unpainted tiles are 200
   with a near-empty PNG, and only out-of-range coordinates 404. Confirm, because the render model
   branches on it.

Answering 1, 3 and 5 is enough to know whether the interception model in `05-rendering-model` is
viable at all. Do those before writing any shim code.

## Running the server locally

```bash
cd apps/backend
pnpm exec wrangler d1 migrations apply wts --local
pnpm dev            # wrangler dev, default http://localhost:8787
```

`wrangler.toml` already has `SERVER_ID`, `SERVER_NAME`, `SERVER_DESCRIPTION` as vars. `ADMIN_TOKEN`
is a secret and is **not** set — for local work, add it to a `.dev.vars` file in `apps/backend`
(gitignored):

```
ADMIN_TOKEN=whatever-you-like
```

Then seed something to look at:

```bash
# 1. a node
curl -s localhost:8787/admin/nodes -H 'authorization: Bearer whatever-you-like' \
  -H 'content-type: application/json' \
  -d '{"season":1,"parentId":null,"name":"Test"}'

# 2. a template — nodeId from the response above, originX/originY are canvas pixels
curl -s localhost:8787/admin/templates -H 'authorization: Bearer whatever-you-like' \
  -F png=@some-template.png -F nodeId=<id> -F name=Test -F originX=325000 -F originY=1781000

# 3. publish it
curl -s -X PATCH localhost:8787/admin/templates/<templateId> \
  -H 'authorization: Bearer whatever-you-like' -H 'content-type: application/json' \
  -d '{"published":true}'

# 4. mint a read token for the userscript
curl -s localhost:8787/admin/tokens -H 'authorization: Bearer whatever-you-like' \
  -H 'content-type: application/json' -d '{"label":"userscript","scope":"read"}'

# 5. check what the userscript will see
curl -s localhost:8787/manifest -H 'authorization: Bearer <read token>' | head -c 800
```

`originX`/`originY` are global canvas pixels, not tile-local. Tile `(325, 1781)` starts at
`(325000, 1781000)` — `latLngToCanvasPixel` in `@wts/shared` converts from coordinates if you have
them.

## Building and installing the userscript

```bash
cd apps/userscript
pnpm build          # → dist/wplace-template-server.user.js
pnpm dev            # esbuild --watch
```

The metadata block is generated in `build.mjs`, not written by hand. It already carries
`@run-at document-start`, `@match https://wplace.live/*`, `@connect *`, and the `GM_*` grants.

Install by opening the built file in Violentmonkey, or point it at a `file://` URL and let it track
changes while `pnpm dev` runs.

**Note the grants matter.** Any `@grant` puts the script in the manager's sandboxed context rather
than the page context, which changes both CSP behaviour and whether patching `window.fetch` is even
visible to the page. If recon question 3 says the page captures `fetch` early, the fix may be to drop
to `@grant none` and run in page context — at the cost of losing `GM_getValue` for token storage,
which then needs somewhere else to live that is **not** `localStorage`, since wplace's own scripts
can read that.

## What "working" means for this slice

One template, one server, no toggles, no menus, no telemetry: **an alliance template visibly overlaid
on the wplace canvas, in the right place, at the right colours.**

Everything else in tickets 29 and 14 — the three-dot per-overlay menu, focus, the drawer, viewing
modes, colour filters — comes after that works.
