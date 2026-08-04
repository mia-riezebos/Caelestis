# v1 viewing modes & render scale

Type: prototype
Status: open
Blocked by: 13, 09
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
