# v1 viewing modes & render scale

Type: prototype
Status: resolved
Blocked by: —
GitHub: https://github.com/mia-riezebos/wplace-template-server/issues/15

## Question

Which viewing modes ship in v1, at what render scale, and how are they presented in the userscript
UI?

The parameterisation is settled (`{ shape, size k, anchor, opacity }` — see `05-rendering-model`).
What is not settled is which combinations are worth exposing and what the controls look like.

- **Which shapes**: square, circle, top-left triangle (replicating wplace's own), diamond? Others?
- **Which anchors** are actually exposed — all 9, or centre + corners?
- **Render scale `S`**: fixed, or adaptive per mode? Adaptive means full-pixel modes cost nothing
  (S=1) and only sub-pixel shapes pay the quadratic memory cost. A triangle at S=3 is 6 pixels and
  looks rough — is S=5 (~100 MB per tile buffer) ever acceptable, and behind what warning?
- **Named presets vs raw sliders.** Raw sliders expose the full space but most people want two or
  three known-good looks. Presets that write into the same parameter object are probably right.
- **Control surface**: where do the pixel-size slider, opacity slider, shape picker, and the
  server/group/template toggle tree live? All UI is userscript-side in v1, so this panel is the
  entire product surface. **Partly answered by
  [29-per-overlay-map-controls](29-per-overlay-map-controls.md)**: per-overlay settings move to a
  button on the map, and this panel keeps the global axis — servers, the tree, and defaults.

Prototype the panel rather than specifying it — this is a "how should it look and behave" question.

## Addition — 2026-08-03: per-colour toggles

The userscript needs **per-colour toggles for the overlay** — show or hide template pixels by
palette colour.

Two uses, one mechanism:

1. **Manual filtering** while working. Someone painting a single colour across a large template
   wants everything else out of the way.
2. **Hide colours I do not own.** `/me` returns `extraColorsBitmap`, so the userscript already knows
   which premium colours the user can actually place. One toggle turns "why can't I place this"
   into a non-question.

**This is nearly free.** Chunks are palette-indexed, so filtering is a per-index lookup during stamp
selection — no extra decode, no extra memory, no per-pixel branching beyond a table read. It is a
direct payoff of storing indexed PNG rather than RGBA.

To decide alongside the rest of this ticket:

- Where per-colour toggles live in the panel relative to the template tree — they are a different
  axis of filtering and cramming both into one list will not work.
- Whether the colour list shows all palette colours or only colours present in the enabled
  templates. The latter is shorter and more useful; it also changes as templates toggle.
- Whether "hide unowned" is a single switch or just a preset over the per-colour toggles.
- Whether progress figures respect colour filters. They should not — hiding a colour is a display
  choice, not a scope change — but it needs saying, because the opposite is a plausible expectation.

## Answer — 2026-08-08: there are no modes, and no render scale

**Every pixel is a square, and the controls deform it.** A mode list turned out to be a handful of
frozen points in that space with worse names — "Dot" is a full-radius stamp at a small size, "Corner"
is a rotated stamp translated into a corner and clipped, and "Full" and "Square" were the same shape
at two sizes, split only because one had a cheaper render path. So the shape picker is gone and what
ships is the space itself:

| Control | Range | Notes |
| --- | --- | --- |
| Size | 0.1–2 | Above 1 is *cropped* by the cell, not drawn larger — which is what makes clean corner wedges and half-cell triangles reachable at all |
| Rounding | 0–1 | 0 is a square, 1 is a circle |
| Offset X / Y | ±1 cell | Applied **before** rotation, so it runs along the stamp's own axes |
| Rotation | 0–90° | 45° turns squares into diamonds |
| Opacity | 0.05–1 | Applied at draw time, so it never forces a re-stamp |

Order is translate-then-rotate, both about the cell's centre, and each stamp is clipped to its own
cell — which is what makes partial corners possible without bleeding into the neighbour.

- **Anchors dissolved into Offset X/Y.** Nine named anchors are nine points on a continuous plane.
- **Render scale `S` does not exist.** There is no per-tile buffer, so the S=5/100MB question is
  moot. Resolution comes from a 64px stamp mask scaled to whatever a cell measures on screen, so the
  shape is resolution-independent in the way a vector is — the earlier design carved shapes out of a
  3×3 pixel block, which is why a "33% stamp" was one blurred device pixel. See `13-render-path`.
- **Raw sliders, plus presets where presets earn it.** The sliders are the whole space; the only
  presets that survived are on the *colour* axis, where they are shortcuts for a set of switches
  (All / Free / Premium / Owned).
- **Two control surfaces, as `29-per-overlay-map-controls` proposed.** The panel owns the global
  axis and the defaults; the per-overlay menu owns one overlay. Appearance later moved to its own
  page behind a palette button rather than living in settings.

### Per-colour toggles, as built

All four sub-questions above are answered:

- They live on their own page, not in the tree — a different axis, as suspected.
- The grid shows **all** palette colours, not just present ones. A list that changes as templates
  toggle is a list you cannot learn.
- "Hide unowned" is a **preset** (`Owned`), alongside All / Free / Premium. `/me`'s
  `extraColorsBitmap` feeds it, and it disables itself rather than lying when we could not ask.
- A per-overlay filter is an **override** of the global set, never a union — an overlay with an
  opinion answers to its own switches only.
- **"Only the selected colour" is a mode, not a preset**: it follows wplace's own selection while
  their drawer is open, writes nothing, and restores whatever was underneath when switched off. It
  and a preset can be lit at once, because they answer different questions.
- Progress and mismatch marking read the **switches**, not what is on screen — `claimedHiddenFor`
  exists precisely to see past the mode. A hand-filtered colour asserts nothing; a colour hidden for
  this minute still does. Which settles the last bullet the way it predicted.
