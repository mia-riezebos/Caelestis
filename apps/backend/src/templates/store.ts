import {
  decodePng,
  decodeWplaceIndexedPng,
  encodeIndexedPng,
  millis,
  type PixelBounds,
  type QuantiseReport,
  quantiseToPalette,
  sha256Hex,
  sliceTemplate,
  type TileKey,
  TRANSPARENT_INDEX,
  tileKey,
  uuidV7,
  WORLD_PIXELS,
} from '@caelestis/shared'
import type { Ports, TemplateVersionRecord } from '../ports/index.js'
import { NodeNotFoundError, TemplateIdentityError, TemplateNotFoundError } from '../ports/index.js'

export interface StoreTemplateInput {
  /**
   * The template these pixels belong to, or absent to mint a new one.
   *
   * Supplying it is what makes this a *new version* of something that already exists: the chunks are
   * re-sliced and re-uploaded, a fresh version id becomes current, and the template's own row keeps
   * its name, parent, published state and creation date.
   */
  readonly templateId?: string
  readonly season: number
  readonly nodeId: string | null
  readonly name: string
  readonly createdWithToken: string
  /** The uploader's wplace account when the client presented one; null for a server-side upload. */
  readonly createdByUserId: number | null
  readonly originX: number
  readonly originY: number
  readonly png: Uint8Array
}

export interface StoredTemplate {
  readonly templateId: string
  readonly versionId: string
  readonly bbox: PixelBounds
  readonly totalPixels: number
  readonly chunks: readonly { readonly tile: TileKey; readonly hash: string }[]
  readonly report: QuantiseReport
  readonly published: boolean
}

/**
 * Tiles one upload may cover.
 *
 * Every chunk costs an R2 HEAD, an R2 PUT, a compression and a share of a D1 batch statement, so the
 * bound is on the pipeline rather than on the image: 400 tiles is a 400,000-pixel span in one
 * dimension, far beyond a placed template.
 *
 * The number comes from the Workers Free plan's 1,000 internal subrequests, which R2 and D1 binding
 * calls both count against. `hasAll` is one HEAD per distinct hash, because R2 has no bulk existence
 * operation, and a first upload has no hash already present — so the worst case is 400 HEADs, 400
 * PUTs and roughly twenty batch statements, a little over 800. At 512 the same upload asked for more
 * than a thousand and failed after writing part of its chunks, leaving those orphaned.
 */
const MAX_TEMPLATE_CHUNKS = 400

/** An upload the pipeline refuses for a reason the client can act on — answered as 400, not 500. */
export class StoreTemplateError extends Error {
  override readonly name = 'StoreTemplateError'
}

const exactPaletteReport = (indices: Uint8Array): QuantiseReport => {
  let opaquePixels = 0
  const used = new Set<number>()
  for (const index of indices) {
    if (index === TRANSPARENT_INDEX) continue
    opaquePixels += 1
    used.add(index)
  }
  return {
    opaquePixels,
    movedPixels: 0,
    distinctColours: used.size,
    distinctPaletteEntries: used.size,
    meanDistance: 0,
    maxDistance: 0,
  }
}

