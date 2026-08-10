import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  canvasPixelAt: vi.fn(() => ({ x: 2, y: 3 })),
  markPlaced: vi.fn(async () => undefined),
  moveLocalTemplate: vi.fn(async () => undefined),
  removeLocalTemplate: vi.fn(async () => undefined),
}))

vi.mock('../main.js', () => ({
  canvasPixelAt: harness.canvasPixelAt,
  pixelsPerCanvasPixel: vi.fn(() => 1),
}))
vi.mock('../debug.js', () => ({ log: vi.fn() }))
vi.mock('../ui/icons.js', () => ({ icon: vi.fn(() => ({})) }))
vi.mock('./local-store.js', () => ({
  localTemplates: vi.fn(() => [
    {
      id: 'test',
      name: 'Test',
      source: 'image',
      originX: 10,
      originY: 20,
      width: 10,
      height: 10,
      everPlaced: true,
    },
  ]),
  markPlaced: harness.markPlaced,
  moveLocalTemplate: harness.moveLocalTemplate,
  removeLocalTemplate: harness.removeLocalTemplate,
}))

const listeners = new Map<string, EventListener>()
let movebar: { remove: ReturnType<typeof vi.fn> } | null

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  listeners.clear()
  movebar = null
  vi.stubGlobal('navigator', { platform: 'Linux' })
  vi.stubGlobal('window', {
    addEventListener: vi.fn((name: string, listener: EventListener) =>
      listeners.set(name, listener),
    ),
    removeEventListener: vi.fn(),
  })
  vi.stubGlobal('document', {
    body: { appendChild: vi.fn() },
    querySelector: vi.fn(() => movebar),
    createElement: vi.fn(() => ({
      style: {},
      setAttribute: vi.fn(),
      appendChild: vi.fn(),
      addEventListener: vi.fn(),
      replaceChildren: vi.fn(),
      append: vi.fn(),
    })),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('template placement controls', () => {
  it('removes the exact auxclick listener it installed', async () => {
    const moves = await import('./move.js')
    moves.beginMove('test', vi.fn())
    const auxclick = listeners.get('auxclick')
    if (auxclick === undefined) throw new Error('expected auxclick listener')
    movebar = { remove: vi.fn() }

    await moves.commit()

    expect(window.removeEventListener).toHaveBeenCalledWith('auxclick', auxclick, true)
  })

  it('allows only one commit while an asynchronous placement is finishing', async () => {
    let finishMove = (): void => undefined
    harness.moveLocalTemplate.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finishMove = resolve
      })
      return undefined
    })
    const moves = await import('./move.js')
    moves.beginMove('test', vi.fn())

    const first = moves.commit()
    const second = moves.commit()
    finishMove()
    await Promise.all([first, second])

    expect(harness.moveLocalTemplate).toHaveBeenCalledOnce()
    expect(harness.markPlaced).toHaveBeenCalledOnce()
  })

  it('clamps middle-click placement to the native canvas bounds', async () => {
    const moves = await import('./move.js')
    moves.beginMove('test', vi.fn())
    const pointerdown = listeners.get('pointerdown')
    if (pointerdown === undefined) throw new Error('expected pointerdown listener')

    pointerdown({ button: 1, clientX: 2, clientY: 3, preventDefault: vi.fn() } as unknown as Event)
    await vi.waitFor(() => expect(harness.moveLocalTemplate).toHaveBeenCalled())

    expect(harness.moveLocalTemplate).toHaveBeenCalledWith('test', 0, 0)
  })
})
