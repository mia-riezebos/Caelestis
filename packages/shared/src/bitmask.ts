/**
 * Row-major bitmasks as base64, MSB first. Shared by draft masks and freeform region claims.
 * Hand-rolled because `btoa` is not available in every runtime this package runs in.
 */

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const BASE64_INDEX = new Map(Array.from(BASE64, (char, index) => [char, index]))

export const bytesToBase64 = (bytes: Uint8Array): string => {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const c = bytes[i + 2] ?? 0
    const triple = (a << 16) | (b << 8) | c
    out += BASE64[(triple >> 18) & 63] ?? ''
    out += BASE64[(triple >> 12) & 63] ?? ''
    out += i + 1 < bytes.length ? (BASE64[(triple >> 6) & 63] ?? '') : '='
    out += i + 2 < bytes.length ? (BASE64[triple & 63] ?? '') : '='
  }
  return out
}

export const base64ToBytes = (text: string): Uint8Array | null => {
  if (text.length % 4 !== 0) return null
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0
  const bytes = new Uint8Array((text.length / 4) * 3 - padding)
  let at = 0
  for (let i = 0; i < text.length; i += 4) {
    const values = [0, 1, 2, 3].map((offset) => {
      const char = text[i + offset]
      if (char === '=') return 0
      return char === undefined ? -1 : (BASE64_INDEX.get(char) ?? -1)
    })
    if (values.some((value) => value < 0)) return null
    const triple =
      ((values[0] ?? 0) << 18) |
      ((values[1] ?? 0) << 12) |
      ((values[2] ?? 0) << 6) |
      (values[3] ?? 0)
    if (at < bytes.length) bytes[at++] = (triple >> 16) & 255
    if (at < bytes.length) bytes[at++] = (triple >> 8) & 255
    if (at < bytes.length) bytes[at++] = triple & 255
  }
  return bytes
}

/** Pack a 0/1 byte-per-pixel mask into base64 bits. */
export const packBits = (mask: Uint8Array): string => {
  const bytes = new Uint8Array(Math.ceil(mask.length / 8))
  for (let bit = 0; bit < mask.length; bit++) {
    if (mask[bit] !== 0) bytes[bit >> 3] = (bytes[bit >> 3] ?? 0) | (128 >> (bit & 7))
  }
  return bytesToBase64(bytes)
}

/** Unpack base64 bits into a 0/1 byte-per-pixel mask of exactly `bits` entries, or null. */
export const unpackBits = (text: string, bits: number): Uint8Array | null => {
  const bytes = base64ToBytes(text)
  if (bytes === null || bytes.length !== Math.ceil(bits / 8)) return null
  const mask = new Uint8Array(bits)
  for (let bit = 0; bit < bits; bit++) {
    if (((bytes[bit >> 3] ?? 0) & (128 >> (bit & 7))) !== 0) mask[bit] = 1
  }
  return mask
}

/** Whether `text` is base64 of exactly enough bytes for `bits`. */
export const isPackedBits = (text: unknown, bits: number): text is string =>
  typeof text === 'string' &&
  text.length === Math.ceil(Math.ceil(bits / 8) / 3) * 4 &&
  /^[A-Za-z0-9+/]*={0,2}$/.test(text)
