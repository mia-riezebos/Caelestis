# Berrycamp template fixtures

This directory snapshots every BlueMarble JSON export from Mia's Berrycamp fork. `SOURCE.json` pins
the source commit, Git tree, and selected path. `SHA256SUMS` pins every copied file.

## Layout

- `wplace-templates/quantized/rooms/` contains the BlueMarble JSON exports.
- `BERRYCAMP-LICENSE` is the license copied from the source repository.

The corpus has 92 JSON exports containing 92 templates and 192 embedded PNGs. Each `coords` field
records placement as `tileX, tileY, offsetX, offsetY`. The adjacent `tiles` map contains every image
blob in Berrycamp's already-sliced BlueMarble representation, so separate PNG fixtures would only
duplicate data while losing the placement contract.

## Contracts

Berrycamp already maps every opaque source pixel to the wplace palette and preserves fully
transparent pixels. BlueMarble stores each logical pixel at the centre of a 3 by 3 cell. Caelestis
must decode those embedded PNGs, recover the logical pixels, and assemble them at their recorded
tile positions. It should not move the colours again.

`rooms/prologue/a/__prologue-a.json` is the compact multi-tile fixture. It starts at
`323, 1784, 809, 148` and contains four positioned image blobs.

Do not regenerate these files during ordinary tests. Refresh the snapshot deliberately from a new
Berrycamp commit, then update `SOURCE.json` and `SHA256SUMS` together.
