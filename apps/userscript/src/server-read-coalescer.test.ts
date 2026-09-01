import { expect, it, vi } from 'vitest'
import { coalesceServerRead } from './server-read-coalescer.js'

it('coalesces only the same connection, season, scope, and resource key', async () => {
  const connection = {}
  const replacement = {}
  let release!: (value: string) => void
  const read = vi.fn(
    async () =>
      await new Promise<string>((resolve) => {
        release = resolve
      }),
  )

  const first = coalesceServerRead(connection, '0\u0000world\u0000manifest', read)
  const second = coalesceServerRead(connection, '0\u0000world\u0000manifest', read)
  const otherScope = coalesceServerRead(
    replacement,
    '0\u0000world\u0000manifest',
    async () => 'new',
  )
  expect(read).toHaveBeenCalledOnce()
  release('shared')

  await expect(first).resolves.toBe('shared')
  await expect(second).resolves.toBe('shared')
  await expect(otherScope).resolves.toBe('new')
})
