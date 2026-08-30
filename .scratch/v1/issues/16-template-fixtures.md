# Real template fixtures

Type: task
Status: completed
Blocked by: —
GitHub: https://github.com/mia-riezebos/wplace-template-server/issues/17

## Question

Snapshot every generated BlueMarble JSON template from Mia's Berrycamp fork into this repo as test
fixtures. The source is `mia-riezebos/berrycamp.github.io`, branch `dev`, under
`wplace-templates/quantized/rooms/`.

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

## Acceptance criteria

- [x] All Berrycamp BlueMarble JSON exports are available under a stable fixture path in this
      repository without redundant standalone PNGs.
- [x] Provenance records the source repository, commit, tree hash, and copied inventory.
- [x] Automated validation detects missing or changed fixture files.
- [x] Contract tests exercise a transparent template, exact-palette decoding and quantisation, and
      a template whose placement spans multiple wplace tiles.
- [x] Documentation explains that Berrycamp already quantises the images and emits BlueMarble
      placement metadata.

## TODOs

- [x] Snapshot the Berrycamp fixture corpus and record exact provenance.
- [x] Add corpus integrity validation and representative real-template contract tests.
- [x] Run repository validation and record the completed fixture contract.

## Notes

- Source commit: `3690d394e2b01856054a46c6d213894e7bdbc3cf`.
- Source `wplace-templates` tree: `09fd6f9ed5370dc6cfc37ad36cb9b50ae6558d0a`.
- The fixture selection contains 92 BlueMarble JSON files with 92 templates and 192 positioned PNG
  blobs (about 31 MiB). Standalone PNGs are redundant because the JSON owns both image data and
  placement.
- The old off-palette rejection requirement no longer matches production. The backend accepts RGBA
  uploads and quantises them; these fixtures instead prove that Berrycamp's output already reports
  zero moved pixels.
- `pnpm test:fixtures` verifies all 92 checksums and validates the 192 embedded PNG blobs. The
  Prologue contract test decodes its four real BlueMarble tiles and checks their recorded placement.
- Validation passed: `pnpm test`, `pnpm check`, `pnpm build`, `pnpm lint`, and `git diff --check`.
