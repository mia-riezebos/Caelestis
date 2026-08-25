import { TILE_SIZE } from './tiles.js'

const MAGIC = new Uint8Array([0x43, 0x4d, 0x4d, 0x31])
const HEADER_BYTES = 12
const PIXELS_PER_BYTE = 4

export const MATCH = 0
export const WRONG = 1
export const BLANK = 2

export type MismatchClass = typeof MATCH | typeof WRONG | typeof BLANK

export interface MismatchMask {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
  readonly packed: Uint8Array
}

const validRect = (left: number, top: number, width: number, height: number): boolean =>
  Number.isSafeInteger(left) &&
  Number.isSafeInteger(top) &&
  Number.isSafeInteger(width) &&
  Number.isSafeInteger(height) &&
  left >= 0 &&
  top >= 0 &&
  width > 0 &&
  height > 0 &&
  left + width <= TILE_SIZE &&
  top + height <= TILE_SIZE

export const encodeMismatchMask = (
  rect: Pick<MismatchMask, 'left' | 'top' | 'width' | 'height'>,
  classifications: Uint8Array,
): Uint8Array => {
  if (!validRect(rect.left, rect.top, rect.width, rect.height)) {
    throw new RangeError('mismatch mask rectangle must fit one canvas tile')
  }
  const pixels = rect.width * rect.height
  if (classifications.length !== pixels) {
    throw new RangeError('mismatch mask classifications must cover its rectangle')
  }
  const encoded = new Uint8Array(HEADER_BYTES + Math.ceil(pixels / PIXELS_PER_BYTE))
  encoded.set(MAGIC)
  const view = new DataView(encoded.buffer)
  view.setUint16(4, rect.left, true)
  view.setUint16(6, rect.top, true)
  view.setUint16(8, rect.width, true)
  view.setUint16(10, rect.height, true)
  for (let index = 0; index < classifications.length; index += 1) {
    const classification = classifications[index]
    if (classification === undefined || classification > BLANK) {
      throw new RangeError('mismatch mask contains an unknown classification')
    }
    const byteAt = HEADER_BYTES + Math.floor(index / PIXELS_PER_BYTE)
    encoded[byteAt] = (encoded[byteAt] ?? 0) | (classification << ((index % PIXELS_PER_BYTE) * 2))
  }
  return encoded
}

export const decodeMismatchMask = (bytes: Uint8Array): MismatchMask | null => {
  if (bytes.length < HEADER_BYTES || MAGIC.some((byte, index) => bytes[index] !== byte)) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const left = view.getUint16(4, true)
  const top = view.getUint16(6, true)
  const width = view.getUint16(8, true)
  const height = view.getUint16(10, true)
  if (!validRect(left, top, width, height)) return null
  const packedBytes = Math.ceil((width * height) / PIXELS_PER_BYTE)
  if (bytes.length !== HEADER_BYTES + packedBytes) return null
  const packed = bytes.subarray(HEADER_BYTES)
  for (let index = 0; index < width * height; index += 1) {
    if (
      (((packed[Math.floor(index / PIXELS_PER_BYTE)] ?? 0) >> ((index % 4) * 2)) & 0b11) >
      BLANK
    ) {
      return null
    }
  }
  return { left, top, width, height, packed }
}

export const mismatchClassAt = (mask: MismatchMask, x: number, y: number): MismatchClass | null => {
  if (
    !Number.isSafeInteger(x) ||
    !Number.isSafeInteger(y) ||
    x < mask.left ||
    y < mask.top ||
    x >= mask.left + mask.width ||
    y >= mask.top + mask.height
  )
    return null
  const index = (y - mask.top) * mask.width + (x - mask.left)
  return (((mask.packed[Math.floor(index / PIXELS_PER_BYTE)] ?? 0) >> ((index % 4) * 2)) &
    0b11) as MismatchClass
}
