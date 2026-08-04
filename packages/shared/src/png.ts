/**
 * A deliberately small PNG codec.
 *
 * It exists because template ingest runs in a Worker, where there is no canvas and no native image
 * library — `sharp` and friends are Node addons. The alternative was a general-purpose pure-JS
 * decoder; this handles only what this system produces and consumes, and **rejects everything else
 * loudly**.
 *
 * That narrowness is the point rather than a shortcut. Uploads are admin-only and rare, so a narrow
 * input surface costs an operator one clear error message and removes a large class of parser bug
 * from a path that writes to permanent storage.
 *
 * Supported on the way in: 8-bit non-interlaced greyscale, RGB, indexed, greyscale+alpha and RGBA.
 * Rejected: 16-bit, interlaced, and anything whose header does not parse.
 *
 * Out: 8-bit indexed with a transparent entry at index 0.
 *
 * Deflate comes from the platform (`CompressionStream`), which both workerd and Node provide, so
 * there is no bundled zlib.
 */

import { PALETTE_RGB, PALETTE_SIZE, TRANSPARENT_INDEX } from './palette.js'

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** Bytes per pixel for each supported colour type, indexed by the type's own code. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff
  for (const byte of bytes) {
    // biome-ignore lint/style/noNonNullAssertion: the index is masked to a byte
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

const inflate = async (bytes: Uint8Array): Promise<Uint8Array> => {
  // 'deflate' is the zlib-wrapped form, which is what PNG's IDAT carries.
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

const deflate = async (bytes: Uint8Array): Promise<Uint8Array> => {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** An image decoded to straight RGBA, one byte per channel. */
export interface RgbaImage {
  readonly width: number
  readonly height: number
  /** `width * height * 4` bytes. */
  readonly pixels: Uint8Array
}

export class PngError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PngError'
  }
}

/**
 * Undo the per-scanline filter.
 *
 * Filters are defined over the *reconstructed* bytes of the previous scanline, so this has to run in
 * order and cannot be parallelised. `bpp` is the byte distance to the pixel on the left, which is
 * 1 for sub-byte-per-pixel formats — but we only accept 8-bit depths, so it is the channel count.
 */
const unfilter = (raw: Uint8Array, width: number, height: number, bpp: number): Uint8Array => {
  const stride = width * bpp
  const out = new Uint8Array(stride * height)
  let offset = 0
  for (let row = 0; row < height; row += 1) {
    const filter = raw[offset]
    offset += 1
    const line = out.subarray(row * stride, (row + 1) * stride)
    const previous =
      row === 0 ? new Uint8Array(stride) : out.subarray((row - 1) * stride, row * stride)
    for (let index = 0; index < stride; index += 1) {
      const value = raw[offset + index] ?? 0
      const left = index >= bpp ? (line[index - bpp] ?? 0) : 0
      const up = previous[index] ?? 0
      const upLeft = index >= bpp ? (previous[index - bpp] ?? 0) : 0
      let reconstructed: number
      switch (filter) {
        case 0:
          reconstructed = value
          break
        case 1:
          reconstructed = value + left
          break
        case 2:
          reconstructed = value + up
          break
        case 3:
          reconstructed = value + ((left + up) >> 1)
          break
        case 4: {
          // Paeth: pick whichever neighbour the linear predictor lands closest to.
          const estimate = left + up - upLeft
          const dLeft = Math.abs(estimate - left)
          const dUp = Math.abs(estimate - up)
          const dUpLeft = Math.abs(estimate - upLeft)
          reconstructed =
            value + (dLeft <= dUp && dLeft <= dUpLeft ? left : dUp <= dUpLeft ? up : upLeft)
          break
        }
        default:
          throw new PngError(`unsupported scanline filter ${filter}`)
      }
      line[index] = reconstructed & 0xff
    }
    offset += stride
  }
  return out
}

/** Decode a PNG to straight (non-premultiplied) RGBA. */
export const decodePng = async (bytes: Uint8Array): Promise<RgbaImage> => {
  for (const [index, expected] of SIGNATURE.entries()) {
    if (bytes[index] !== expected) throw new PngError('not a PNG')
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = SIGNATURE.length
  let header: { width: number; height: number; depth: number; colourType: number } | null = null
  let palette: Uint8Array | null = null
  let alphas: Uint8Array | null = null
  const idat: Uint8Array[] = []

  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset)
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    offset += 12 + length

    if (type === 'IHDR') {
      const depth = data[8] ?? 0
      const colourType = data[9] ?? 0
      if (depth !== 8) throw new PngError(`unsupported bit depth ${depth}; only 8 is accepted`)
      if (CHANNELS[colourType] === undefined) {
        throw new PngError(`unsupported colour type ${colourType}`)
      }
      if (data[12] !== 0) throw new PngError('interlaced PNGs are not accepted')
      header = {
        width: view.getUint32(offset - 12 - length + 8),
        height: view.getUint32(offset - 12 - length + 12),
        depth,
        colourType,
      }
    } else if (type === 'PLTE') palette = data
    else if (type === 'tRNS') alphas = data
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
  }

  if (header === null) throw new PngError('missing IHDR')
  if (idat.length === 0) throw new PngError('missing IDAT')

  const { width, height, colourType } = header
  if (width === 0 || height === 0) throw new PngError('image has no pixels')

  const compressed = new Uint8Array(idat.reduce((total, part) => total + part.length, 0))
  let cursor = 0
  for (const part of idat) {
    compressed.set(part, cursor)
    cursor += part.length
  }

  // biome-ignore lint/style/noNonNullAssertion: colourType was checked against CHANNELS above
  const channels = CHANNELS[colourType]!
  const raw = unfilter(await inflate(compressed), width, height, channels)

  const pixels = new Uint8Array(width * height * 4)
  for (let index = 0; index < width * height; index += 1) {
    const source = index * channels
    const target = index * 4
    switch (colourType) {
      case 0:
      case 4: {
        const grey = raw[source] ?? 0
        pixels[target] = grey
        pixels[target + 1] = grey
        pixels[target + 2] = grey
        pixels[target + 3] = colourType === 4 ? (raw[source + 1] ?? 255) : 255
        break
      }
      case 2:
      case 6:
        pixels[target] = raw[source] ?? 0
        pixels[target + 1] = raw[source + 1] ?? 0
        pixels[target + 2] = raw[source + 2] ?? 0
        pixels[target + 3] = colourType === 6 ? (raw[source + 3] ?? 255) : 255
        break
      case 3: {
        if (palette === null) throw new PngError('indexed PNG without a PLTE chunk')
        const entry = (raw[source] ?? 0) * 3
        if (entry + 2 >= palette.length + 3) throw new PngError('palette index out of range')
        pixels[target] = palette[entry] ?? 0
        pixels[target + 1] = palette[entry + 1] ?? 0
        pixels[target + 2] = palette[entry + 2] ?? 0
        // tRNS on an indexed image is a per-entry alpha table, defaulting to opaque past its end.
        pixels[target + 3] = alphas?.[raw[source] ?? 0] ?? 255
        break
      }
      default:
        throw new PngError(`unsupported colour type ${colourType}`)
    }
  }

  return { width, height, pixels }
}

