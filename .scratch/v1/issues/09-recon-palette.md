# Recon: wplace colour palette

Type: research
Status: resolved
Blocked by: —
GitHub: https://github.com/mia-riezebos/wplace-template-server/issues/10

## Question

What is the exact wplace palette, and how should transparency and unavailable colours be handled?

- The full ordered colour list with exact RGB values, and wplace's own index for each.
- Free vs premium/paid colours — does the split matter for validation or for progress accounting?
  (A template using a colour a given member cannot place is a real UX problem.)
- How transparency is represented on the canvas, and which index if any is reserved.
- Is the palette stable, or does it grow? If it grows, uploads validated today must not break later.

Output should be a machine-readable list we can commit as the validation source of truth, since
upload rejects any pixel outside it.

## Partial answer — 59 colours recovered from a real template, 2026-08-03

Extracted by clustering the pixels of a native `.wplace` file (see `28-native-wplace-format`). The
image had ±2 noise on every channel from a quantiser bug, but the underlying modes are exact palette
values — 59 clusters account for **100.000%** of pixels.

**A subset, not the full palette**: only colours this particular artwork used. Premium colours the
author does not own, and any colour simply unused here, are absent. Treat as a floor.

```
#000000 #0C816E #0F799F #10AE82 #13E1BE #180006 #28509E #333941 #3C3C3C #4093E4
#4A4284 #4A6B3A #5A944A #600018 #60F9F4 #684634 #6D643F #6D758D #780C99 #787878
#7A71C4 #7B6352 #7DC7FF #84C573 #948C6B #95682A #99B1FB #9B5249 #9C8431 #9C846B
#A50E1E #AA38B9 #AAAAAA #B3B9D1 #B5AEF1 #BBFAF2 #C5AD31 #CB007B #CDC59E #D18051
#D18078 #D2D2D2 #D6B594 #DBA463 #E0A1F9 #E45C1A #E8D45F #EC1F80 #ED1C24 #F38DA9
#F7DB3B #F8A90A #F8B277 #FA8072 #FAB6A4 #FF7F27 #FFC5A5 #FFFABC #FFFFFF
```

These match the swatches in wplace's own paint UI. Still needed for the authoritative list: the
**order** (wplace palette *indices*, which is what the paint request sends in `colors`), the free
versus premium split, and how transparency is represented.

The ordering matters most — the paint body carries indices, not RGB, so a list without indices cannot
classify a paint report.

## Answered — 2026-08-04: the ordered palette, from ditherette

Source: `mia-cx/ditherette`, `src/lib/palette/wplace.ts`. **31 free colours at indices 0–30, 32
premium at 31–62, transparent at 63** — a 64-entry palette. Committed to `packages/shared/palette.ts`
as `WPLACE_PALETTE`, carrying index, hex, RGB and free/premium kind. That resolves both open items:
the ordering and how transparency is represented.

Names in that file are known to lag wplace's own labels; the hex values are good and are what was
taken.

### The 59-colour recovery above was wrong, not merely short

This ticket recorded that "the image had ±2 noise on every channel ... but the underlying modes are
exact palette values". That claim does not hold, and the difference matters because those values were
the validation source of truth:

- **Five entries sat 1–2 off the real colour** — `#F8A90A` for `#F6AA09`, `#F7DB3B` for `#F9DD3B`,
  `#60F9F4` for `#60F7F2`, `#E0A1F9` for `#E09FF9`, `#CB007B` for `#CB007A`.
- **`#180006` is not a wplace colour at all**, sitting 24 from black — a spurious cluster.
- **Ten real colours were missing**, being ones that artwork did not use.

Clustering recovers modes, and the mode of a noisy distribution is not the value that generated it.
Under the old rule — reject anything not exactly palette-conformant — five real colours would have
been rejected and one non-colour accepted.

The free/premium split also arrives with this, which `14-v1-viewing-modes` needs for "hide colours I
cannot place".

## Resolution — 2026-08-08: settled, with two sentinels the palette itself does not carry

`WPLACE_PALETTE` is the source of truth and has been in use across the renderer, the comparison and
the picker since. Two conventions built on top of it are worth recording here, because both are ours
rather than wplace's and both are easy to misread as palette facts:

- **Index 63 is a wildcard in a template, not a colour.** wplace *do* let you paint their transparent
  slot, so 63 is a real thing to place — but a template storing it would be demanding the canvas be
  *erased* there, which is a far stronger claim than templates make. So the overlay draws nothing
  over a 63, the comparison asserts nothing about it, and it is excluded from every colour list,
  filter and count. `drawableIndices()` exists to say "everything a template can require", which is
  the palette minus this one.
- **`UNPAINTED = 255` is a sentinel of ours, outside the palette.** wplace store colour and absence
  as the same value — their index 0 is Transparent *and* what an unpainted pixel holds — and their
  canvas renders both at alpha zero. Keeping absence at 255 means "nothing here" is never confusable
  with a colour, and leaves 0..62 meaning exactly what they mean.

The RGB→index conversion is a flat `Uint8Array(1 << 24)` indexed by `(r << 16) | (g << 8) | b`:
16MB once, no hashing, and alpha short-circuits to the sentinel before the table is consulted. Every
comparison downstream is therefore one byte against one byte.

The "is the palette stable, or does it grow?" question is unanswered and now belongs to the fog: a
palette that grows would not break stored templates, but it would silently change what `Owned` and
`Free` mean.
