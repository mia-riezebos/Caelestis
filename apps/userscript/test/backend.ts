import { millis } from '@caelestis/shared'
import { MemoryBlobStore } from '../../backend/dist/adapters/memory/memory-blob-store.js'
import { MemoryCounterStore } from '../../backend/dist/adapters/memory/memory-counter-store.js'
import { MemorySqlStore } from '../../backend/dist/adapters/memory/memory-sql-store.js'
import { createApp } from '../../backend/dist/app.js'
import { hashToken } from '../../backend/dist/auth/tokens.js'
import { makeBackendContext } from '../../backend/dist/runtime/backend-runtime.js'

export const adminToken = 'USERSCRIPT-CONTRACT-ADMIN'

/** Exercise the built backend package without loading its compiler environment into Vitest. */
export const createTestBackend = async () => {
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
  return {
    app: createApp(makeBackendContext(blobs, sql, counters), {
      serverId: '00000000-0000-7000-8000-000000000000',
      serverName: 'Userscript contract server',
      currentSeason: 3,
    }),
  }
}
