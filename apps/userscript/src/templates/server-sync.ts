import { PALETTE_RGB, quantiseToPalette, TILE_SIZE, TRANSPARENT_INDEX } from '@wts/shared'
import { count, warn } from '../debug.js'
import type { ServerTemplate } from '../server-cache.js'
import { type ConnectedServer, getState, listServerTemplates } from '../state.js'
import {
  forgetServerTemplate,
  localTemplates,
  putServerTemplate,
  renameLocalTemplate,
} from './local-store.js'

/**
 * Bringing a server's published templates onto the canvas.
 *
 * The manifest says which templates exist and, per template, which tile each of its chunks covers
 * and the hash of that chunk. Chunks are content-addressed and served immutable, so this is a
 * download that gets cheaper the more of it you have already done: a new version that changed one
 * corner shares every other hash with the old one, and a rename shares all of them.
 *
 * The assembled result is handed to the same store local imports live in, which is what makes a
 * server template a first-class overlay — it renders, it can be filtered by colour, its mismatches
 * are marked, and the picker will answer from it, all without any of those knowing it came from
 * somewhere else.
 */

/** Chunk bytes by hash. Immutable by definition, so nothing here ever needs invalidating. */
const chunkCache = new Map<string, Uint8Array>()

/**
 * How many chunks to keep. A chunk is at most a tile — a megabyte decoded, far less as PNG — and
 * this only holds the encoded bytes, so a few hundred is small and saves re-downloading on every
 * version bump of a template that mostly did not change.
 */
const CHUNK_CACHE_LIMIT = 512

const rememberChunk = (hash: string, bytes: Uint8Array): void => {
  if (chunkCache.size >= CHUNK_CACHE_LIMIT) {
    const oldest = chunkCache.keys().next()
    if (!oldest.done) chunkCache.delete(oldest.value)
  }
  chunkCache.set(hash, bytes)
}

const fetchChunk = async (server: ConnectedServer, hash: string): Promise<Uint8Array | null> => {
  const cached = chunkCache.get(hash)
  if (cached !== undefined) return cached
  try {
    const response = await fetch(`${server.url}/chunks/${hash}`, {
      headers: server.token === null ? {} : { authorization: `Bearer ${server.token}` },
    })
    if (!response.ok) return null
    const bytes = new Uint8Array(await response.arrayBuffer())
    rememberChunk(hash, bytes)
    return bytes
  } catch {
    return null
  }
}

/** A chunk PNG, as palette indices. */
const decodeChunk = async (
  bytes: Uint8Array,
): Promise<{ width: number; height: number; indices: Uint8Array } | null> => {
  try {
    const bitmap = await createImageBitmap(new Blob([bytes.slice()], { type: 'image/png' }))
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (context === null) return null
    context.drawImage(bitmap, 0, 0)
    const width = bitmap.width
    const height = bitmap.height
    const image = context.getImageData(0, 0, width, height)
    bitmap.close()
    // The bytes are already palette colours — the server quantised on ingest — so this maps each to
    // itself. Going through the same quantiser as an import rather than trusting that is one pass
    // over a chunk, and it is the difference between a colour-managed decode being a bug and being
    // a non-event.
    const { indices } = quantiseToPalette(new Uint8Array(image.data.buffer), PALETTE_RGB)
    return { width, height, indices }
  } catch (error) {
    warn('install', 'could not decode a chunk', String(error))
    return null
  }
}

/**
 * Assemble a template's chunks into one bitmap the size of its bounding box.
 *
 * Where each chunk goes is derivable rather than stored: a chunk covers the intersection of the
 * template's box with one tile, so its top-left is the later of the two starts on each axis. That is
 * why the manifest carries only a tile and a hash per chunk.
 */
