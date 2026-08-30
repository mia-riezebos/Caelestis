# #19 Wplace alliance drawing surfaces

Research date: 2026-08-30

This note records read-only observations from Wplace's current production client, public API, and a
user-authorized authenticated browser session. Bundle hashes will change when Wplace deploys. The
API and coordinate facts below match the cited production build on the research date. The live
probe retained response shapes and runtime metadata only; it did not retain cookies, tokens, or
paint responses.

## Short answer

Alliance HQ is a dedicated 2D pixel editor inside the main `/` application. It is not a MapLibre
map and it is not one monolithic snapshot. Wplace divides it into signed 64 x 64 tiles, fetches a
viewport-shaped binary tile delta, and draws each tile into its own Canvas 2D element.

The HQ coordinate system has a stable centre. A 250 x 250 HQ spans `-125..124` on both axes, while
a 2,000 x 2,000 HQ spans `-1000..999`. Upgrades therefore add equal space on every side. Caelestis
should store HQ placement coordinates in this signed coordinate system and translate them by the
current manifest's `minX` and `minY` only when drawing.

Alliance pictures and banners use the same generic Wplace artboard component in non-tiled mode.
Their draft APIs return one base64 palette-index buffer. Wplace calls the profile image kind
`picture`. The Caelestis's currently published alliance assets are 64 x 64 for `picture` and
384 x 128 for `banner`.

## Primary sources

