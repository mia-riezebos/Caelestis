import {
  decodePng,
  encodeIndexedPng,
  millis,
  type PixelBounds,
  type QuantiseReport,
  quantiseToPalette,
  sha256Hex,
  sliceTemplate,
  type TileKey,
  tileKey,
  uuidV7,
} from '@wts/shared'
import type { Ports, TemplateVersionRecord } from '../ports/index.js'
import { NodeNotFoundError } from '../ports/index.js'

export interface StoreTemplateInput {
  /**
   * The template these pixels belong to, or absent to mint a new one.
   *
   * Supplying it is what makes this a *new version* of something that already exists: the chunks are
   * re-sliced and re-uploaded, a fresh version id becomes current, and the template's own row keeps
   * its name, parent, published state and creation date.
   */
  readonly templateId?: string
  readonly nodeId: string
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
  readonly published: false
}

/**
 * Tiles one upload may cover.
 *
 * Every chunk costs an R2 HEAD, an R2 PUT, a compression and a share of a D1 batch statement, so the
 * bound is on the pipeline rather than on the image: 512 tiles is a 512,000-pixel span in one
 * dimension, far beyond a placed template, and keeps the batch, the subrequest count and the
 * concurrent compressions comfortably inside a Worker invocation.
 */
const MAX_TEMPLATE_CHUNKS = 512

/** An upload the pipeline refuses for a reason the client can act on — answered as 400, not 500. */
export class StoreTemplateError extends Error {
  override readonly name = 'StoreTemplateError'
}

export const storeTemplate = async (
  ports: Pick<Ports, 'blobs' | 'sql'>,
  input: StoreTemplateInput,
): Promise<StoredTemplate> => {
  const node = await ports.sql.readNode(input.nodeId)
  if (node === null) throw new NodeNotFoundError(`node does not exist: ${input.nodeId}`)

  const { width, height, pixels } = await decodePng(input.png)
  const { indices, report } = quantiseToPalette(pixels)
  const sliced = sliceTemplate(indices, width, height, input.originX, input.originY)
  // A cap on tiles, not just on pixels. MAX_PIXELS permits a 1,999,000x2 image, which slices to
  // ~4,000 chunks: ~170 batch statements against D1's 50 per invocation, ~8,000 R2 subrequests
  // against a limit of 1,000, and 4,000 concurrent compressions — from an upload a few kilobytes
  // long, because two rows of one colour deflate to nothing. Raising the row batching moved that
  // cliff; it did not remove it.
  if (sliced.chunks.length > MAX_TEMPLATE_CHUNKS) {
    throw new StoreTemplateError(
      `template covers ${sliced.chunks.length} tiles, more than the ${MAX_TEMPLATE_CHUNKS} one upload may carry`,
    )
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
  await ports.sql.insertTemplateVersion(version)

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
    published: false,
  }
}
