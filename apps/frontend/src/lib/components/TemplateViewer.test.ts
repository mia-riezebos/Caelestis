// @vitest-environment happy-dom
import { millis, type Template, type TileKey, tileKey } from '@caelestis/shared'
import { flushSync, mount, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const imageLoads = vi.hoisted(() => ({
  tile: vi.fn<(hash: string) => Promise<HTMLImageElement>>(),
  chunk: vi.fn<(hash: string) => Promise<HTMLImageElement>>(),
  osm: vi.fn<() => Promise<HTMLImageElement>>(),
}))

vi.mock('$lib/render', async () => ({
  ...(await vi.importActual<typeof import('$lib/render')>('$lib/render')),
  tileImage: imageLoads.tile,
  chunkImage: imageLoads.chunk,
  osmImage: imageLoads.osm,
}))

import TemplateViewer from './TemplateViewer.svelte'

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason?: unknown) => void
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept
    reject = refuse
  })
  return { promise, resolve, reject }
}

const image = (name: string): HTMLImageElement =>
  ({ dataset: { name } }) as unknown as HTMLImageElement
const TEMPLATE_TILE = tileKey({ x: 0, y: 0 })
const template: Template = {
  id: 'template',
  nodeId: null,
  name: 'Template',
  version: 'version',
  bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
  totalPixels: 1,
  chunks: [{ tile: TEMPLATE_TILE, hash: 'chunk' }],
  published: true,
  createdAt: millis(0),
  updatedAt: millis(0),
}

const canvas = {
  draws: [] as string[],
  clearRect: vi.fn(() => {
    canvas.draws = []
  }),
  drawImage: vi.fn((drawn: CanvasImageSource) => {
    const name = (drawn as HTMLImageElement).dataset.name
    if (name !== undefined) canvas.draws.push(name)
  }),
  setTransform: vi.fn(),
  imageSmoothingEnabled: false,
  imageSmoothingQuality: 'low' as ImageSmoothingQuality,
  globalAlpha: 1,
}

let resize: (() => void) | null = null
let mounted: ReturnType<typeof mount> | null = null

beforeEach(() => {
  canvas.draws = []
  canvas.clearRect.mockClear()
  canvas.drawImage.mockClear()
  canvas.setTransform.mockClear()
  imageLoads.tile.mockReset()
  imageLoads.chunk.mockReset().mockResolvedValue(image('chunk'))
  imageLoads.osm.mockReset().mockResolvedValue(image('osm'))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    canvas as unknown as CanvasRenderingContext2D,
  )
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = () => callback([], this as unknown as ResizeObserver)
      }

      observe(target: Element): void {
        Object.defineProperties(target, {
          clientWidth: { configurable: true, value: 400 },
          clientHeight: { configurable: true, value: 300 },
        })
        resize?.()
      }

      disconnect(): void {}
      unobserve(): void {}
    },
  )
})

afterEach(async () => {
  if (mounted !== null) await unmount(mounted)
  mounted = null
  resize = null
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

const show = (hashFor: (key: TileKey) => string | undefined): void => {
  mounted = mount(TemplateViewer, {
    target: document.body,
    props: { template, hashFor, overlayAlpha: 0 },
  })
  flushSync()
}

const settle = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  flushSync()
}

describe('timelapse tile presentation', () => {
  it('keeps the previous decoded tile until the selected replacement finishes loading', async () => {
    const oldFrame = deferred<HTMLImageElement>()
    const nextFrame = deferred<HTMLImageElement>()
    imageLoads.tile.mockImplementation((hash) =>
      hash === 'old' ? oldFrame.promise : nextFrame.promise,
    )
    let selected = 'old'
    show((key) => (key === TEMPLATE_TILE ? selected : undefined))
    oldFrame.resolve(image('old'))
    await settle()
    expect(canvas.draws).toContain('old')

    selected = 'next'
    resize?.()
    await settle()

    expect(imageLoads.tile).toHaveBeenCalledWith('next')
    expect(canvas.draws).toContain('old')
    expect(canvas.draws).not.toContain('next')

    nextFrame.resolve(image('next'))
    await settle()
    expect(canvas.draws).toContain('next')
    expect(canvas.draws).not.toContain('old')
  })

  it('keeps the previous decoded tile when its requested replacement fails', async () => {
    const oldFrame = deferred<HTMLImageElement>()
    const failedFrame = deferred<HTMLImageElement>()
    imageLoads.tile.mockImplementation((hash) =>
      hash === 'old' ? oldFrame.promise : failedFrame.promise,
    )
    let selected: string | undefined = 'old'
    show((key) => (key === TEMPLATE_TILE ? selected : undefined))
    oldFrame.resolve(image('old'))
    await settle()

    selected = 'failed'
    resize?.()
    await settle()
    failedFrame.reject(new Error('404 or decode failure'))
    await settle()
    resize?.()
    await settle()
    expect(canvas.draws).toContain('old')
  })

  it('does not leak a later tile into a time before its first observation', async () => {
    const liveFrame = deferred<HTMLImageElement>()
    imageLoads.tile.mockImplementation(() => liveFrame.promise)
    let selected: string | undefined = 'live'
    show((key) => (key === TEMPLATE_TILE ? selected : undefined))
    liveFrame.resolve(image('live'))
    await settle()
    expect(canvas.draws).toContain('live')

    selected = undefined
    resize?.()
    await settle()
    expect(canvas.draws).not.toContain('live')
  })

  it('replaces the previous tile with a successfully decoded blank observation', async () => {
    const oldFrame = deferred<HTMLImageElement>()
    const blankFrame = deferred<HTMLImageElement>()
    imageLoads.tile.mockImplementation((hash) =>
      hash === 'old' ? oldFrame.promise : blankFrame.promise,
    )
    let selected = 'old'
    show((key) => (key === TEMPLATE_TILE ? selected : undefined))
    oldFrame.resolve(image('old'))
    await settle()

    selected = 'blank'
    resize?.()
    await settle()
    blankFrame.resolve(image('blank'))
    await settle()

    expect(canvas.draws).toContain('blank')
    expect(canvas.draws).not.toContain('old')
  })
})