- [Wplace production application](https://wplace.live/)
- [Svelte route registry, `app.09TX-CK6.js`](https://wplace.live/_app/immutable/entry/app.09TX-CK6.js)
- [API client and public constants, `DCvMiq9p.js`](https://wplace.live/_app/immutable/chunks/DCvMiq9p.js)
- [Shared alliance artboard and HQ tile decoder, `Dao-dXno.js`](https://wplace.live/_app/immutable/chunks/Dao-dXno.js)
- [Member HQ, asset editor, and native overlay UI, `DJLMV4Jw.js`](https://wplace.live/_app/immutable/chunks/DJLMV4Jw.js)
- [Public alliance profile and HQ viewer, `BlO1igLK.js`](https://wplace.live/_app/immutable/chunks/BlO1igLK.js)
- [The Caelestis public alliance record](https://backend.wplace.live/alliances/535245)
- [The Caelestis public HQ record](https://backend.wplace.live/alliances/535245/headquarters)
- [The Caelestis public HQ manifest](https://backend.wplace.live/alliances/535245/headquarters/manifest?metadataOnly=true)
- [A complete public 250 x 250 HQ manifest](https://backend.wplace.live/alliances/273667/headquarters/manifest)
- [The Caelestis public picture](https://backend.wplace.live/alliances/535245/assets/picture?v=23)
- [The Caelestis public banner](https://backend.wplace.live/alliances/535245/assets/banner?v=31)

The public API examples use numeric alliance IDs already exposed by Wplace. The authenticated
examples below retain only response structure and non-secret runtime metadata; no cookies, tokens,
or paint responses were captured.

## Confirmed facts

### Navigation and routes

Sources: [`app.09TX-CK6.js`](https://wplace.live/_app/immutable/entry/app.09TX-CK6.js),
[`DJLMV4Jw.js`](https://wplace.live/_app/immutable/chunks/DJLMV4Jw.js), and
[`BlO1igLK.js`](https://wplace.live/_app/immutable/chunks/BlO1igLK.js).

Alliance drawing surfaces do not have client-side page routes. The production Svelte route table
contains `/` plus staff and account pages, but no `/alliances/{id}/...` routes. Alliance profiles,
asset studios, and HQ canvases are lazy-loaded dialogs inside `/`.

The public HQ viewer opens from an alliance profile or HQ map pin. The member HQ viewer opens from
the current alliance dialog. Picture and banner editing opens the asset studio inside that same
dialog. Code that detects these surfaces from `location.pathname` will not work.

The API does have `/alliances/{id}/...` paths. These are HTTP resource paths, not browser routes.

### Identifiers

Sources: [public alliance record](https://backend.wplace.live/alliances/535245),
[public HQ record](https://backend.wplace.live/alliances/535245/headquarters), and
[`DCvMiq9p.js`](https://wplace.live/_app/immutable/chunks/DCvMiq9p.js).

Wplace represents these identifiers as JSON numbers:

- Alliance ID: `535245` for The Caelestis.
- Headquarters ID: `10` for The Caelestis. This is distinct from the alliance ID.
- Picture version ID: `23` for the current published picture.
- Banner version ID: `31` for the current published banner.
- Asset draft IDs and native template IDs are also numeric in the client contract.

Caelestis should scope alliance surfaces by the alliance ID. It must not substitute the
headquarters ID or an asset version ID.

### HQ dimensions and centred growth

Sources: [250 manifest](https://backend.wplace.live/alliances/273667/headquarters/manifest?metadataOnly=true),
[500 manifest](https://backend.wplace.live/alliances/710117/headquarters/manifest?metadataOnly=true),
[750 manifest](https://backend.wplace.live/alliances/722382/headquarters/manifest?metadataOnly=true),
[1,000 manifest](https://backend.wplace.live/alliances/59492/headquarters/manifest?metadataOnly=true),
and [2,000 manifest](https://backend.wplace.live/alliances/535245/headquarters/manifest?metadataOnly=true).

Public manifests confirm this coordinate rule:

```text
minX = minY = -size / 2
maxX = maxY =  size / 2 - 1
```

Observed production examples:

| Size | X bounds | Y bounds | Tile size |
| ---: | ---: | ---: | ---: |
| 250 | `-125..124` | `-125..124` | 64 |
| 500 | `-250..249` | `-250..249` | 64 |
| 750 | `-375..374` | `-375..374` | 64 |
| 1,000 | `-500..499` | `-500..499` | 64 |
| 2,000 | `-1000..999` | `-1000..999` | 64 |

The 250, 500, 750, and 1,000 manifests came from alliances `273667`, `710117`, `722382`, and
`59492`. The 2,000 manifest came from alliance `535245`.

The authenticated `GET /alliance/store` response confirms the complete ladder as 250, 500, 750,
1,000, 1,500, and 2,000. It lists one purchase after the initial 250 tier for each later size, so
2,000 is the current maximum.

### HQ manifest and tile delivery

Sources: [`DCvMiq9p.js`](https://wplace.live/_app/immutable/chunks/DCvMiq9p.js),
[`DJLMV4Jw.js`](https://wplace.live/_app/immutable/chunks/DJLMV4Jw.js), and
[complete 250 manifest](https://backend.wplace.live/alliances/273667/headquarters/manifest).

The public and member manifest methods accept:

```js
{
  metadataOnly: true,
  viewport: { minX, minY, maxX, maxY }
}
```

The current public 250 x 250 manifest has this shape:

```json
{
  "bounds": { "minX": -125, "minY": -125, "maxX": 124, "maxY": 124 },
  "eventHwm": 290,
  "headquartersId": 302,
  "size": 250,
  "tileSize": 64,
  "tiles": [
    {
      "url": "/alliances/273667/headquarters/tiles/-2/-2/50.png",
      "version": 50,
      "x": -2,
      "y": -2
    }
  ],
  "visibility": "public"
}
```

`metadataOnly=true` returns the same metadata with an empty `tiles` array. A manifest tile URL
returns a 64 x 64 indexed PNG. Negative tile coordinates are normal.

The production UI now uses the snapshot endpoint for viewport refreshes. The older
`GET /alliance/headquarters/canvas` JSON method remains in the API client but the current HQ
components do not call it.

### HQ snapshot protocol

Sources: [`DCvMiq9p.js`](https://wplace.live/_app/immutable/chunks/DCvMiq9p.js) for the request and
[`Dao-dXno.js`](https://wplace.live/_app/immutable/chunks/Dao-dXno.js) for the decoder.

The current UI sends a read-only POST because the request includes viewport and cache state:

```http
POST /alliances/{allianceId}/headquarters/snapshot
Content-Type: application/json

{
  "minX": -125,
  "minY": -125,
  "maxX": 124,
  "maxY": 124,
  "knownTiles": [
    { "x": -2, "y": -2, "version": 50 }
  ]
}
```

The response content type is `application/x-wplace-alliance-hq-snapshot`. `Dao-dXno.js` decodes
this little-endian binary format:

```text
5 bytes   magic "WHQS1"
u16       tile size
i64       event high-water mark
u16       changed tile count
u16       removed tile count

for each changed tile:
  i16     tile X
  i16     tile Y
  i64     tile version
  u8[]    tileSize * tileSize palette indices

for each removed tile:
  i16     tile X
  i16     tile Y
```

A live full-canvas request for alliance `273667` returned three changed tiles in 12,343 bytes.
Repeating it with those tile versions in `knownTiles` returned only the 19-byte header. This is a
tile-delta protocol, not a full-image snapshot.

### HQ canvas technology and projection

Source: [`Dao-dXno.js`](https://wplace.live/_app/immutable/chunks/Dao-dXno.js).

The shared artboard creates one `<canvas>` for each visible HQ tile. Every tile uses a Canvas 2D
context and `putImageData`. Wplace positions the tile canvas with this rule:

```js
left = (tileX * tileSize - originX) * scale;
top = (tileY * tileSize - originY) * scale;
```

The artboard itself uses a CSS translation and scale-derived size:

```js
width = canvasWidth * scale;
height = canvasHeight * scale;
transform = translate(offsetX, offsetY);
```

Pointer projection is ordinary 2D math:

```js
localX = Math.floor((clientX - stageLeft - offsetX) / scale);
localY = Math.floor((clientY - stageTop - offsetY) / scale);
apiX = localX + originX;
apiY = localY + originY;
```

For HQ, `originX` and `originY` are the manifest's `bounds.minX` and `bounds.minY`. Positive Y is
down. The geographic HQ anchor only places the pin on the world map. It does not project pixels
inside the HQ artboard.

The artboard supports panning, pointer-centred zoom, fit-to-canvas, a pixel grid, touch pinch zoom,
and a maximum display scale of 64 screen pixels per source pixel.

### HQ refresh and cache behaviour

Sources: [`Dao-dXno.js`](https://wplace.live/_app/immutable/chunks/Dao-dXno.js) and
[`DJLMV4Jw.js`](https://wplace.live/_app/immutable/chunks/DJLMV4Jw.js).

The client:

- keeps a 1,296-tile least-recently-used cache;
- expands the visible viewport by one tile before loading;
- sends known tile versions with the snapshot request;
- aborts the prior request when the viewport changes;
- rejects a late response if the local tile version changed during the request;
- polls manifest metadata and refreshes when `eventHwm` or bounds change;
- never assumes that a larger HQ only extends down and right.

This matters for Caelestis. The active-surface adapter needs its own stale-response fence and must
re-read bounds after an expansion.

### HQ paint traffic

Sources: [`DCvMiq9p.js`](https://wplace.live/_app/immutable/chunks/DCvMiq9p.js) and
[`DJLMV4Jw.js`](https://wplace.live/_app/immutable/chunks/DJLMV4Jw.js).

Member painting uses:

```http
POST /alliance/headquarters/paint

{
  "batchId": "a UUID reused across retries",
  "pixels": [
    { "x": -10, "y": 4, "color": 7 }
  ]
}
```

Coordinates are signed HQ coordinates. The public client constant limits a batch to 128 pixel
changes. The response supplies at least `eventHwm`, `chargesRemaining`, and `nextChargeAt`, which
the editor uses to update its tile cache and separate HQ charge meter.

The request also participates in Wplace's verification and proof-of-work flow. This research did
not send paint requests.

### HQ access checks

Sources: [`DCvMiq9p.js`](https://wplace.live/_app/immutable/chunks/DCvMiq9p.js),
[`DJLMV4Jw.js`](https://wplace.live/_app/immutable/chunks/DJLMV4Jw.js), and
[`BlO1igLK.js`](https://wplace.live/_app/immutable/chunks/BlO1igLK.js).

Public viewing uses credential-free resources:

- `GET /alliances/{allianceId}/headquarters`
- `GET /alliances/{allianceId}/headquarters/manifest`
- `POST /alliances/{allianceId}/headquarters/snapshot`
- `GET /alliances/{allianceId}/headquarters/image?v={eventHwm}` for a preview

Member access uses credentialed `/alliance/headquarters/...` resources. The member HQ record
contains `canPaint`, permissions, charge state, and visibility. Painting is gated by `canPaint` and
available HQ charges. Management tools additionally require `manage_headquarters` or moderation
permissions.

The public viewer treats `403` and `404` as an unavailable HQ and closes the canvas. A backend that
stores templates for several alliances must still filter by alliance ID. A user's single Wplace
alliance membership is not a safe server-wide scope.

### Picture and banner canvases

Sources: [`DCvMiq9p.js`](https://wplace.live/_app/immutable/chunks/DCvMiq9p.js),
[`DJLMV4Jw.js`](https://wplace.live/_app/immutable/chunks/DJLMV4Jw.js),
[published picture](https://backend.wplace.live/alliances/535245/assets/picture?v=23), and
[published banner](https://backend.wplace.live/alliances/535245/assets/banner?v=31).

Wplace uses the kinds `picture` and `banner`. Published resources are:

```text
GET /alliances/{allianceId}/assets/picture?v={versionId}
GET /alliances/{allianceId}/assets/banner?v={versionId}
```

The current The Caelestis resources are PNG files with these dimensions:

| Kind | Dimensions | Aspect ratio |
| --- | ---: | ---: |
| `picture` | 64 x 64 | 1:1 |
| `banner` | 384 x 128 | 3:1 |

Draft editing uses credentialed resources:

```text
GET  /alliance/assets/{picture|banner}
POST /alliance/assets/{picture|banner}/drafts
GET  /alliance/assets/drafts/{draftId}/canvas
GET  /alliance/assets/drafts/{draftId}/canvas?metadataOnly=true
POST /alliance/assets/drafts/{draftId}/paint
POST /alliance/assets/drafts/{draftId}/finish
GET  /alliance/assets/drafts/{draftId}/editors
```

The full draft canvas response contains a base64 palette-index `pixels` buffer plus `revision`.
The metadata-only response is used for revision polling. Asset paint requests contain local
zero-based `{x, y, color}` records. Picture and banner drafts use one Canvas 2D artboard rather
than the HQ tile cache.

The authenticated draft metadata and alliance store both confirm 64 x 64 and 384 x 128 as the
canonical dimensions.

### Wplace's native alliance overlays

Sources: [`DCvMiq9p.js`](https://wplace.live/_app/immutable/chunks/DCvMiq9p.js) and
[`DJLMV4Jw.js`](https://wplace.live/_app/immutable/chunks/DJLMV4Jw.js).

Wplace already has an alliance-owned overlay system. Its placement target is one of:

```ts
type NativeAllianceTemplateTarget =
  | { target: "main_canvas" }
  | { target: "headquarters" }
  | { target: "draft"; draftId: number };
```

The native UI fetches an exact target with:

```text
GET /alliance/templates?target=headquarters
GET /alliance/templates?target=draft&draftId={draftId}
```

Each location carries `x`, `y`, `width`, `height`, opacity, colour conversion, dithering, palette,
and pixel mode. A single native template can have several locations, including up to 50 drafts.
Wplace renders these placements inside the same generic artboard used by HQ, picture, and banner
drafts.

This confirms three useful design points for Caelestis:

1. Surface-specific filtering is necessary.
2. HQ can use a stable alliance-wide target.
3. Picture and banner runtime detection must know the current draft and its `assetType`, even if
   Caelestis stores templates against a stable alliance picture or banner kind.

The native system does not make Caelestis support redundant. It is tied to the active Wplace
alliance, Wplace permissions, and Wplace storage. It does prove that overlays fit naturally inside
all three alliance artboards.

## Live Chromium findings

The user-authorized probe used the existing debug Chromium session and did not launch another
browser. The active alliance was The Caelestis (`allianceId: 535245`).

### Member HQ and store payloads

`GET /alliance/headquarters` returned the following fields for the active member:

```json
{
  "allianceId": 535245,
  "id": 10,
  "bounds": { "minX": -1000, "minY": -1000, "maxX": 999, "maxY": 999 },
  "canPaint": true,
  "role": "leader",
  "size": 2000,
  "unlocked": true,
  "visibility": "public"
}
```

The payload also carried the separate HQ charge state. `GET /alliance/store` confirmed:

```json
{
  "assets": {
    "picture": { "width": 64, "height": 64 },
    "banner": { "width": 384, "height": 128 }
  },
  "headquarters": {
    "size": 2000,
    "sizes": [250, 500, 750, 1000, 1500, 2000],
    "unlocked": true
  }
}
```

Alliance identity comes from `GET /alliance`: its numeric `id` is the scope Caelestis needs, while
its nested `headquarters.id` is a different resource identifier.

### Active surface detection

All three editors remain under `https://wplace.live/`. They mount within a native `<dialog open>`;
Wplace keeps several closed dialogs in the DOM, so matching a stage without first requiring the
open dialog selects stale UI.

The active stages have stable accessible labels:

```text
dialog[open] [role="application"][aria-label="Headquarters canvas"]
dialog[open] [role="application"][aria-label="Alliance asset canvas"]
```

The asset-stage DOM does not identify picture versus banner. Every editor load does request
`/alliance/assets/drafts/{draftId}/canvas`; its metadata-only form returns `assetType`, `draftId`,
`width`, and `height`. The inspected open drafts confirmed:

| Draft | Kind | Dimensions | Revision |
| ---: | --- | ---: | ---: |
| 129 | `picture` | 64 x 64 | 89 |
| 130 | `banner` | 384 x 128 | 1,388 |

A document-start request observer can record the current draft ID and then validate it through the
metadata-only endpoint. Relying on the heading `Pixel editor` cannot distinguish the assets.

### Menu and renderer attachment points

Wplace's native overlay control is:

```text
dialog[open] [role="application"] > div >
  button[aria-label="Alliance overlays"]
```

Its tooltip wrapper is an absolutely positioned direct child of the stage at the top-left. A
Caelestis control can occupy the next position in that same stage-side stack. The main-map
Caelestis rail remains mounted behind the modal and is not an effective control for the active
editor.

Within either stage, `.artboard-frame` owns Wplace's scale and translation. HQ puts its 64 x 64 tile
canvases in `.hq-tile-layer` under that frame; picture and banner put one indexed art canvas there.
An independent Caelestis overlay canvas attached inside the active frame inherits Wplace's pan,
zoom, fit, and clipping without duplicating its transform state. The hashed Svelte class is not a
stable selector; discovery should start at the accessible stage and search only inside it.

The live HQ frame ordered the tile layer first and Wplace's full-artboard overlay canvas second. The
Caelestis canvas should be inserted immediately before that Wplace overlay canvas, keeping the base
art below Caelestis while Wplace's own tool and selection feedback remains above it. Wplace also
keeps a stage-sized pointer-feedback canvas outside the transformed frame, which must stay above the
artboard stack.

The same DOM structure appears in windowed and full-screen editor modes. A `MutationObserver` must
reconcile on open, back, close, and Svelte remount, remove detached controls/canvases, and require
the stage to belong to the currently open dialog before attaching anything.

### Native overlay response

Both `GET /alliance/templates?target=headquarters` and
`GET /alliance/templates?target=draft&draftId=129` returned the same target-aware manager envelope.
It included `canManage`, `headquartersSize`, the open draft options with each asset type and
dimensions, a byte budget, and the alliance's template-slot limit. The active alliance currently
had no native templates, so placement rendering and expansion adjustment could not be observed
live.

## Strong inferences for Caelestis

### Schema naming

Wplace's own names favour these stable kinds:

```ts
type TemplateSurface =
  | { kind: "world" }
  | { kind: "alliance-headquarters"; allianceId: number }
  | { kind: "alliance-picture"; allianceId: number }
  | { kind: "alliance-banner"; allianceId: number };
```

`alliance-picture` matches the first-party API better than `alliance-avatar`. The UI can still call
it the alliance profile image.

An active picture or banner editor also has a numeric `draftId`. Treat that as transient Wplace
context unless Caelestis deliberately wants templates scoped to one disposable draft.

### HQ placement storage

Store the template origin in signed HQ coordinates. At render time:

```text
localPlacementX = storedHqX - manifest.bounds.minX
localPlacementY = storedHqY - manifest.bounds.minY
```

This keeps artwork aligned when an upgrade moves `minX` and `minY` outward. Storing only local
top-left artboard coordinates would shift an existing placement down and right after an upgrade.

### Renderer seam

The reusable seam is a 2D artboard adapter, not the world MapLibre projection:

```ts
interface AllianceArtboardAdapter {
  surface: TemplateSurface;
  width: number;
  height: number;
  originX: number;
  originY: number;
  scale: number;
  offsetX: number;
  offsetY: number;
  requestRepaint(): void;
}
```

HQ uses manifest bounds as its origin. Picture and banner use origin `(0, 0)`. The existing
Caelestis WebGL shader can still be reused if it receives an independent overlay canvas positioned
with this adapter. It cannot reuse the MapLibre custom-layer attachment unchanged.

## Remaining unknowns

- Whether Wplace adjusts native overlay placements when HQ bounds expand. Caelestis should not rely
  on this because its own signed coordinates already make expansion stable.
- Whether accepted HQ paints emit a browser event or only become visible through snapshot refresh.
  This blocks HQ mismatch/progress telemetry, not overlay rendering.
- Whether an editor's internal Svelte state is inspectable. The DOM and request seam make depending
  on private component state unnecessary.

These unknowns do not change the surface schema, signed HQ coordinate model, or menu and renderer
attachment strategy.
