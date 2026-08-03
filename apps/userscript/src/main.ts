import { TILE_SIZE } from '@wts/shared'

/**
 * Entry point. Scaffold only — nothing is intercepted yet.
 *
 * The shape this will take, once the render path is settled:
 *
 * 1. Fetch each connected server's manifest and build a union `Set<TileKey>` of covered tiles.
 * 2. Install the tile shim at `document-start`, before wplace's bundle captures `fetch`.
 * 3. On a tile request, miss the set and pass through untouched; hit it and composite.
 *    An unpainted tile is a real 404, so the shim branches on status and synthesizes a transparent
 *    tile when a template covers a region wplace has no asset for.
 */
const main = () => {
  console.info(`[wts] loaded — tile size ${TILE_SIZE}, no interception installed yet`)
}

main()
