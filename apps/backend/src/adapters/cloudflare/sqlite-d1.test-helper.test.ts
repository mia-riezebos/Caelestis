import { expect, it } from 'vitest'
import { SqliteD1Database } from './sqlite-d1.test-helper.js'

/**
 * The fake's LIKE cap is the suite's only defence against a production-only 500 on every non-shallow
 * rename, and it is disabled by a one-character edit to a regex or a constant. Both the schema and
 * the wire still describe the subtree move as `LIKE '<old>/%'`, so a future author has every reason
 * to reach for it — and would find the tests green.
 */
it('refuses a pattern longer than D1 allows, and accepts one at the limit', async () => {
  const d1 = new SqliteD1Database()
  const query = (pattern: string) =>
    d1.prepare('select 1 as ok where ? like ?').bind('x', pattern).all()

  await expect(query('y'.repeat(51))).rejects.toThrow(/LIKE or GLOB pattern too complex/)
  await expect(query('y'.repeat(50))).resolves.toBeDefined()
  d1.close()
})

it('leaves a long binding alone when the statement has no pattern match', async () => {
  const d1 = new SqliteD1Database()

  await expect(d1.prepare('select ? as value').bind('y'.repeat(500)).all()).resolves.toBeDefined()
  d1.close()
})
