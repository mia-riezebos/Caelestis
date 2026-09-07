import { expect, it, vi } from 'vitest'
import { coalesceServerRead, invalidateServerReads } from './server-read-coalescer.js'

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

it('keeps the post-mutation read shared when an older request completes', async () => {
  const owner = {}
  let releaseOld!: (value: string) => void
  let releaseNew!: (value: string) => void
  const old = coalesceServerRead(
    owner,
    'manifest',
    () =>
      new Promise<string>((resolve) => {
        releaseOld = resolve
      }),
  )
  invalidateServerReads(owner)
  const fresh = coalesceServerRead(
    owner,
    'manifest',
    () =>
      new Promise<string>((resolve) => {
        releaseNew = resolve
      }),
  )
  releaseOld('old')
  await old
  const unexpectedRead = vi.fn(async () => 'unexpected')
  const joined = coalesceServerRead(owner, 'manifest', unexpectedRead)
  releaseNew('fresh')
  await expect(fresh).resolves.toBe('fresh')
  await expect(joined).resolves.toBe('fresh')
  expect(unexpectedRead).not.toHaveBeenCalled()
})
