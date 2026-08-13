import { describe, expect, it } from 'vitest'
import { discardResponseBody } from './response.js'

describe('response cleanup', () => {
  it('absorbs a body cancellation failure after the caller has already rejected the response', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.error(new Error('stream already failed'))
      },
    })

    await expect(discardResponseBody(new Response(body))).resolves.toBeUndefined()
  })
})