const assemble = async (
  server: ConnectedServer,
  template: ServerTemplate,
): Promise<{ width: number; height: number; indices: Uint8Array } | null> => {
  const width = template.bbox.maxX - template.bbox.minX
  const height = template.bbox.maxY - template.bbox.minY
  if (width <= 0 || height <= 0 || width * height > 64_000_000) return null

  const indices = new Uint8Array(width * height).fill(TRANSPARENT_INDEX)
  let placed = 0
  for (const chunk of template.chunks) {
    const [tileX, tileY] = chunk.tile.split('/').map(Number)
    if (tileX === undefined || tileY === undefined || !Number.isFinite(tileX)) continue
    const bytes = await fetchChunk(server, chunk.hash)
    if (bytes === null) continue
    const decoded = await decodeChunk(bytes)
    if (decoded === null) continue

    const left = Math.max(template.bbox.minX, tileX * TILE_SIZE)
    const top = Math.max(template.bbox.minY, tileY * TILE_SIZE)
    for (let y = 0; y < decoded.height; y++) {
      const targetY = top + y - template.bbox.minY
      if (targetY < 0 || targetY >= height) continue
      for (let x = 0; x < decoded.width; x++) {
        const targetX = left + x - template.bbox.minX
        if (targetX < 0 || targetX >= width) continue
        const index = decoded.indices[y * decoded.width + x] ?? TRANSPARENT_INDEX
        if (index === TRANSPARENT_INDEX) continue
        indices[targetY * width + targetX] = index
      }
    }
    placed++
  }
  if (placed === 0) return null
  return { width, height, indices }
}

/** Our id for a server's template, namespaced so two servers cannot collide. */
export const serverTemplateKey = (serverUrl: string, id: string): string => `srv:${serverUrl}:${id}`

/** Templates already in flight, so a second sync while one runs does not download everything twice. */
const inFlight = new Set<string>()

/**
 * Bring one server's published templates onto the canvas, and take away what it no longer publishes.
 *
 * Unpublished templates are deliberately skipped even when an admin can see them in the manifest:
 * the tree is where you manage what exists, and the canvas is where you see what everyone else sees.
 * Drawing a draft over the map would make an admin's view disagree with every member's.
 */
export const syncServerTemplates = async (server: ConnectedServer): Promise<void> => {
  if (server.status !== 'connected') return
  const published = (await listServerTemplates(server)).filter((template) => template.published)
  const wanted = new Map(
    published.map((template) => [serverTemplateKey(server.url, template.id), template]),
  )

  for (const held of localTemplates()) {
    if (held.serverUrl !== server.url) continue
    if (!wanted.has(held.id)) forgetServerTemplate(held.id)
  }

  for (const [key, template] of wanted) {
    const held = localTemplates().find((candidate) => candidate.id === key)
    // The version is the whole point of the sync being cheap: same version, same pixels, nothing to
    // do. A rename arrives through the manifest and is applied without downloading a byte.
    if (held !== undefined && held.serverVersion === template.version) {
      // A rename is a name. Re-slicing a template into per-tile bitmaps to change a string would
      // cost seconds on a large one, for a field the renderer never looks at.
      if (held.name !== template.name) renameLocalTemplate(key, template.name)
      continue
    }
    if (inFlight.has(key)) continue
    inFlight.add(key)
    try {
      const built = await assemble(server, template)
      if (built === null) continue
      await putServerTemplate({
        id: key,
        name: template.name,
        source: 'image',
        originX: template.bbox.minX,
        originY: template.bbox.minY,
        width: built.width,
        height: built.height,
        indices: built.indices,
        // The server quantised on ingest, so nothing moved on the way here and every pixel it
        // carries is one it asserts.
        moved: 0,
        opaque: built.indices.reduce(
          (total, index) => (index === TRANSPARENT_INDEX ? total : total + 1),
          0,
        ),
        serverUrl: server.url,
        serverTemplateId: template.id,
        serverVersion: template.version,
      })
      count('server:template drawn from chunks')
    } finally {
      inFlight.delete(key)
    }
  }
}

/** How often to ask a server whether anything changed. */
const POLL_MS = 60_000
let timer: ReturnType<typeof setInterval> | null = null

const syncAll = (): void => {
  for (const server of getState().servers) void syncServerTemplates(server)
}

/**
 * Keep every connected server's templates on the canvas.
 *
 * Polled rather than pushed, because there is nothing to push over: a server is a plain HTTP host
 * with no socket. A minute is chosen against what changes — someone publishing a template or
 * uploading new artwork — rather than against paint activity, which this does not track.
 */
export const installServerSync = (): void => {
  syncAll()
  if (timer !== null) clearInterval(timer)
  timer = setInterval(syncAll, POLL_MS)
}
