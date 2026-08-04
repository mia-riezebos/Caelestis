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

export interface StoreTemplateInput {
  readonly nodeId: string
  readonly name: string
  readonly season: number
  readonly createdBy: string
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
}

export const storeTemplate = async (
  ports: Pick<Ports, 'blobs' | 'sql'>,
  input: StoreTemplateInput,
): Promise<StoredTemplate> => {
  const { width, height, pixels } = await decodePng(input.png)
  const { indices, report } = quantiseToPalette(pixels)
  const sliced = sliceTemplate(indices, width, height, input.originX, input.originY)

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

  const templateId = uuidV7()
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
    season: input.season,
    versionId,
    createdBy: input.createdBy,
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
  }
}
