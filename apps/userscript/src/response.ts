/** Best-effort cleanup for a response the caller has already decided not to consume. */
export const discardResponseBody = async (response: Response): Promise<void> => {
  try {
    await response.body?.cancel()
  } catch {
    // The primary validation/network result already decides the request. Cleanup cannot replace it
    // or escape later as an unhandled rejection into the host page.
  }
}

/** Read JSON without allowing an untrusted response to grow beyond the caller's byte budget. */
export const readBoundedJsonResponse = async (
  response: Response,
  maxBytes: number,
): Promise<unknown> => {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discardResponseBody(response)
    throw new RangeError(`response exceeds ${maxBytes} bytes`)
  }
  if (response.body === null) return null
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let body = ''
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > maxBytes) {
        await reader.cancel()
        throw new RangeError(`response exceeds ${maxBytes} bytes`)
      }
      body += decoder.decode(part.value, { stream: true })
    }
    body += decoder.decode()
  } finally {
    reader.releaseLock()
  }
  try {
    return body === '' ? null : JSON.parse(body)
  } catch {
    return null
  }
}
