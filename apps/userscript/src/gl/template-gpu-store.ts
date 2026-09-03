import { PALETTE_SIZE, TRANSPARENT_INDEX } from '@caelestis/shared'
import { measureProfileDetail } from '../profile.js'
import type { PlacedTemplate } from '../templates/local-store.js'
import { gpuCacheEvictions } from './gpu-cache.js'

export const TEMPLATE_GPU_CACHE_BYTES = 64 * 1024 * 1024
export const TEMPLATE_UPLOAD_PIXELS_PER_FRAME = 512 * 1024

export interface TemplateGpuTile {
  readonly texture: WebGLTexture
  /** Top-left and size of the non-halo source cells in template coordinates. */
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly textureWidth: number
  readonly textureHeight: number
  readonly inset: number
}

interface PendingTemplateGpuTile {
  texture: WebGLTexture | null
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly textureWidth: number
  readonly textureHeight: number
  readonly inset: number
  uploadedPixels: number
}

interface PendingTemplateGpu {
  readonly indices: readonly PendingTemplateGpuTile[]
  readonly palette: WebGLTexture
  readonly width: number
  readonly height: number
  readonly source: Uint8Array
  lastUsed: number
}

export interface TemplateGpuEntry {
  readonly indices: readonly TemplateGpuTile[]
  readonly palette: WebGLTexture
  readonly width: number
  readonly height: number
  readonly source: Uint8Array
  lastUsed: number
  paletteData: Uint8Array | null
}

export interface TemplateGpuAdvance {
  readonly entry: TemplateGpuEntry | null
  readonly status: 'complete' | 'pending' | 'failed'
  readonly uploadedPixels: number
}

type TemplateSource = Pick<PlacedTemplate, 'id' | 'width' | 'height' | 'indices'>

const entryBytes = (entry: TemplateGpuEntry | PendingTemplateGpu): number =>
  PALETTE_SIZE * 4 +
  entry.indices.reduce((total, tile) => total + tile.textureWidth * tile.textureHeight, 0)

/**
 * Owns palette-index textures for one WebGL context.
 *
 * Both renderer adapters use this module. It hides device-sized chunking, outline halos,
 * progressive uploads, source replacement, and bounded warm caching behind one interface.
 */
