import { describe, expect, it } from 'vitest'
import { discardResponseBody, readBoundedJsonResponse } from './response.js'

describe('response cleanup', () => {
  it('absorbs a body cancellation failure after the caller has already rejected the response', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.error(new Error('stream already failed'))
      },
    })

    await expect(discardResponseBody(new Response(body))).resolves.toBeUndefined()
  })

  it('rejects a declared body larger than the byte budget without parsing it', async () => {
    const response = new Response('{}', { headers: { 'content-length': '17' } })

    await expect(readBoundedJsonResponse(response, 16)).rejects.toThrow('response exceeds 16 bytes')
  })

  it('cancels a chunked body when it crosses the byte budget', async () => {
    let cancelled = false
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(17))
        },
        cancel() {
          cancelled = true
        },
      }),
    )

    await expect(readBoundedJsonResponse(response, 16)).rejects.toThrow('response exceeds 16 bytes')
    expect(cancelled).toBe(true)
  })
})
