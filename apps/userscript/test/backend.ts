import { millis } from '@caelestis/shared'
import { MemoryBlobStore } from '../../backend/dist/adapters/memory/memory-blob-store.js'
import { MemoryCounterStore } from '../../backend/dist/adapters/memory/memory-counter-store.js'
import { MemorySqlStore } from '../../backend/dist/adapters/memory/memory-sql-store.js'
import { createApp } from '../../backend/dist/app.js'
import { hashToken } from '../../backend/dist/auth/tokens.js'
import { makeBackendContext } from '../../backend/dist/runtime/backend-runtime.js'

export const adminToken = 'USERSCRIPT-CONTRACT-ADMIN'
export const reportToken = 'USERSCRIPT-CONTRACT-REPORT'
export const readToken = 'USERSCRIPT-CONTRACT-READ'

const serverPath = (url: URL): string =>
  url.pathname.replace(/^\/backend(?:\/v1)?(?=\/|$)/, (prefix) =>
    prefix.endsWith('/v1') ? '/v1' : '',
  )

/** Route the userscript's configured `/backend/v1` URL through the real backend Hono app. */
export const backendFetch =
  (app: { fetch(request: Request): Response | Promise<Response> }, origin: string): typeof fetch =>
  async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.origin !== origin)
      throw new Error(`unexpected server request: ${request.method} ${url}`)
    return await app.fetch(
      new Request(`https://backend.test${serverPath(url)}${url.search}`, request),
    )
  }

/** Exercise the built backend package without loading its compiler environment into Vitest. */
export const createTestBackend = async ({ openAccess = false }: { openAccess?: boolean } = {}) => {
  const sql = new MemorySqlStore()
  const blobs = new MemoryBlobStore()
  const counters = new MemoryCounterStore(sql)
  const tokenHash = await hashToken(adminToken)
  await sql.insertAccessToken({
    tokenHash,
    label: 'Userscript contract admin',
    scope: 'admin',
    createdWithToken: tokenHash,
    createdAt: millis(1),
  })
  const reportTokenHash = await hashToken(reportToken)
  await sql.insertAccessToken({
    tokenHash: reportTokenHash,
    label: 'Userscript contract reporter',
    scope: 'report',
    createdWithToken: tokenHash,
    createdAt: millis(2),
  })
  const readTokenHash = await hashToken(readToken)
  await sql.insertAccessToken({
    tokenHash: readTokenHash,
    label: 'Userscript contract reader',
    scope: 'read',
    createdWithToken: tokenHash,
    createdAt: millis(3),
  })
  return {
    app: createApp(makeBackendContext(blobs, sql, counters), {
      serverId: '00000000-0000-7000-8000-000000000000',
      serverName: 'Userscript contract server',
      currentSeason: 3,
      openAccess,
    }),
  }
}
