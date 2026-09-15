import { millis } from '@caelestis/shared'
import { MemoryBlobStore } from '../../../backend/dist/adapters/memory/memory-blob-store.js'
import { MemoryCounterStore } from '../../../backend/dist/adapters/memory/memory-counter-store.js'
import { MemorySqlStore } from '../../../backend/dist/adapters/memory/memory-sql-store.js'
import { createApp } from '../../../backend/dist/app.js'
import { hashToken } from '../../../backend/dist/auth/tokens.js'
import { makeBackendContext } from '../../../backend/dist/runtime/backend-runtime.js'

export const adminToken = 'FRONTEND-CONTRACT-ADMIN'

/** Exercise the built backend package without importing its compiler environment into SvelteKit. */
export const createTestBackend = async (options: { openAccess?: boolean } = {}) => {
  const sql = new MemorySqlStore()
  const blobs = new MemoryBlobStore()
  const counters = new MemoryCounterStore(sql)
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
    ...options,
  })
  return { app, sql, blobs, counters }
}

export const authorized = (path: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${adminToken}`)
  return new Request(`https://backend.test${path}`, { ...init, headers })
}
