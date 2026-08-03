# Recon: wplace colour palette

Type: research
Status: open
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