export class TemplateGpuStore {
  private readonly complete = new Map<string, TemplateGpuEntry>()
  private readonly pending = new Map<string, PendingTemplateGpu>()
  private readonly maximumTextureSize: number | null

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly maximumBytes = TEMPLATE_GPU_CACHE_BYTES,
  ) {
    let measured: unknown = null
    try {
      measured = gl.getParameter(gl.MAX_TEXTURE_SIZE)
    } catch {}
    this.maximumTextureSize =
      typeof measured === 'number' && Number.isFinite(measured) && measured > 0
        ? Math.max(1, Math.floor(measured))
        : null
  }

  memoryBytes(): number {
    let bytes = 0
    for (const entry of this.complete.values()) bytes += entryBytes(entry)
    for (const entry of this.pending.values()) bytes += entryBytes(entry)
    return bytes
  }

  entry(id: string): TemplateGpuEntry | null {
    return this.complete.get(id) ?? null
  }

  hasCurrent(template: TemplateSource): boolean {
    const entry = this.complete.get(template.id)
    return (
      entry !== undefined &&
      entry.source === template.indices &&
      entry.width === template.width &&
      entry.height === template.height
    )
  }

  uploadPalette(entry: TemplateGpuEntry, data: Uint8Array): void {
    if (
      entry.paletteData !== null &&
      entry.paletteData.length === data.length &&
      entry.paletteData.every((value, index) => value === data[index])
    )
      return
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, entry.palette)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, PALETTE_SIZE, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    entry.paletteData = data.slice()
  }

  private textureLimit(width: number, height: number): number {
    return this.maximumTextureSize ?? Math.max(width, height) + 2
  }

  private plan(width: number, height: number): readonly PendingTemplateGpuTile[] {
    const allocationLimit = this.textureLimit(width, height)
    const inset = allocationLimit >= 3 ? 1 : 0
    const contentLimit = Math.max(1, allocationLimit - inset * 2)
    const pending: PendingTemplateGpuTile[] = []
    for (let y = 0; y < height; y += contentLimit) {
      const tileHeight = Math.min(contentLimit, height - y)
      for (let x = 0; x < width; x += contentLimit) {
        const tileWidth = Math.min(contentLimit, width - x)
        pending.push({
          texture: null,
          x,
          y,
          width: tileWidth,
          height: tileHeight,
          textureWidth: tileWidth + inset * 2,
          textureHeight: tileHeight + inset * 2,
          inset,
          uploadedPixels: 0,
        })
      }
    }
    return pending
  }

  private allocate(texture: WebGLTexture, width: number, height: number): void {
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R8UI,
      width,
      height,
      0,
      gl.RED_INTEGER,
      gl.UNSIGNED_BYTE,
      null,
    )
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  }

  private fill(
    pending: PendingTemplateGpu,
    tile: PendingTemplateGpuTile,
    uploadX: number,
    uploadY: number,
    uploadWidth: number,
    uploadHeight: number,
  ): Uint8Array {
    const pixels = new Uint8Array(uploadWidth * uploadHeight).fill(TRANSPARENT_INDEX)
    const textureLeft = tile.x - tile.inset
    for (let row = 0; row < uploadHeight; row++) {
      const textureY = uploadY + row
      const destination = row * uploadWidth
      const sourceY = tile.y - tile.inset + textureY
      if (sourceY < 0 || sourceY >= pending.height) continue
      const requestedLeft = textureLeft + uploadX
      const sourceLeft = Math.max(0, requestedLeft)
      const sourceRight = Math.min(pending.width, requestedLeft + uploadWidth)
      if (sourceRight <= sourceLeft) continue
      const source = sourceY * pending.width + sourceLeft
      pixels.set(
        pending.source.subarray(source, source + sourceRight - sourceLeft),
        destination + sourceLeft - requestedLeft,
      )
    }
    return pixels
  }

  private advanceUpload(pending: PendingTemplateGpu, allowance: number): TemplateGpuAdvance {
    const gl = this.gl
    let left = Math.max(0, Math.floor(allowance))
    let uploadedPixels = 0
    for (const tile of pending.indices) {
      const total = tile.textureWidth * tile.textureHeight
      if (tile.uploadedPixels >= total) continue
      if (left === 0) return { entry: null, status: 'pending', uploadedPixels }
      if (tile.texture === null) {
        const texture = gl.createTexture()
        if (texture === null) return { entry: null, status: 'failed', uploadedPixels }
        tile.texture = texture
        measureProfileDetail('Overlay texture allocation', () =>
          this.allocate(texture, tile.textureWidth, tile.textureHeight),
        )
      }
      gl.bindTexture(gl.TEXTURE_2D, tile.texture)
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
      while (tile.uploadedPixels < total && left > 0) {
        const uploadY = Math.floor(tile.uploadedPixels / tile.textureWidth)
        const uploadX = tile.uploadedPixels - uploadY * tile.textureWidth
        const uploadWidth =
          uploadX === 0 && left >= tile.textureWidth
            ? tile.textureWidth
            : Math.min(tile.textureWidth - uploadX, left)
        const uploadHeight =
          uploadX === 0 && uploadWidth === tile.textureWidth
            ? Math.min(tile.textureHeight - uploadY, Math.max(1, Math.floor(left / uploadWidth)))
            : 1
        const count = uploadWidth * uploadHeight
        const pixels = measureProfileDetail('Overlay index staging', () =>
          this.fill(pending, tile, uploadX, uploadY, uploadWidth, uploadHeight),
        )
        measureProfileDetail('Overlay index upload', () =>
          gl.texSubImage2D(
            gl.TEXTURE_2D,
            0,
            uploadX,
            uploadY,
            uploadWidth,
            uploadHeight,
            gl.RED_INTEGER,
            gl.UNSIGNED_BYTE,
            pixels,
          ),
        )
        tile.uploadedPixels += count
        uploadedPixels += count
        left -= count
      }
    }

    const indices: TemplateGpuTile[] = []
    for (const tile of pending.indices) {
      if (tile.texture === null || tile.uploadedPixels < tile.textureWidth * tile.textureHeight)
        return { entry: null, status: 'pending', uploadedPixels }
      indices.push({
        texture: tile.texture,
        x: tile.x,
        y: tile.y,
        width: tile.width,
        height: tile.height,
        textureWidth: tile.textureWidth,
        textureHeight: tile.textureHeight,
        inset: tile.inset,
      })
    }
    const entry: TemplateGpuEntry = {
      indices,
      palette: pending.palette,
      width: pending.width,
      height: pending.height,
      source: pending.source,
      lastUsed: pending.lastUsed,
      paletteData: null,
    }
    return { entry, status: 'complete', uploadedPixels }
  }

  advance(template: TemplateSource, allowance: number, generation: number): TemplateGpuAdvance {
    let entry = this.complete.get(template.id)
    let pending = this.pending.get(template.id)
    const changed =
      (entry !== undefined &&
        (entry.source !== template.indices ||
          entry.width !== template.width ||
          entry.height !== template.height)) ||
      (pending !== undefined &&
        (pending.source !== template.indices ||
          pending.width !== template.width ||
          pending.height !== template.height))
    if (changed) {
      this.release(template.id)
      entry = undefined
      pending = undefined
    }
    if (entry !== undefined) {
      entry.lastUsed = generation
      return { entry, status: 'complete', uploadedPixels: 0 }
    }
    if (pending === undefined) {
      const palette = this.gl.createTexture()
      if (palette === null) return { entry: null, status: 'failed', uploadedPixels: 0 }
      pending = {
        indices: measureProfileDetail('Overlay upload planning', () =>
          this.plan(template.width, template.height),
        ),
        palette,
        width: template.width,
        height: template.height,
        source: template.indices,
        lastUsed: generation,
      }
      this.pending.set(template.id, pending)
    }
    pending.lastUsed = generation
    const advanced = this.advanceUpload(pending, allowance)
    if (advanced.status === 'failed') {
      this.release(template.id)
      return advanced
    }
    if (advanced.entry === null) return advanced
    this.pending.delete(template.id)
    this.complete.set(template.id, advanced.entry)
    return advanced
  }

  release(id: string): void {
    measureProfileDetail('Overlay texture deletion', () => {
      const existing = this.complete.get(id)
      if (existing !== undefined) {
        for (const tile of existing.indices) this.gl.deleteTexture(tile.texture)
        this.gl.deleteTexture(existing.palette)
        this.complete.delete(id)
      }
      const pending = this.pending.get(id)
      if (pending !== undefined) {
        for (const tile of pending.indices) {
          if (tile.texture !== null) this.gl.deleteTexture(tile.texture)
        }
        this.gl.deleteTexture(pending.palette)
        this.pending.delete(id)
      }
    })
  }

  collect(existing: ReadonlySet<string>, visible: ReadonlySet<string>): void {
    const records = [...this.complete].map(([id, entry]) => ({
      id,
      bytes: entryBytes(entry),
      lastUsed: entry.lastUsed,
      visible: visible.has(id),
      exists: existing.has(id),
    }))
    for (const [id, entry] of this.pending) {
      records.push({
        id,
        bytes: entryBytes(entry),
        lastUsed: entry.lastUsed,
        visible: visible.has(id),
        exists: existing.has(id),
      })
    }
    for (const id of gpuCacheEvictions(records, this.maximumBytes)) this.release(id)
  }

  dispose(): void {
    for (const id of new Set([...this.complete.keys(), ...this.pending.keys()])) this.release(id)
  }
}
