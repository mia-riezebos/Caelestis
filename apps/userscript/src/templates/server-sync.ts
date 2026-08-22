import {
  PALETTE_RGB,
  quantiseToPalette,
  sha256Hex,
  TILE_SIZE,
  TRANSPARENT_INDEX,
  WORLD_PIXELS,
} from '@caelestis/shared'
import { count, warn } from '../debug.js'
import type { ServerTemplate } from '../server-cache.js'
import { type ConnectedServer, getState, listServerContents, onStateChange } from '../state.js'
import {
  forgetServerTemplate,
  hasRoomForServerTemplate,
  localTemplates,
  putServerTemplate,
  updateServerTemplateMetadata,
} from './local-store.js'
import { rememberNodes } from './server-nodes.js'

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
const CHUNK_FETCH_TIMEOUT_MS = 15_000
const MAX_CHUNK_BYTES = 8 * 1024 * 1024

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
      signal: AbortSignal.timeout(CHUNK_FETCH_TIMEOUT_MS),
    })
    if (!response.ok) return null
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_CHUNK_BYTES) return null
    if (response.body === null) return null
    const reader = response.body.getReader()
    const parts: Uint8Array[] = []
    let length = 0
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        length += part.value.byteLength
        if (length > MAX_CHUNK_BYTES) {
          await reader.cancel()
          return null
        }
        parts.push(part.value)
      }
    } finally {
      reader.releaseLock()
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const part of parts) {
      bytes.set(part, offset)
      offset += part.byteLength
    }
    // A configured server is not trusted to tell the truth about a content address. Verify before
    // admitting bytes to the global cache, otherwise one server can seed another server's hash.
    if ((await sha256Hex(bytes)) !== hash) return null
    rememberChunk(hash, bytes)
    return bytes
  } catch {
    return null
  }
}

