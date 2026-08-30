import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('production deployment', () => {
  it('applies remote D1 migrations before deploying the backend worker', async () => {
    const workflow = await readFile(
      join(process.cwd(), '../../.github/workflows/deploy.yml'),
      'utf8',
    )
    const migrate = workflow.indexOf('wrangler d1 migrations apply DB --remote')
    const deploy = workflow.indexOf('wrangler deploy')

    expect(migrate).toBeGreaterThan(-1)
    expect(deploy).toBeGreaterThan(migrate)
  })
})
