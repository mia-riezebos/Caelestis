import { describe, expect, it } from 'vitest'
import { runWhileBusy } from '../src/application/operation-lock.js'

describe('tree operation admission', () => {
  it('refuses a concurrent move and releases the key after the first settles', async () => {
    let release: (() => void) | undefined
    const first = runWhileBusy('move:local:folder-a', async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return 'moved'
    })
    await Promise.resolve()
    expect(await runWhileBusy('move:local:folder-a', async () => 'duplicate')).toBeNull()
    release?.()
    expect(await first).toBe('moved')
    expect(await runWhileBusy('move:local:folder-a', async () => 'next')).toBe('next')
  })
})
