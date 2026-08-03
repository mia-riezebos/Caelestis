# Recon: pixel-info and /me endpoints

Type: task
Status: resolved
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

## Answer — observed 2026-08-03 in a logged-in session

### Pixel info

```
GET https://backend.wplace.live/s0/pixel/{tileX}/{tileY}?x={px}&y={py}
```

Season is in the path here (`s0`), unlike the paint endpoint. Coordinates are tile-local, passed as
query parameters.

```json
{
  "paintedBy": { "id": 5592323, "name": "patch",
                 "allianceId": 535245, "allianceName": "The Caelestis",
                 "picture": "...", "equippedBadges": [...] },
  "region": { "id": 227921, "name": "Adamstown", "countryId": 174 }
}
```

**No timestamp, and no colour.** Both matter:

- **No timestamp** kills the hoped-for forgiving polling cadence. There is no way to tell whether a
  pixel was painted a minute or a month ago, so attribution is only valid when *we* know the pixel
  changed — which means it depends entirely on the server's tile history bracketing the change
  between two observations.
- **No colour** means this endpoint cannot verify canvas state. Only the tile PNG can.

Consequence for the design: pixel-info's real role is **attributing changes we did not make** —
identifying who overwrote our work — rather than being a general attribution mechanism. Our own
members' contributions come from paint interception, which carries exact who and when for free.

One request per pixel; no batch form observed.

### /me

```
GET https://backend.wplace.live/me
```

Returns far more than needed. Relevant fields only:

| Field | Value | Use |
|---|---|---|
| `name` | `"patch"` | the stable username — the one identity field we transmit |
| `id` | `5592323` | stable numeric id; **not** transmitted under payload discipline |
| `charges` | `{ cooldownMs: 30000, count, max: 10215 }` | confirms the charge model; `max` is per-user and large |
| `allianceId` / `allianceName` | `535245` / `"The Caelestis"` | wplace exposes alliance identity natively |
| `extraColorsBitmap` | `-1` | which premium colours this user owns |

Everything else — `discordId`, `droplets`, `country`, `favoriteLocations`, `picture`,
`isCustomer` — is out of scope and must never leave the page.

### Two opportunities this opens

- **`allianceId` is available client-side.** A server could verify that a connecting user is
  actually in the alliance it serves, rather than relying solely on invite codes. Not a replacement
  for auth, but a cheap second factor and a nice onboarding shortcut.
- **`extraColorsBitmap` tells us which colours a user can actually place.** A template using a
  premium colour a member does not own is a real and currently invisible UX problem. Feeds
  `09-recon-palette`.
