# Mismatch marking & the client-side pixel store

Type: grilling
Status: resolved
Blocked by: —
GitHub: —

## Question

Given a template on screen, which pixels disagree with the canvas, how does the userscript know, and
how is the answer drawn?

Written after the fact. The feature was built across a long implementation stretch and never had a
ticket; this records what was decided so the map stops being silent about a whole surface.

## Answer

### What the userscript reads

Three arrays per tile, all palette indices, one byte per pixel, identical geometry:

| Array | Where it comes from | Meaning |
| --- | --- | --- |
| **server** | wplace's tile PNG, captured at `fetch → Blob → ImageBitmap → texImage2D` | what wplace will serve |
| **draft** | wplace's per-tile paint-preview canvas, captured at `putImageData` / `clearRect` | what has been placed locally and not submitted |
| **template** | our own chunk | what is being asked for |

The draft is kept **beside** the server's pixels, never merged into them. Merging needed an override
map to survive the next tile fetch, made a blank preview canvas look like a wiped tile, and put that
bookkeeping on the path that runs while someone is painting. Two arrays and a fallback need none of
it: a re-fetch replaces one and cannot touch the other.

### The comparison

    effective = drafted here ? draft : server
    wrong     = effective !== wanted

with three states on each side rather than two, which is the whole subtlety:

- A **template** pixel of index 63 is a wildcard and asserts nothing (see `09-recon-palette`), as is
  any colour the user has filtered out by hand.
- An **effective** pixel may be a colour, may be nothing, or may be *deliberately* nothing. wplace
  cannot tell us which of the last two: drafting Transparent leaves alpha zero, exactly like a pixel
  nobody has touched. The distinction exists only in their `paint-crosshair-annotations` custom
  layer — 200×200 `Uint8Array` patches, one non-zero entry per drafted pixel — so that is where we
  read it from, and a pixel drafted empty is stored as a real index rather than the absence
  sentinel. Reconciling against those patches is what turns "drafted Transparent" into a change at
  all, since the canvas write itself is a no-op.

Two lists come out, not one: pixels with the **wrong colour** on them, and pixels with **nothing** on
them. Which is a display decision, not a property of the tile — see the threshold below — so both are
computed always and the choice is made when the answer is read.

### Marking unpainted pixels

Off by default, and qualified by how much is left. On a template nobody has started, marking the
remainder marks the template — the answer is already visible in that none of it is built. It earns
its keep at the other end, where the marks *are* the list of what is left. So the switch is gated on
the unpainted share of the template, default 5%, capped at 20% because past a fifth the marks stop
being a to-do list whatever the number says.

Measured **per template**, summed over the tiles that have been scanned: a template is only ever
partly loaded, and the tiles in front of someone are the ones the answer is about.

### How it is drawn

A crosshair per mismatched pixel, at a **stable device-pixel size** (9px) regardless of zoom — a
marker that scales with the map is invisible when zoomed out and enormous when zoomed in, and the
thing it points at is a single pixel either way. `GL_POINTS` gives that for free, since `gl_PointSize`
is in device pixels.

**On the CPU, as a list — not in a shader.** The first attempt asked the question per fragment, which
made the cost scale with screen area rather than with the number of answers and took the GPU down
hard enough to kill the compositor. A template has a handful of wrong pixels and the screen has
millions of fragments.

Markers live in a layer of their own, above wplace's draft layers and below their cursor crosshair.

### Where the work happens

Scans run in a **worker**, built from the comparison function's own `toString()` behind a Blob URL —
a userscript is one file with nowhere to put a second. Jobs carry only the tile rows the template
covers, sliced out and transferred; a template's pixels cross once and stay. Everything about it is
allowed to fail, and each failure falls back to scanning on the main thread against a per-frame
budget.

Between scans the cached answer is **patched a pixel at a time** from the same canvas writes that
told us a pixel changed. That is what makes a marker clear the instant the right colour is drafted,
rather than a million comparisons later.

## Relationship to the server

None, in v1. This reads wplace's canvas directly and answers a question about what is on screen right
now. It is *not* the tile ground truth `04-telemetry-model` and `17-server-tile-store` describe —
those are about progress and grief detection over time, computed server-side from snapshots. Whether
the client's captured pixels are ever worth reporting upward is an open question and belongs to the
telemetry write path, not here.
