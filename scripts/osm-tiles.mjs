import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fetchMapTile, MAP_CACHE_MS } from '../apps/frontend/src/lib/social-basemap.ts'

/** Keep downloaded OSM tiles for seven days across local and scheduled GIF runs. */
export const cachedMapTiles = (directory) => async (z, x, y) => {
  const file = join(directory, `${z}-${x}-${y}.png`)
  try {
    if (Date.now() - (await stat(file)).mtimeMs < MAP_CACHE_MS) return await readFile(file)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const bytes = await fetchMapTile(z, x, y)
  await mkdir(directory, { recursive: true })
  await writeFile(file, bytes)
  return bytes
}
