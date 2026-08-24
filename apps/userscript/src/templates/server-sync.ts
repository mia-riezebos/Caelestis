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
import {
  type ConnectedServer,
  getState,
  isCurrentServerConnection,
  isLatestServerContents,
  listServerContents,
  onStateChange,
  type ServerContents,
} from '../state.js'
import { ByteCache } from './byte-cache.js'
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

const CHUNK_CACHE_LIMIT = 512
/** Encoded cache budget. The entry cap alone permits 512 adversarial 8 MiB responses. */
const CHUNK_CACHE_BYTES = 64 * 1024 * 1024
const CHUNK_FETCH_TIMEOUT_MS = 15_000
const MAX_CHUNK_BYTES = 8 * 1024 * 1024
/** Matches the server upload boundary; a wider manifest is not one this client can safely drain. */
const MAX_TEMPLATE_CHUNKS = 400
/** Encoded work per template. Decoded pixels have their own 64M-pixel bound below. */
const MAX_TEMPLATE_TRANSFER_BYTES = 64 * 1024 * 1024
const MAX_TEMPLATE_ATTEMPTS_PER_SYNC = 64
const MAX_TEMPLATE_ASSEMBLY_MS = 120_000
const ASSEMBLY_CONCURRENCY = 4
let activeAssemblies = 0
const assemblyWaiters: Array<() => void> = []

const withAssemblySlot = async <T>(work: () => Promise<T>): Promise<T> => {
  if (activeAssemblies < ASSEMBLY_CONCURRENCY) activeAssemblies++
  else await new Promise<void>((resolve) => assemblyWaiters.push(resolve))
  try {
    return await work()
  } finally {
    const next = assemblyWaiters.shift()
    if (next === undefined) activeAssemblies--
    else next()
  }
}

/** @internal Arithmetic seam for proving that cached and downloaded chunks share one work budget. */
export const templateTransferWithinBudget = (used: number, next: number): boolean =>
  used >= 0 && next >= 0 && used + next <= MAX_TEMPLATE_TRANSFER_BYTES

/** Chunk bytes by hash. Immutable by definition, so nothing here ever needs invalidating. */
const chunkCache = new ByteCache<string>(CHUNK_CACHE_LIMIT, CHUNK_CACHE_BYTES)

