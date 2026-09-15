// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  getManifest,
  getServer,
  probeAdminScope,
  writeConnection,
} from '../lib/api/client'
import { persisted } from '../lib/persisted.svelte'
import { AppState } from '../lib/state/app.svelte'
import { adminToken, authorized, createTestBackend } from './backend'

const empty = {
  server: null,
  manifest: null,
  statuses: [],
  statusRevision: null,
  alarms: [],
  alarmsVersion: null,
  canvas: [],
  needsRecovery: true,
  error: null,
}
const states: AppState[] = []
const makeState = () => {
  const state = new AppState(empty)
  states.push(state)
  return state
}

beforeEach(() => {
  localStorage.clear()
})
afterEach(() => {
  for (const state of states.splice(0)) state.stopLive()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
})

const connect = async () => {
  const backend = await createTestBackend({ openAccess: true })
  const requests: Request[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        'https://frontend.test',
      )
      const path = url.pathname.replace(/^\/(?:api|backend)(?=\/)/, '')
      const request = new Request(`https://backend.test${path}${url.search}`, init)
      requests.push(request)
      return backend.app.fetch(request)
    }),
  )
  return { ...backend, requests }
}

describe('frontend session through the backend HTTP boundary', () => {
  it('loads a public manifest and derives administrator access from the real credential', async () => {
    const backend = await connect()
    const state = makeState()
    await state.load()
    expect(state.manifest?.season).toBe(3)
    expect(state.isAdmin).toBe(false)
    expect(state.authRequired).toBe(false)
    writeConnection('https://backend.test', adminToken)
    await state.load()
    expect(state.isAdmin).toBe(true)
    expect(
      backend.requests.some(
        (request) => request.headers.get('authorization') === `Bearer ${adminToken}`,
      ),
    ).toBe(true)
    const record = (await backend.sql.listAccessTokens())[0]
    const revoked = await backend.app.fetch(
      authorized(`/admin/tokens/${record.tokenHash}`, { method: 'DELETE' }),
    )
    expect(revoked.status).toBe(204)
    await state.load()
    expect(state.isAdmin).toBe(false)
  })

  it('a protected server rejects stale credentials and the client opens authentication state', async () => {
    const backend = await createTestBackend()
    writeConnection('https://backend.test', 'revoked-token')
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) => {
        const url = new URL(String(input))
        return backend.app.fetch(
          new Request(`https://backend.test${url.pathname.replace('/backend', '')}`, init),
        )
      }),
    )
    const state = makeState()
    await state.load()
    expect(state.authRequired).toBe(true)
    expect(state.manifest).toBeNull()
    expect(state.isAdmin).toBe(false)
    expect(state.loading).toBe(false)
  })

  it('only falls back to legacy server paths on a version-route 404', async () => {
    const backend = await connect()
    const network = globalThis.fetch
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) => {
        if (String(input).endsWith('/v1/server')) return new Response(null, { status: 404 })
        return network(input, init)
      }),
    )
    await getServer()
    await getManifest()
    expect(backend.requests.at(-1)?.url).toBe('https://backend.test/manifest')
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => new Response(null, { status: 403 })),
    )
    await expect(getServer()).rejects.toBeInstanceOf(ApiError)
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('a late load cannot overwrite the latest connection result', async () => {
    await connect()
    const network = globalThis.fetch
    let release: (response: Response) => void = () => {
      throw new Error('request not pending')
    }
    const delayed = new Promise<Response>((resolve) => {
      release = resolve
    })
    let first = true
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) => {
        if (first) {
          first = false
          return delayed
        }
        return network(input, init)
      }),
    )
    const state = makeState()
    const old = state.load()
    await state.load()
    const current = state.server
    release(Response.json({ ...current, name: 'Obsolete server' }))
    await old
    expect(state.server?.name).toBe('Test server')
    expect(state.manifest?.season).toBe(3)
  })

  it('retries transient reads once and distinguishes permission refusal from network failure', async () => {
    await connect()
    const network = globalThis.fetch
    const requests = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockImplementation(network)
    vi.stubGlobal('fetch', requests)
    expect((await getServer()).name).toBe('Test server')
    expect(requests).toHaveBeenCalledTimes(2)
    expect(await probeAdminScope(3)).toBe(false)
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => new Response(null, { status: 500 })),
    )
    await expect(probeAdminScope(3)).rejects.toMatchObject({ status: 500 })
  })
})

it('preferences recover from corrupt storage and retain session values when persistence fails', () => {
  localStorage.setItem('preference', '{broken')
  const preference = persisted('preference', 0.5)
  expect(preference.value).toBe(0.5)
  preference.value = 0.8
  expect(persisted('preference', 0.5).value).toBe(0.8)
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('storage unavailable')
  })
  preference.value = 0.2
  expect(preference.value).toBe(0.2)
})
