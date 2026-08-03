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
  entire product surface.

Prototype the panel rather than specifying it — this is a "how should it look and behave" question.
