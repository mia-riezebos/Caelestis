import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('backend development startup', () => {
  it('applies pending local D1 migrations before starting Wrangler', async () => {
    const packageJson = JSON.parse(
      await readFile(join(process.cwd(), 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> }

    expect(packageJson.scripts?.['db:migrate:local']).toBe(
      'wrangler d1 migrations apply DB --local',
    )
    expect(packageJson.scripts?.dev).toBe('pnpm db:migrate:local && node dev.mjs')
  })
})
