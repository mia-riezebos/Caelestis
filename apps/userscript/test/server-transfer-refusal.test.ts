import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyLocalTemplateToServer } from '../src/application/transplant.js'
import { getState, upsertServer } from '../src/state.js'
import { addLocalTemplate, templateById } from '../src/templates/local-store.js'

const serverId = '018f1b8c-7f4e-7a8c-8a01-123456789abc'

afterEach(() => vi.unstubAllGlobals())

describe('server transfer cancellation', () => {
  it('keeps the local source when the destination connection changes during encoding', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 })),
    )
    const id = `refusal-${crypto.randomUUID()}`
    const local = await addLocalTemplate(
      {
        id,
        name: 'Keep me',
        source: 'wplace',
        originX: 0,
        originY: 0,
        width: 1,
        height: 1,
        indices: new Uint8Array([1]),
        moved: 0,
        opaque: 1,
      },
      undefined,
      true,
    )
    const destination = {
      url: 'https://destination.test',
      info: { id: serverId, name: 'Destination', auth: 'access_token' as const },
      token: 'admin',
      status: 'connected' as const,
      isAdmin: true,
      season: 1,
    }
    upsertServer(destination)
    const result = await copyLocalTemplateToServer(
      local,
      getState().servers.at(-1)!,
      null,
      async () => {},
      {
        beforeUpload: () => {
          upsertServer({ ...destination, token: 'replacement' })
          return true
        },
      },
    )

    expect(result).toMatchObject({ ok: false, message: expect.stringContaining('replaced') })
    expect(fetch).not.toHaveBeenCalled()
    expect(templateById(id)?.name).toBe('Keep me')
  })
})
