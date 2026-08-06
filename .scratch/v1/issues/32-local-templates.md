# Local templates — work without a server, publish to one later

Type: prototype
Status: open
Blocked by: 30
GitHub: —

## Why

Connecting to a server is the biggest step in the whole product, and today it is the *first* step:
install, open the panel, and you are asked for a URL you may not have. A local category removes that
wall. Import a file, place it, look at it on the canvas — all of it useful on its own, none of it
requiring anyone else's infrastructure.

It also gives admins a working surface: build a template locally, get the placement right against the
live canvas, then **copy to server** once it is worth sharing.

## Shape

- **A `Local` node is always present in the tree**, even with no servers connected. It is not a
  server and never appears in a manifest.
- **`Add a server` stays visible when only `Local` exists.** Local is a starting point, not a
  destination — hiding the way onward would make it one.
- **Drafts can also be created directly on a server** by anyone with admin scope there. Local and
  server drafts are the same object at different addresses, which is what makes "copy to server"
  a move rather than a conversion.

## Import formats — they are less alike than they look

Both were read from source. The claim that the two schemas are similar does not survive contact:
they disagree on the two things that matter, placement and image storage.

### wplace `.wplace` — see `28-native-wplace-format`

```json
{ "id": "...", "schemaVersion": "1", "name": "cba.png", "opacity": 0.5,
  "image": { "dataUrl": "data:image/png;base64,...", "width": 1612, "height": 2584 },
  "bounds": { "north": -78.82, "south": -78.91, "west": -122.86, "east": -122.57 },
  "order": 0, "locked": false }
```

- **One image**, embedded whole as a data URL.
- **Placed by lat/lng bounds.** Recovering canvas pixels means projecting — Web Mercator zoom 11,
  which `28` confirmed to the pixel from a real file.

### BlueMarble / SkirkMarble — `templateManager.js`

```js
templatesJSON.templates[`${sortID} ${authorID}`] = {
  name, coords: "tx, ty, px, py", enabled,
  pixels: { total, colors }, tiles: { "<tileKey>": <base64 png> },
}
```

- **Already chunked into per-tile buffers**, not one image.
- **Placed by tile + pixel coordinates** — no projection needed.
- Keyed by `"<sortID> <authorID>"`, so ordering and authorship ride in the object key.
- Carries a precomputed colour histogram we would otherwise derive.

**Consequence:** one importer with two front ends, not one parser. wplace files need decode +
projection + slicing; Marble files need decode + reassembly, and their coordinates are already ours.
Marble is the *easier* import despite looking more foreign, because it never left our coordinate
system.

**Shared work after the front end:** palette quantisation, tiling to our chunk model, and the pixel
count — all of which `@wts/shared` already does for uploads.

## What has to be settled

- **Where local templates live.** They are images, not manifest entries; `GM_setValue` is not sized
  for an 11 MB data URL. IndexedDB is the obvious answer and needs saying out loud.
- **What "copy to server" does about placement.** A local template placed by dragging has no node to
  land in. Does it prompt for a group, or land in a draft area for the admin to file?
- **Draft state on the server.** `36` already has publish/unpublish; a draft is presumably an
  unpublished version. Confirm rather than inventing a third state.
- **Whether local templates report progress.** They can: progress needs the template and wplace's
  tiles, not a server. But nothing else is server-free, so it may read as inconsistent.
- **Whether local templates can be shared as a file.** Round-tripping our own export back through
  import is the cheapest way for two people to compare placement without a server between them.
- **Ordering.** Local sits above servers in the tree, presumably, and `serverOrder` has no slot for
  something that is not a server.
