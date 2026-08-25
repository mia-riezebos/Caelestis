import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScanJob, ScanOutcome } from './mismatch-scan.js'

const job = (templateKey: string): ScanJob => ({
  kind: 'pixels',
  templateKey,
  indices: null,
  width: 1,
  height: 1,
  originX: 0,
  originY: 0,
  tileX: 0,
  tileY: 0,
  tileSize: 1,
  bandTop: 0,
  server: new Uint8Array([0]),
  draft: null,
  ignored: [254, 255],
  transparent: 254,
  unpainted: 255,
})

const outcome: ScanOutcome = {
  wrong: new Uint32Array(0),
  unpainted: new Uint32Array(0),
  asserted: 1,
  completed: 1,
  mismatched: 0,
  progressUnpainted: 0,
  progressAsserted: 1,
  progressByColour: new Uint32Array([0, 1, 0, 0]),
}

describe('mismatch worker queue', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
  })

  it('settles and removes every queued scan for a forgotten template', async () => {
    const posted: Record<string, unknown>[] = []
    let onMessage: ((event: MessageEvent<Record<string, unknown>>) => void) | undefined
    class FakeWorker {
      addEventListener(type: string, listener: EventListener): void {
        if (type === 'message') {
          onMessage = listener as (event: MessageEvent<Record<string, unknown>>) => void
        }
      }
      postMessage(payload: Record<string, unknown>): void {
        posted.push(payload)
      }
      terminate(): void {}
    }
    vi.stubGlobal('Worker', FakeWorker)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mismatch-worker')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const { forgetInWorker, scanInWorker } = await import('./mismatch-worker.js')

    const active = scanInWorker(job('active'), new Uint8Array([0]))
    const forgotten = scanInWorker(job('forgotten'), new Uint8Array([0]))
    const retained = scanInWorker(job('retained'), new Uint8Array([0]))
    forgetInWorker('forgotten')

    await expect(forgotten).resolves.toBeNull()
    const activeMessage = posted.find((message) => message.templateKey === 'active')
    expect(activeMessage).toBeDefined()
    onMessage?.(
      new MessageEvent<Record<string, unknown>>('message', {
        data: { id: activeMessage?.id, ...outcome },
      }),
    )
    await expect(active).resolves.toEqual(outcome)
    await vi.waitFor(() =>
      expect(posted.some((message) => message.templateKey === 'retained')).toBe(true),
    )
    expect(posted.filter((message) => message.templateKey === 'forgotten')).toEqual([
      { forget: true, templateKey: 'forgotten' },
    ])

    const retainedMessage = posted.find((message) => message.templateKey === 'retained')
    onMessage?.(
      new MessageEvent<Record<string, unknown>>('message', {
        data: { id: retainedMessage?.id, ...outcome },
      }),
    )
    await expect(retained).resolves.toEqual(outcome)
  })
})
