import { type Millis, millis } from '@caelestis/shared'
import { MemoryBlobStore } from '../../../backend/dist/adapters/memory/memory-blob-store.js'
import { MemoryCounterStore } from '../../../backend/dist/adapters/memory/memory-counter-store.js'
import { MemorySqlStore } from '../../../backend/dist/adapters/memory/memory-sql-store.js'
import { createApp } from '../../../backend/dist/app.js'
import { hashToken } from '../../../backend/dist/auth/tokens.js'
import type { BackfillClients } from '../../../backend/dist/backfill/port.js'
import { makeBackendContext } from '../../../backend/dist/runtime/backend-runtime.js'

export const adminToken = 'FRONTEND-CONTRACT-ADMIN'

/** Exercise the built backend package without importing its compiler environment into SvelteKit. */
export const createTestBackend = async (
  options: { openAccess?: boolean; clock?: () => Millis; backfillClients?: BackfillClients } = {},
) => {
  const { clock, ...appOptions } = options
  const sql = new MemorySqlStore()
  const blobs = new MemoryBlobStore()
  const counters = new MemoryCounterStore(sql, clock)
  const tokenHash = await hashToken(adminToken)
  await sql.insertAccessToken({
    tokenHash,
    label: 'Contract admin',
    scope: 'admin',
    createdWithToken: tokenHash,
    createdAt: millis(1),
  })
  const app = createApp(makeBackendContext(blobs, sql, counters), {
    serverId: '00000000-0000-7000-8000-000000000000',
    serverName: 'Test server',
    currentSeason: 3,
    ...appOptions,
  })
  return { app, sql, blobs, counters }
}

export const authorized = (path: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${adminToken}`)
  return new Request(`https://backend.test${path}`, { ...init, headers })
}

/** Route browser-relative frontend reads into the real built backend app. */
export const frontendFetch =
  (
    app: { readonly fetch: (request: Request) => Response | Promise<Response> },
    requests: Request[] = [],
  ): typeof fetch =>
  async (input, init) => {
    const source =
      input instanceof Request
        ? new Request(input, init)
        : new Request(new URL(String(input), 'https://frontend.test'), init)
    const url = new URL(source.url)
    if (url.origin !== 'https://frontend.test' && url.origin !== 'https://backend.test') {
      throw new Error(`Unsupported frontend test origin: ${url.origin}`)
    }
    const path =
      url.origin === 'https://frontend.test'
        ? url.pathname.replace(/^\/(?:api|backend)(?=\/)/, '')
        : url.pathname.replace(/^\/backend(?=\/)/, '')
    const request = new Request(`https://backend.test${path}${url.search}`, source)
    requests.push(request.clone())
    return app.fetch(request)
  }