export const storeTemplate = async (
  ports: Pick<Ports, 'blobs' | 'sql'>,
  input: StoreTemplateInput,
): Promise<StoredTemplate> => {
  if (input.templateId === undefined && input.nodeId !== null) {
    const node = await ports.sql.readNode(input.nodeId)
    if (node === null) throw new NodeNotFoundError(`node does not exist: ${input.nodeId}`)
    if (node.season !== input.season) {
      throw new NodeNotFoundError(`node does not exist in season ${input.season}: ${input.nodeId}`)
    }
  }

  const indexed = await decodeWplaceIndexedPng(input.png)
  const decoded = indexed ?? (await decodePng(input.png))
  const { width, height } = decoded
  const { indices, report } =
    'indices' in decoded
      ? { indices: decoded.indices, report: exactPaletteReport(decoded.indices) }
      : quantiseToPalette(decoded.pixels)
  const sliced = sliceTemplate(indices, width, height, input.originX, input.originY)
  // Bound the storage work, not the image area. A 1,999,000x2 image slices to ~4,000 chunks: ~170
  // batch statements against D1's 50 per invocation, ~8,000 R2 subrequests against a limit of 1,000,
  // and 4,000 concurrent compressions — from an upload a few kilobytes long, because two rows of one
  // colour deflate to nothing. A large template covering an ordinary number of tiles remains valid.
  if (sliced.chunks.length > MAX_TEMPLATE_CHUNKS) {
    throw new StoreTemplateError(
      `template covers ${sliced.chunks.length} tiles, more than the ${MAX_TEMPLATE_CHUNKS} one upload may carry`,
    )
  }

  if (input.templateId !== undefined) {
    const existing = await ports.sql.readTemplate(input.templateId)
    if (existing === null) {
      throw new TemplateNotFoundError(`template does not exist: ${input.templateId}`)
    }
    if (existing.currentVersionId !== null) {
      const current = await ports.sql.readTemplateVersion(existing.currentVersionId)
      if (current === null) {
        throw new TemplateNotFoundError(
          `current version does not exist: ${existing.currentVersionId}`,
        )
      }
      const span = (min: number, max: number) => (max >= min ? max - min : WORLD_PIXELS - min + max)
      const wasWidth = span(current.bbox.minX, current.bbox.maxX)
      const wasHeight = current.bbox.maxY - current.bbox.minY
      const nowWidth = span(sliced.bbox.minX, sliced.bbox.maxX)
      const nowHeight = sliced.bbox.maxY - sliced.bbox.minY
      if (wasWidth !== nowWidth || wasHeight !== nowHeight) {
        throw new TemplateIdentityError(
          `template ${input.templateId} is ${wasWidth}x${wasHeight}, not ${nowWidth}x${nowHeight}`,
        )
      }
    }
  }

  const encodedChunks = await Promise.all(
    sliced.chunks.map(async (chunk) => {
      const png = await encodeIndexedPng(chunk.width, chunk.height, chunk.indices)
      return { chunk, png, hash: await sha256Hex(png) }
    }),
  )

  // Several tiles can contain the same cropped image. Content addressing means one upload per
  // distinct hash is enough even when the version index refers to that hash more than once.
  const pngByHash = new Map(encodedChunks.map(({ hash, png }) => [hash, png]))
  const present = await ports.blobs.hasAll('chunks', [...pngByHash.keys()])
  await Promise.all(
    [...pngByHash].map(async ([hash, png]) => {
      if (!present.has(hash)) await ports.blobs.put('chunks', hash, png)
    }),
  )

  const templateId = input.templateId ?? uuidV7()
  const versionId = uuidV7()
  const createdAt = millis(Date.now())
  const versionChunks = encodedChunks.map(({ chunk, hash }) => ({
    tileX: chunk.tileX,
    tileY: chunk.tileY,
    hash,
  }))
  const version: TemplateVersionRecord = {
    templateId,
    season: input.season,
    nodeId: input.nodeId,
    name: input.name,
    versionId,
    createdWithToken: input.createdWithToken,
    createdByUserId: input.createdByUserId,
    createdAt,
    bbox: sliced.bbox,
    totalPixels: sliced.totalPixels,
    chunks: versionChunks,
  }
  await ports.sql.insertTemplateVersion(version, {
    requireExisting: input.templateId !== undefined,
  })
  const installed = await ports.sql.readTemplate(templateId)
  if (installed === null) {
    throw new TemplateNotFoundError(`template does not exist: ${templateId}`)
  }

  return {
    templateId,
    versionId,
    bbox: sliced.bbox,
    totalPixels: sliced.totalPixels,
    chunks: versionChunks.map(({ tileX, tileY, hash }) => ({
      tile: tileKey({ x: tileX, y: tileY }),
      hash,
    })),
    report,
    published: installed.published,
  }
}
