# Ditherette's WASM core in the userscript

Type: grilling
Status: deferred — v3 or later
Blocked by: 19, 29
GitHub: —

## Question

`mia-cx/ditherette` has a Rust/WASM image-processing core (`crates/ditherette-wasm`, wasm-bindgen,
`cdylib`) doing resize, dither and palette quantisation. Should the userscript ship it, so template
authoring happens where the templates are used?

## Why this fits rather than being a nice-to-have

**It closes a gap two decisions opened.**
`01-template-storage-and-chunk-model` says "a separate existing tool owns creation and palette
quantisation" — that tool is ditherette. The pre-v1 cut has **no frontend on the server**, so template
upload is an admin action taken *in the userscript*. Without this, authoring means: leave wplace, open
ditherette, export, come back, upload. With it, an alliance leader crops, dithers, previews and places
a template against the live canvas in one place.

**It composes with the server rather than duplicating it.** The server quantises on ingest with
nearest-colour, no dithering, no rejection — deliberately, so a near-miss upload is not refused on a
technicality. If the userscript has already dithered to exact palette colours, the server's pass
becomes a no-op and says so: `movedPixels: 0` in the upload report is the client confirming it did the
job. Client-side is the *quality* path, server-side is the *safety net*, and the report is how you
tell which one acted.

**Dithering is the part the server cannot do.** The server maps each pixel independently, because
dithering is a decision about how to trade colour accuracy against spatial noise and that is an
authoring choice, not a validation rule. It belongs with whoever is looking at the result.

## Constraints, in order of how likely they are to kill it

### Single-threaded build, settled

Ditherette builds optimised single- **and** multi-threaded algorithms. **The userscript takes the
single-threaded one**, and that is a decision rather than a limitation to work around.

The multi-threaded build is not available here at any price: `threads` uses `rayon` +
`wasm-bindgen-rayon`, which needs `SharedArrayBuffer`, which needs cross-origin isolation —
`COOP`/`COEP` response headers **on the page**. The userscript runs on wplace.live and cannot set
their headers. Benchmark numbers for the threaded build therefore do not describe anything the
userscript can do, and should not be used to size expectations here.

Worth measuring the single-threaded build against a realistic template before committing: a large
image dithering on the main thread will jank the canvas, so it likely wants a Worker regardless — and
a Worker created from a blob URL has its own CSP questions.

### CSP and grant mode

`WebAssembly.instantiate` is governed by the page's CSP when the script runs in page context, which is
what `@grant none` gives. With any `@grant`, the manager runs it in a sandboxed world where page CSP
generally does not apply — but the details differ between Chrome and Firefox and have moved across MV3
revisions. Check wplace's actual response headers rather than trusting the general claim.

### Delivery

Inlining the `.wasm` as base64 costs ~33% overhead on a single-file script and re-downloads on every
update. `@resource` is the better route: the manager fetches and caches it, and the binary versions
separately from the script.

Alternative worth weighing: serve the `.wasm` from the template server itself. It is already a
Cloudflare Worker with R2, the userscript already talks to it, and it sidesteps the userscript host's
size limits entirely — at the cost of the module no longer being available before a server is added.

## What has to be decided

- **Which functions cross the boundary.** Resize, dither and quantise are three separable steps and the
  userscript may only want some. A narrow surface is easier to keep stable than exposing the crate.
- **Whose palette wins.** Ditherette is the source of our palette (`09-recon-palette`), and both sides
  now hold a copy. If the WASM module carries its own, that is a third copy that can drift from
  `packages/shared`. It should take the palette as an argument rather than embed one.
- **Where it lives in the repo.** `packages/ui` is for shared components; a WASM binary is not that.
  Either a new `packages/dither` wrapping the module with a typed façade, or the userscript owns it
  directly.
- **Whether the frontend later shares it.** Ditherette is already SvelteKit, so a future frontend would
  use the same core — which argues for a package rather than burying it in the userscript.
- **Fallback when it will not load.** CSP refusal, an old browser, a failed fetch. Uploading an
  undithered image still works, because the server quantises anyway — so the honest fallback is "upload
  without dithering and say so", not a broken button.

## Deferred to v3 or later

**Not v1, not pre-v1, and no ditherette or template-creation work happens before v3.** Recorded
because the reasoning is worth keeping, not because it is scheduled — nothing in this ticket should be
read as a task list for the current effort. Nothing before it depends on it: the server accepts any PNG and quantises it, so authoring
stays in ditherette proper until well after the userscript's admin surface exists and has proven
itself.

The destination it points at is bigger than "reuse a library": **authoring templates on wplace
itself, against the live canvas, with a better editor than a separate tool can offer** — because the
editor would be sitting on top of the thing being drawn on. Crop against real neighbours, see the
dither against the actual surrounding pixels, place and nudge the bounding box where it will live.
That is a v3 ambition and is written down here so the v1 decisions do not quietly foreclose it.

Two v1 choices worth keeping compatible with it, at no cost today:

- The palette stays a parameter rather than being embedded anywhere, so a future WASM module cannot
  become a third copy that drifts.
- The server keeps quantising on ingest regardless of what the client did. That is what makes
  client-side dithering an *enhancement* rather than a dependency — and it is why the fallback when
  WASM will not load is "upload undithered and say so", not a broken editor.
