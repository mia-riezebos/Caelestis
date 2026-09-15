import { millis } from '@caelestis/shared'
import { MemoryBlobStore } from '../../src/adapters/memory/memory-blob-store.js'
import { MemoryCounterStore } from '../../src/adapters/memory/memory-counter-store.js'
import { MemorySqlStore } from '../../src/adapters/memory/memory-sql-store.js'
import { createApp } from '../../src/app.js'
import { hashToken } from '../../src/auth/tokens.js'
import type { SqlStore } from '../../src/ports/sql-store.js'
import { makeBackendContext } from '../../src/runtime/backend-runtime.js'

export const adminToken = 'ADMIN-TEST-TOKEN'

export const createTestBackend = async (options: { openAccess?: boolean; sql?: SqlStore } = {}) => {
  const sql = options.sql ?? new MemorySqlStore()
  const blobs = new MemoryBlobStore()
  const counters = new MemoryCounterStore(sql)
  const tokenHash = await hashToken(adminToken)
  await sql.insertAccessToken({
    tokenHash,
    label: 'test administrator',
    scope: 'admin',
    createdWithToken: tokenHash,
    createdAt: millis(1),
  })
  const app = createApp(makeBackendContext(blobs, sql, counters), {
    serverId: '00000000-0000-7000-8000-000000000000',
    serverName: 'Test server',
    currentSeason: 3,
    openAccess: options.openAccess,
  })
  return { app, sql, blobs, counters }
}

export const authorized = (path: string, init: RequestInit = {}): Request =>
  new Request(`https://backend.test${path}`, {
    ...init,
    headers: { authorization: `Bearer ${adminToken}`, ...init.headers },
  })