/** A chunk PNG, as palette indices. */
const decodeChunk = async (
  bytes: Uint8Array,
  expectedWidth: number,
  expectedHeight: number,
): Promise<{ width: number; height: number; indices: Uint8Array } | null> => {
  try {
    // Read IHDR before asking the browser to decode. Checking the ImageBitmap afterwards is too
    // late for a PNG that declares a gigantic surface: the decoder may already have allocated it.
    if (
      bytes.length < 24 ||
      bytes[0] !== 0x89 ||
      bytes[1] !== 0x50 ||
      bytes[2] !== 0x4e ||
      bytes[3] !== 0x47
    )
      return null
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (header.getUint32(16) !== expectedWidth || header.getUint32(20) !== expectedHeight)
      return null
    const bitmap = await createImageBitmap(new Blob([bytes.slice()], { type: 'image/png' }))
    if (bitmap.width !== expectedWidth || bitmap.height !== expectedHeight) {
      bitmap.close()
      return null
    }
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
  const wrapsX = template.bbox.minX > template.bbox.maxX
  const width = wrapsX
    ? WORLD_PIXELS - template.bbox.minX + template.bbox.maxX
    : template.bbox.maxX - template.bbox.minX
  const height = template.bbox.maxY - template.bbox.minY
  if (width <= 0 || height <= 0 || width * height > 64_000_000) return null

  const indices = new Uint8Array(width * height).fill(TRANSPARENT_INDEX)
  let placed = 0
  for (const chunk of template.chunks) {
    const [tileX, tileY] = chunk.tile.split('/').map(Number)
    if (
      tileX === undefined ||
      tileY === undefined ||
      !Number.isInteger(tileX) ||
      !Number.isInteger(tileY)
    )
      return null
    const tileLeft = tileX * TILE_SIZE
    const tileRight = (tileX + 1) * TILE_SIZE
    const spanStart = wrapsX && tileLeft < template.bbox.maxX ? 0 : template.bbox.minX
    const spanEnd = wrapsX && tileLeft < template.bbox.maxX ? template.bbox.maxX : WORLD_PIXELS
    const left = Math.max(spanStart, tileLeft)
    const right = Math.min(wrapsX ? spanEnd : template.bbox.maxX, tileRight)
    const top = Math.max(template.bbox.minY, tileY * TILE_SIZE)
    const bottom = Math.min(template.bbox.maxY, (tileY + 1) * TILE_SIZE)
    const chunkWidth = right - left
    const chunkHeight = bottom - top
    if (chunkWidth <= 0 || chunkHeight <= 0) return null
    const bytes = await fetchChunk(server, chunk.hash)
    if (bytes === null) return null
    const decoded = await decodeChunk(bytes, chunkWidth, chunkHeight)
    if (decoded === null) return null

    for (let y = 0; y < decoded.height; y++) {
      const targetY = top + y - template.bbox.minY
      if (targetY < 0 || targetY >= height) continue
      for (let x = 0; x < decoded.width; x++) {
        const targetX =
          left >= template.bbox.minX
            ? left + x - template.bbox.minX
            : WORLD_PIXELS - template.bbox.minX + left + x
        if (targetX < 0 || targetX >= width) continue
        const index = decoded.indices[y * decoded.width + x] ?? TRANSPARENT_INDEX
        if (index === TRANSPARENT_INDEX) continue
        indices[targetY * width + targetX] = index
      }
    }
    placed++
  }
  if (placed !== template.chunks.length) return null
  return { width, height, indices }
}

/**
 * Drop cached chunk bytes, by hash.
 *
 * Chunks are content-addressed, so the cache has no idea which server anything came from — the
 * caller does, from the manifest it still holds, and hands the hashes over on the way out.
 */
export const forgetChunks = (hashes: Iterable<string>): void => {
  for (const hash of hashes) chunkCache.delete(hash)
}

/** Our id for a server's template, namespaced so two servers cannot collide. */
export const serverTemplateKey = (serverUrl: string, id: string): string => `srv:${serverUrl}:${id}`

/** Templates already in flight, so a second sync while one runs does not download everything twice. */
const inFlight = new Set<string>()

/**
 * Which generation of a server's connection a download belongs to.
 *
 * A chunk request outlives the connection that asked for it. Disconnecting takes the server's
 * templates away, and a download still in the air then put one back — an overlay with no server row
 * left to poll it or turn it off, until the page reloads. The generation moves when the connection
 * does, so a reply that comes back into a different one is dropped rather than drawn.
 */
const generations = new Map<string, number>()

const generationOf = (serverUrl: string): number => generations.get(serverUrl) ?? 0

/** Called when a server's templates are taken away, so anything already downloading for it lands stale. */
export const endServerGeneration = (serverUrl: string): void => {
  generations.set(serverUrl, generationOf(serverUrl) + 1)
}

/**
 * Bring one server's templates onto the canvas, and take away what it no longer has.
 *
 * Unpublished ones are drawn too, and the scope sorts that out by itself: the manifest only lists
 * them for an admin code, so a member never sees one and an admin sees exactly what they are about
 * to publish. Being able to look at a draft on the map before releasing it is the point of a draft.
 */
export const syncServerTemplates = async (
  server: ConnectedServer,
  /** The manifest's templates, when the caller has just read them and would only re-read them. */
  known?: readonly ServerTemplate[],
): Promise<void> => {
  if (server.status !== 'connected') return
  let available = known ?? null
  if (known === undefined) {
    const contents = await listServerContents(server)
    // The folders as well as the templates, because a template's visibility answers to the folders
    // above it and this is the only place that learns of them changing between polls.
    if (contents !== null) rememberNodes(server.url, contents.nodes)
    available = contents?.templates ?? null
  }
  // Could not ask, so nothing is known and nothing changes. Treating this as an empty server took
  // every template off the canvas on a single blip and put them back looking newly arrived.
  if (available === null) return
  const wanted = new Map(
    available.map((template) => [serverTemplateKey(server.url, template.id), template]),
  )

  for (const held of localTemplates()) {
    if (held.serverUrl !== server.url) continue
    if (!wanted.has(held.id)) forgetServerTemplate(held.id)
  }

  const generation = generationOf(server.url)
  for (const [key, template] of wanted) {
    const held = localTemplates().find((candidate) => candidate.id === key)
    // The version is the whole point of the sync being cheap: same version, same pixels, nothing to
    // rebuild. Names and folder membership still arrive through the manifest because neither
    // changes the pixel version.
    if (held !== undefined && held.serverVersion === template.version) {
      updateServerTemplateMetadata(key, template.name, template.nodeId)
      continue
    }
    if (inFlight.has(key)) continue
    // Asked before the download, not after. A server may advertise a manifest far larger than the
    // rendering budget, and decoding a template only to have the store refuse it means an
    // `ImageBitmap` built for every one of them on every poll.
    if (!hasRoomForServerTemplate(key)) continue
    inFlight.add(key)
    try {
      const built = await assemble(server, template)
      if (built === null) continue
      // The connection this download belongs to may have ended, or a later poll may have taken over
      // this template, while the chunks were in the air.
      if (generationOf(server.url) !== generation) return
      if (!hasRoomForServerTemplate(key)) continue
      // `putServerTemplate` awaits the restore and then slices every tile, which is the expensive
      // part and therefore the widest window for a disconnect to land in. Asked again on the far
      // side, and the template is taken straight back out if the answer changed while it ran.
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
        serverNodeId: template.nodeId,
        serverVersion: template.version,
      })
      // Disconnected while it was slicing: take back out what has just gone in, so the store never
      // keeps an overlay whose server has no row left to poll or switch it off.
      if (generationOf(server.url) !== generation) {
        forgetServerTemplate(key)
        return
      }
      count('server:template drawn from chunks')
    } catch (error) {
      warn('install', `could not sync server template ${template.name}`, String(error))
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
  /**
   * And whenever the set of servers changes.
   *
   * Polling alone was not enough, and in the ordinary case it was not enough by a whole minute:
   * nothing is connected when this installs — the stored servers are loaded later, by the panel —
   * so the first sweep finds nothing and the first real one is a poll away. Connecting a server and
   * watching an empty map for up to sixty seconds reads as broken.
   *
   * Cheap to over-call. A server whose templates are all at versions we hold does no work beyond one
   * manifest fetch, which is the same request the tree makes anyway.
   */
  onStateChange(() => {
    const connected = getState()
      .servers.filter((server) => server.status === 'connected')
      .map((server) => server.url)
      .join(' ')
    if (connected === lastConnected) return
    lastConnected = connected
    syncAll()
  })
}

/** Which servers were connected last time state changed, so an unrelated setting does not resync. */
let lastConnected = ''