/** Fetch one chunk without spending more than this template still has left. */
export const fetchChunkWithinBudget = async (
  server: ConnectedServer,
  hash: string,
  generationSignal: AbortSignal,
  remainingBytes: number,
): Promise<Uint8Array | null> => {
  if (!Number.isSafeInteger(remainingBytes) || remainingBytes < 0) return null
  const cached = chunkCache.get(hash)
  if (cached !== undefined) return cached.byteLength <= remainingBytes ? cached : null
  const readLimit = Math.min(MAX_CHUNK_BYTES, remainingBytes)
  try {
    const response = await fetch(`${server.url}/chunks/${hash}`, {
      headers: server.token === null ? {} : { authorization: `Bearer ${server.token}` },
      signal: AbortSignal.any([generationSignal, AbortSignal.timeout(CHUNK_FETCH_TIMEOUT_MS)]),
    })
    if (!response.ok) return null
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > readLimit) return null
    if (response.body === null) return null
    const reader = response.body.getReader()
    const parts: Uint8Array[] = []
    let length = 0
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        length += part.value.byteLength
        if (length > readLimit) {
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
    // `readLimit` also means an over-budget template never admits the chunk that would evict useful
    // entries and make the same rejected version redownload its whole prefix on every poll.
    if ((await sha256Hex(bytes)) !== hash) return null
    chunkCache.set(hash, bytes)
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
  generationSignal: AbortSignal,
): Promise<{ width: number; height: number; indices: Uint8Array } | null> => {
  const wrapsX = template.bbox.minX > template.bbox.maxX
  const width = wrapsX
    ? WORLD_PIXELS - template.bbox.minX + template.bbox.maxX
    : template.bbox.maxX - template.bbox.minX
  const height = template.bbox.maxY - template.bbox.minY
  if (
    width <= 0 ||
    height <= 0 ||
    width * height > 64_000_000 ||
    template.chunks.length > MAX_TEMPLATE_CHUNKS
  )
    return null

  const indices = new Uint8Array(width * height).fill(TRANSPARENT_INDEX)
  let placed = 0
  let encodedBytes = 0
  for (const chunk of template.chunks) {
    if (generationSignal.aborted) return null
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
    const bytes = await fetchChunkWithinBudget(
      server,
      chunk.hash,
      generationSignal,
      MAX_TEMPLATE_TRANSFER_BYTES - encodedBytes,
    )
    if (bytes === null) return null
    if (!templateTransferWithinBudget(encodedBytes, bytes.byteLength)) return null
    encodedBytes += bytes.byteLength
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
export const serverTemplateKey = (serverUrl: string, id: string): string =>
  `srv:${encodeURIComponent(serverUrl)}:${id}`

/** Templates already in flight, so a second sync while one runs does not download everything twice. */
const inFlight = new Map<string, number>()

/**
 * The version each key's newest manifest asked for.
 *
 * A download that is already running is skipped rather than restarted, which is right — but the
 * manifest that arrives while it runs may have replaced or deleted that template, and installing
 * the finished download then put back artwork nobody publishes any more. This is what the far side
 * of the download checks itself against.
 */
const latestVersion = new Map<string, string>()
const rejectedServerContents = new WeakSet<ServerContents>()

/** Mark a parsed manifest as inadmissible before a blind poll can reconcile it. */
export const rejectServerContentsForSync = (contents: ServerContents): void => {
  rejectedServerContents.add(contents)
}

/**
 * Which generation of a server's connection a download belongs to.
 *
 * A chunk request outlives the connection that asked for it. Disconnecting takes the server's
 * templates away, and a download still in the air then put one back — an overlay with no server row
 * left to poll it or turn it off, until the page reloads. The generation moves when the connection
 * does, so a reply that comes back into a different one is dropped rather than drawn.
 */
const generations = new Map<string, number>()
const generationControllers = new Map<string, { generation: number; controller: AbortController }>()
const templateAttemptCursors = new Map<string, string>()

const generationOf = (serverUrl: string): number => generations.get(serverUrl) ?? 0

const generationSignal = (serverUrl: string, generation: number): AbortSignal => {
  const existing = generationControllers.get(serverUrl)
  if (existing?.generation === generation) return existing.controller.signal
  existing?.controller.abort()
  const controller = new AbortController()
  generationControllers.set(serverUrl, { generation, controller })
  return controller.signal
}

/** Called when a server's templates are taken away, so anything already downloading for it lands stale. */
export const endServerGeneration = (serverUrl: string): void => {
  generationControllers.get(serverUrl)?.controller.abort()
  generationControllers.delete(serverUrl)
  generations.set(serverUrl, generationOf(serverUrl) + 1)
  pendingServerSyncs.delete(serverUrl)
  templateAttemptCursors.delete(serverUrl)
  // A new connection must not queue behind the obsolete drain. The old run's release callback is
  // identity guarded, so it cannot delete the replacement when it eventually settles.
  serverSyncRuns.delete(serverUrl)
  // The versions this server had asked for go with it. Kept, they outlive the connection for the
  // rest of the session, and a second server whose URL extends this one's shares their key prefix.
  const prefix = serverTemplateKey(serverUrl, '')
  for (const key of [...latestVersion.keys()]) {
    if (key.startsWith(prefix)) latestVersion.delete(key)
  }
}

/**
 * Bring one server's templates onto the canvas, and take away what it no longer has.
 *
 * Unpublished ones are drawn too, and the scope sorts that out by itself: the manifest only lists
 * them for an admin code, so a member never sees one and an admin sees exactly what they are about
 * to publish. Being able to look at a draft on the map before releasing it is the point of a draft.
 */
const syncServerTemplatesOnce = async (
  server: ConnectedServer,
  /** The manifest's templates, when the caller has just read them and would only re-read them. */
  known?: readonly ServerTemplate[],
  snapshotCurrent: () => boolean = () => true,
): Promise<void> => {
  const connectionCurrent = (): boolean => isCurrentServerConnection(server)
  if (server.status !== 'connected' || !connectionCurrent() || !snapshotCurrent()) return
  const generation = generationOf(server.url)
  const signal = generationSignal(server.url, generation)
  const current = (): boolean =>
    connectionCurrent() &&
    generationOf(server.url) === generation &&
    !signal.aborted &&
    snapshotCurrent()
  let available = known ?? null
  if (known === undefined) {
    const contents = await listServerContents(server, signal)
    if (!current()) return
    if (contents !== null) {
      snapshotCurrent = () => isLatestServerContents(server.url, contents)
      if (!current()) return
      if (rejectedServerContents.delete(contents)) return
      // The manifest coordinator queues either this admitted snapshot or the previous admitted one
      // when the new response exceeds aggregate budgets. In both cases that explicit authority must
      // replace this blind result rather than being reconciled after it.
      if (pendingServerSyncs.get(server.url)?.known !== undefined) return
    }
    // The folders as well as the templates, because a template's visibility answers to the folders
    // above it and this is the only place that learns of them changing between polls.
    if (contents !== null) rememberNodes(server.url, contents.nodes)
    available = contents?.templates ?? null
  }
  // Could not ask, so nothing is known and nothing changes. Treating this as an empty server took
  // every template off the canvas on a single blip and put them back looking newly arrived.
  if (available === null) return
  if (!current()) return
  const wanted = new Map(
    available.map((template) => [serverTemplateKey(server.url, template.id), template]),
  )

  for (const held of localTemplates()) {
    if (!current()) return
    if (held.serverUrl !== server.url) continue
    if (!wanted.has(held.id)) await forgetServerTemplate(held.id)
  }
  if (!current()) return
  const ourPrefix = serverTemplateKey(server.url, '')
  for (const key of [...latestVersion.keys()]) {
    if (key.startsWith(ourPrefix) && !wanted.has(key)) latestVersion.delete(key)
  }
  for (const [key, template] of wanted) latestVersion.set(key, template.version)

  const orderedTemplates = [...wanted]
  const previousAttempt = templateAttemptCursors.get(server.url)
  const previousIndex = orderedTemplates.findIndex(([key]) => key === previousAttempt)
  const rotatedTemplates =
    previousIndex === -1
      ? orderedTemplates
      : [
          ...orderedTemplates.slice(previousIndex + 1),
          ...orderedTemplates.slice(0, previousIndex + 1),
        ]
  let attemptedTemplates = 0
  for (const [key, template] of rotatedTemplates) {
    if (!current()) return
    const held = localTemplates().find((candidate) => candidate.id === key)
    // The version is the whole point of the sync being cheap: same version, same pixels, nothing to
    // rebuild. Names and folder membership still arrive through the manifest because neither
    // changes the pixel version.
    if (held !== undefined && held.serverVersion === template.version) {
      await updateServerTemplateMetadata(key, template.name, template.nodeId)
      if (!current()) return
      continue
    }
    if (inFlight.get(key) === generation) continue
    // Asked before the download, not after. A server may advertise a manifest far larger than the
    // rendering budget, and decoding a template only to have the store refuse it means an
    // `ImageBitmap` built for every one of them on every poll.
    if (!hasRoomForServerTemplate(key)) continue
    if (attemptedTemplates >= MAX_TEMPLATE_ATTEMPTS_PER_SYNC) break
    attemptedTemplates++
    templateAttemptCursors.set(server.url, key)
    inFlight.set(key, generation)
    try {
      const outcome = await withAssemblySlot(async (): Promise<'continue' | 'stop'> => {
        const attemptSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(MAX_TEMPLATE_ASSEMBLY_MS),
        ])
        const built = await assemble(server, template, attemptSignal)
        if (built === null) return 'continue'
        if (attemptSignal.aborted) return 'continue'
        // The connection this download belongs to may have ended, or a later poll may have taken
        // over this template, while the chunks were in the air.
        if (!current()) return 'stop'
        // A newer manifest landed while the chunks were in the air, and it no longer asks for this
        // version — or no longer asks for this template at all. Installing now would draw artwork
        // that has already been replaced, or bring a deleted overlay back.
        if (latestVersion.get(key) !== template.version) return 'continue'
        if (!hasRoomForServerTemplate(key)) return 'continue'
        // Hold the shared assembly slot through persistence so its decoded buffer cannot pile up
        // behind other completed assemblies while the store is busy.
        const installed = await putServerTemplate(
          {
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
            wrapX: template.bbox.minX > template.bbox.maxX,
          },
          () => current() && latestVersion.get(key) === template.version,
        )
        if (!installed) return 'stop'
        count('server:template drawn from chunks')
        return 'continue'
      })
      if (outcome === 'stop') return
    } catch (error) {
      warn('install', `could not sync server template ${template.name}`, String(error))
    } finally {
      if (inFlight.get(key) === generation) inFlight.delete(key)
    }
  }
}

interface PendingServerSync {
  readonly server: ConnectedServer
  readonly known?: readonly ServerTemplate[]
  readonly snapshotCurrent?: () => boolean
}

/** The newest request per server. Slow downloads must never make minute polls pile up behind them. */
const pendingServerSyncs = new Map<string, PendingServerSync>()
const serverSyncRuns = new Map<string, Promise<void>>()

const ensureServerSyncRun = (serverUrl: string): Promise<void> => {
  const existing = serverSyncRuns.get(serverUrl)
  if (existing !== undefined) return existing
  const generation = generationOf(serverUrl)
  const running = (async () => {
    while (true) {
      if (generationOf(serverUrl) !== generation) return
      const requested = pendingServerSyncs.get(serverUrl)
      if (requested === undefined) return
      pendingServerSyncs.delete(serverUrl)
      await syncServerTemplatesOnce(requested.server, requested.known, requested.snapshotCurrent)
    }
  })()
  serverSyncRuns.set(serverUrl, running)
  const release = (): void => {
    if (serverSyncRuns.get(serverUrl) === running) serverSyncRuns.delete(serverUrl)
  }
  void running.then(release, release)
  return running
}

/**
 * Bring one server up to date, coalescing any polls that arrive while its current download runs.
 *
 * The newest manifest wins. Callers still await the drain that includes their request, while at most
 * one assembly per server can own network, decode, and bitmap memory at a time.
 */
export const syncServerTemplates = async (
  server: ConnectedServer,
  known?: readonly ServerTemplate[],
  snapshotCurrent?: () => boolean,
): Promise<void> => {
  // Immutable state rows may change cosmetic server metadata in place. Credentials, deployment,
  // season, scope, and connectivity define the lifetime that is allowed to continue this work.
  if (!isCurrentServerConnection(server)) return
  if (snapshotCurrent?.() === false) return
  const pending = pendingServerSyncs.get(server.url)
  // A blind poll carries no newer state of its own. If a mutation has already queued the manifest
  // it just read, keep that authoritative snapshot instead of replacing it with a request that may
  // fail or return a stale intermediary. A later explicit snapshot still replaces an older one.
  if (known === undefined && pending?.known !== undefined) {
    pendingServerSyncs.set(server.url, {
      server,
      known: pending.known,
      ...(pending.snapshotCurrent === undefined
        ? {}
        : { snapshotCurrent: pending.snapshotCurrent }),
    })
  } else {
    pendingServerSyncs.set(server.url, {
      server,
      ...(known === undefined ? {} : { known }),
      ...(snapshotCurrent === undefined ? {} : { snapshotCurrent }),
    })
  }
  while (pendingServerSyncs.has(server.url) || serverSyncRuns.has(server.url)) {
    await ensureServerSyncRun(server.url)
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
    const connected = getState().servers.filter((server) => server.status === 'connected')
    if (
      connected.length === lastConnected.length &&
      lastConnected.every((previous) => isCurrentServerConnection(previous))
    ) {
      lastConnected = connected
      return
    }
    for (const previous of lastConnected) {
      if (!isCurrentServerConnection(previous)) {
        endServerGeneration(previous.url)
      }
    }
    lastConnected = connected
    syncAll()
  })
}

/** Which servers were connected last time state changed, so an unrelated setting does not resync. */
let lastConnected: readonly ConnectedServer[] = []