const chunk = (type: string, data: Uint8Array): Uint8Array => {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (const [index, character] of [...type].entries()) out[4 + index] = character.charCodeAt(0)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/**
 * Encode wplace palette indices as an indexed PNG.
 *
 * **The full 64-entry palette is written every time**, even for an image using three colours. The
 * PLTE costs 192 bytes and buys the thing that matters: a byte in the stored chunk *is* wplace's
 * palette index, with no per-image mapping to carry alongside it or to get wrong later. A subset
 * palette would make the same index mean different colours in different chunks.
 *
 * Transparent is index 63, wplace's own convention, so `tRNS` has to be a 64-byte table — opaque for
 * every real colour and zero for the last. Storing it anywhere else would mean translating on every
 * read.
 *
 * Scanlines are written with filter 0. Filtering helps photographic data and does nothing useful for
 * palette indices, where neighbouring bytes are unrelated small integers — deflate does the work.
 */
export const encodeIndexedPng = async (
  width: number,
  height: number,
  indices: Uint8Array,
  palette: ReadonlyArray<readonly [number, number, number]> = PALETTE_RGB,
): Promise<Uint8Array> => {
  if (indices.length !== width * height) {
    throw new PngError(`expected ${width * height} indices, received ${indices.length}`)
  }
  if (palette.length > TRANSPARENT_INDEX) {
    throw new PngError(`palette exceeds ${TRANSPARENT_INDEX} opaque entries`)
  }

  const ihdr = new Uint8Array(13)
  const header = new DataView(ihdr.buffer)
  header.setUint32(0, width)
  header.setUint32(4, height)
  ihdr[8] = 8
  ihdr[9] = 3

  const plte = new Uint8Array(PALETTE_SIZE * 3)
  for (const [index, [red, green, blue]] of palette.entries()) {
    plte[index * 3] = red
    plte[index * 3 + 1] = green
    plte[index * 3 + 2] = blue
  }
  // Opaque for every real colour, zero for the transparent slot at the end.
  const trns = new Uint8Array(PALETTE_SIZE).fill(255)
  trns[TRANSPARENT_INDEX] = 0

  const raw = new Uint8Array((width + 1) * height)
  for (let row = 0; row < height; row += 1) {
    raw[row * (width + 1)] = 0
    raw.set(indices.subarray(row * width, (row + 1) * width), row * (width + 1) + 1)
  }

  const parts = [
    new Uint8Array(SIGNATURE),
    chunk('IHDR', ihdr),
    chunk('PLTE', plte),
    chunk('tRNS', trns),
    chunk('IDAT', await deflate(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let cursor = 0
  for (const part of parts) {
    out.set(part, cursor)
    cursor += part.length
  }
  return out
}
