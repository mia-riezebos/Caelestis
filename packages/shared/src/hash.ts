/** Lowercase hexadecimal SHA-256, suitable for content-addressed blob keys. */
export const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  // Copying narrows ArrayBufferLike to ArrayBuffer for the DOM BufferSource type while preserving
  // support for callers whose view originated from a SharedArrayBuffer.
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
