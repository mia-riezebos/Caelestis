# Recon: pixel-info and /me endpoints

Type: task
Status: open
Blocked by: —
GitHub: https://github.com/mia-riezebos/wplace-template-server/issues/9

## Question

What identity and attribution data does wplace expose, and at what cost?

- **Pixel info**: endpoint shape for "who painted this pixel last". What fields come back — username,
  user id, alliance, colour?
- **Does it return a paint timestamp?** If yes, attribution stays accurate even for changes observed
  late, and the whole polling cadence gets much more forgiving.
- Rate limits on that endpoint — documented or observed. Can it be batched, or is it strictly
  one request per pixel?
- **`/me`**: what does it return, and is a stable username available without touching anything
  sensitive? Identity must come from wplace, not from accounts we invent.

Constraint to respect while testing: the userscript will only ever transmit a username, painted
pixel coordinates, and a timestamp. Confirm those are obtainable without reading anything else.
