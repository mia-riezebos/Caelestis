/**
 * Access-token minting and hashing.
 *
 * Tokens are server-generated 128-bit values, never user-chosen, which is why SHA-256 at rest is
 * sufficient and no slow KDF is needed: there is no low-entropy secret to grind. A user-chosen
 * password would need argon2 or scrypt; 128 bits of CSPRNG output does not.
 *
 * @see .scratch/v1/issues/03-auth-model.md
 */

/** Scopes, ordered: each one grants everything below it. */
export const SCOPES = ['read', 'report', 'admin'] as const

export type Scope = (typeof SCOPES)[number]

/** RFC 4648 base32 without padding, minus the characters that invite transcription errors. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789'
const TOKEN_BYTES = 16
const BITS_PER_CHARACTER = 5

/** 128 bits at 5 bits per character, rounded up. */
export const TOKEN_LENGTH = Math.ceil((TOKEN_BYTES * 8) / BITS_PER_CHARACTER)

/**
 * A fresh token. 128 bits from the platform CSPRNG.
 *
 * Encoded by consuming a bit at a time rather than by chunking bytes, so no bits are discarded and
 * the value really does carry the full 128 bits its length advertises.
 */
export const mintToken = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES))
  let bits = 0
  let value = 0
  let token = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= BITS_PER_CHARACTER) {
      bits -= BITS_PER_CHARACTER
      token += ALPHABET[(value >> bits) & 31]
    }
  }
  if (bits > 0) token += ALPHABET[(value << (BITS_PER_CHARACTER - bits)) & 31]
  return token
}

/** Lowercase hex SHA-256, the form stored in `access_tokens.token_hash`. */
export const hashToken = async (token: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Whether `held` satisfies `required`.
 *
 * Scopes are a ladder, not a set: admin manages tokens and templates, so refusing it a read it could
 * grant itself in one request buys nothing. The ordering is the whole rule — a `read` holder must
 * never satisfy `report`, which is what stops someone who obtained read access from poisoning the
 * counters.
 */
export const satisfiesScope = (held: Scope, required: Scope): boolean =>
  SCOPES.indexOf(held) >= SCOPES.indexOf(required)
