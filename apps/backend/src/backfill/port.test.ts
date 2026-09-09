import { expect, it } from 'vitest'
import { SqliteD1Database } from '../adapters/cloudflare/sqlite-d1.test-helper.js'
import { instrumentD1 } from '../metrics/request-metrics.js'
import { BackfillError } from './import.js'
import { backfillReply } from './port.js'

it.each([false, true])(
  'retains D1 usage across RPC replies, including errors (%s)',
  async (fail) => {
    const db = new SqliteD1Database()
    try {
      const sql = instrumentD1(db as unknown as D1Database)
      const reply = await backfillReply(async () => {
        await sql.prepare('SELECT 1').all()
        if (fail) throw new BackfillError('Template artwork changed.', 409)
        return 'preview'
      })
      expect(reply).toMatchObject({
        ok: !fail,
        usage: { measuredQueries: 1, unmeasuredQueries: 0 },
      })
    } finally {
      db.close()
    }
  },
)
