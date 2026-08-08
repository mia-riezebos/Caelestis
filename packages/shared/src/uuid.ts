const RANDOM_BYTES = 10
const MAX_TIMESTAMP = 2 ** 48 - 1

let lastTimestamp = -1
let lastRandom: Uint8Array<ArrayBuffer> = new Uint8Array(RANDOM_BYTES)

const randomPayload = (): Uint8Array<ArrayBuffer> => {
  const bytes = crypto.getRandomValues(new Uint8Array(RANDOM_BYTES))
  // These bits are occupied by the version and variant in the UUID itself.
  bytes[0] = (bytes[0] ?? 0) & 0x0f
  bytes[2] = (bytes[2] ?? 0) & 0x3f
  return bytes
}

const incrementPayload = (bytes: Uint8Array): boolean => {
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    const maximum = index === 0 ? 0x0f : index === 2 ? 0x3f : 0xff
    const value = bytes[index] ?? 0
    if (value < maximum) {
      bytes[index] = value + 1
      return true
    }
    bytes[index] = 0
  }
  return false
}

const hex = (byte: number): string => byte.toString(16).padStart(2, '0')

/**
 * Generate a canonical UUIDv7.
 *
 * The random payload increments when the clock has not advanced. That makes IDs sortable even when
 * several are minted in one millisecond, while retaining a fresh cryptographic seed for each new
 * timestamp.
 */
export const uuidV7 = (): string => {
  let timestamp = Math.max(Date.now(), lastTimestamp)
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > MAX_TIMESTAMP) {
    throw new Error('current time cannot be represented in a UUIDv7')
  }

  if (timestamp > lastTimestamp) {
    lastRandom = randomPayload()
  } else if (!incrementPayload(lastRandom)) {
    timestamp += 1
    if (timestamp > MAX_TIMESTAMP) throw new Error('UUIDv7 timestamp overflow')
    lastRandom = randomPayload()
  }
  lastTimestamp = timestamp

  const bytes = new Uint8Array(16)
  let remaining = timestamp
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = remaining % 256
    remaining = Math.floor(remaining / 256)
  }
  bytes[6] = 0x70 | (lastRandom[0] ?? 0)
  bytes[7] = lastRandom[1] ?? 0
  bytes[8] = 0x80 | (lastRandom[2] ?? 0)
  bytes.set(lastRandom.subarray(3), 9)

  return `${hex(bytes[0] ?? 0)}${hex(bytes[1] ?? 0)}${hex(bytes[2] ?? 0)}${hex(bytes[3] ?? 0)}-${hex(bytes[4] ?? 0)}${hex(bytes[5] ?? 0)}-${hex(bytes[6] ?? 0)}${hex(bytes[7] ?? 0)}-${hex(bytes[8] ?? 0)}${hex(bytes[9] ?? 0)}-${hex(bytes[10] ?? 0)}${hex(bytes[11] ?? 0)}${hex(bytes[12] ?? 0)}${hex(bytes[13] ?? 0)}${hex(bytes[14] ?? 0)}${hex(bytes[15] ?? 0)}`
}
