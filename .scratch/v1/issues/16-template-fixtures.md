# Real template fixtures

Type: task
Status: open
Blocked by: —
GitHub: https://github.com/mia-riezebos/wplace-template-server/issues/17

## Question

Get a handful of real, already-quantised templates out of the existing creation tool and into this
repo as test fixtures.

Nothing downstream can be validated without them — upload validation, slicing, chunk hashing,
decode, and rendering all need genuine input rather than something synthesised from guesses.

Wanted:

- 2–3 templates of meaningfully different sizes, including at least one that **spans multiple tiles**
  so slicing is exercised at a real boundary.
- One with transparency, so the transparent-index path is covered.
- One deliberately **invalid** file (an off-palette pixel) so upload rejection can be tested.
- Whatever metadata the creation tool already emits alongside the image — placement coordinates in
  particular, since the server needs to know where a template sits.

Record where they live, and note anything the creation tool already does that the server should
therefore not redo.
