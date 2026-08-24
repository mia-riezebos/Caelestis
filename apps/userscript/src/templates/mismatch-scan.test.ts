import { describe, expect, it } from 'vitest'
import { type ScanJob, scanTile } from './mismatch-scan.js'

const job = (overrides: Partial<ScanJob> = {}): ScanJob => ({
  templateKey: 'template',
  indices: null,
  width: 4,
  height: 1,
  originX: 0,
  originY: 0,
  tileX: 0,
  tileY: 0,
  tileSize: 4,
  bandTop: 0,
  server: new Uint8Array([1, 5, 255, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
  draft: null,
  ignored: [254, 255, 2],
  transparent: 254,
  unpainted: 255,
  ...overrides,
})

describe('mismatch scan progress', () => {
  it('counts all three states without retaining completed or unpainted coordinates for progress', () => {
    const outcome = scanTile(job(), new Uint8Array([1, 2, 3, 254]))

    expect(outcome).toMatchObject({
      completed: 1,
      mismatched: 1,
      progressUnpainted: 1,
      progressAsserted: 3,
    })
    expect([...outcome.wrong]).toEqual([])
    expect([...outcome.unpainted]).toEqual([2, 0, 3])
  })

  it('keeps display-hidden colours in progress while excluding them from marker coordinates', () => {
    const outcome = scanTile(
      job({
        width: 1,
        server: new Uint8Array(16).fill(5),
        ignored: [254, 255, 2],
      }),
      new Uint8Array([2]),
    )

    expect(outcome).toMatchObject({ mismatched: 1, progressAsserted: 1, asserted: 0 })
    expect(outcome.wrong).toHaveLength(0)
  })
})
