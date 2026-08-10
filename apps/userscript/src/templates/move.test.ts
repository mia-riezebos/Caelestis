import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  canvasPixelAt: vi.fn(() => ({ x: 2, y: 3 })),
  clearLocalPreview: vi.fn(() => true),
  localTemplates: vi.fn(),
  markPlaced: vi.fn(async () => true),
  moveLocalTemplate: vi.fn(async () => true),
  previewLocalTemplate: vi.fn(() => true),
  removeLocalTemplate: vi.fn(async () => true),
}))

vi.mock('../main.js', () => ({
  canvasPixelAt: harness.canvasPixelAt,
  cssPixelsPerCanvasPixel: vi.fn(() => 1),
}))
vi.mock('../debug.js', () => ({ log: vi.fn(), warn: vi.fn() }))
vi.mock('../ui/icons.js', () => ({ icon: vi.fn(() => ({})) }))
vi.mock('./local-store.js', () => ({
  clearLocalPreview: harness.clearLocalPreview,
  localTemplates: harness.localTemplates,
  markPlaced: harness.markPlaced,
  moveLocalTemplate: harness.moveLocalTemplate,
  previewLocalTemplate: harness.previewLocalTemplate,
  removeLocalTemplate: harness.removeLocalTemplate,
}))

const listeners = new Map<string, EventListener>()
let movebar: { remove: ReturnType<typeof vi.fn> } | null

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  listeners.clear()
  movebar = null
  harness.localTemplates.mockReturnValue([
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
  ])
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

  it('suppresses auxclick only after placement handled that middle click', async () => {
    const moves = await import('./move.js')
    moves.beginMove('test', vi.fn())
    const pointerdown = listeners.get('pointerdown')
    const auxclick = listeners.get('auxclick')
    if (pointerdown === undefined || auxclick === undefined) throw new Error('expected listeners')
    const unrelated = { button: 1, preventDefault: vi.fn() }

    auxclick(unrelated as unknown as Event)
    expect(unrelated.preventDefault).not.toHaveBeenCalled()

    pointerdown({ button: 1, clientX: 2, clientY: 3, preventDefault: vi.fn() } as unknown as Event)
    auxclick(unrelated as unknown as Event)
    expect(unrelated.preventDefault).toHaveBeenCalledOnce()
  })

  it('allows only one commit while an asynchronous placement is finishing', async () => {
    let finishMove = (): void => undefined
    harness.moveLocalTemplate.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finishMove = resolve
      })
      return true
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
    await vi.waitFor(() => expect(harness.previewLocalTemplate).toHaveBeenCalled())

    expect(harness.previewLocalTemplate).toHaveBeenCalledWith('test', 0, 0)
  })

  it('uses CSS pixel scale for modifier drags on high-DPI canvases', async () => {
    harness.canvasPixelAt.mockReturnValue({ x: 12, y: 22 })
    const moves = await import('./move.js')
    moves.beginMove('test', vi.fn())
    const pointerdown = listeners.get('pointerdown')
    const pointermove = listeners.get('pointermove')
    if (pointerdown === undefined || pointermove === undefined)
      throw new Error('expected listeners')

    pointerdown({
      button: 0,
      clientX: 100,
      clientY: 100,
      ctrlKey: true,
      metaKey: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as Event)
    pointermove({
      clientX: 200,
      clientY: 150,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as Event)

    expect(harness.previewLocalTemplate).toHaveBeenLastCalledWith('test', 110, 70)
  })

  it('binds a drag to one pointer and ends it on pointer cancellation', async () => {
    harness.canvasPixelAt.mockReturnValue({ x: 12, y: 22 })
    const moves = await import('./move.js')
    moves.beginMove('test', vi.fn())
    const pointerdown = listeners.get('pointerdown')
    const pointermove = listeners.get('pointermove')
    const pointercancel = listeners.get('pointercancel')
    if (pointerdown === undefined || pointermove === undefined || pointercancel === undefined) {
      throw new Error('expected pointer listeners')
    }
    pointerdown({
      button: 0,
      pointerId: 7,
      clientX: 100,
      clientY: 100,
      ctrlKey: true,
      metaKey: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as Event)

    pointermove({
      pointerId: 8,
      clientX: 200,
      clientY: 200,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as Event)
    expect(harness.previewLocalTemplate).not.toHaveBeenCalled()

    pointermove({
      pointerId: 7,
      clientX: 110,
      clientY: 110,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as Event)
    expect(harness.previewLocalTemplate).toHaveBeenCalledOnce()
    pointercancel({ pointerId: 7 } as unknown as Event)
    pointermove({
      pointerId: 7,
      clientX: 120,
      clientY: 120,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as Event)
    expect(harness.previewLocalTemplate).toHaveBeenCalledOnce()
  })

  it('ignores placement shortcuts in editable controls and page dialogs', async () => {
    const moves = await import('./move.js')
    moves.beginMove('test', vi.fn())
    const keydown = listeners.get('keydown')
    if (keydown === undefined) throw new Error('expected keyboard listener')

    keydown({
      key: 'Enter',
      target: { tagName: 'INPUT' },
      preventDefault: vi.fn(),
    } as unknown as Event)
    keydown({
      key: 'Enter',
      target: { tagName: 'BUTTON' },
      preventDefault: vi.fn(),
    } as unknown as Event)
    keydown({
      key: 'Escape',
      target: { tagName: 'DIV', closest: vi.fn(() => ({})) },
      preventDefault: vi.fn(),
    } as unknown as Event)
    await Promise.resolve()

    expect(harness.moveLocalTemplate).not.toHaveBeenCalled()
    expect(harness.markPlaced).not.toHaveBeenCalled()
  })

  it('recovers placement controls after a final bitmap build rejects', async () => {
    harness.moveLocalTemplate.mockRejectedValueOnce(new Error('bitmap failed'))
    const moves = await import('./move.js')
    moves.beginMove('test', vi.fn())

    await expect(moves.commit()).resolves.toBeUndefined()
    await expect(moves.commit()).resolves.toBeUndefined()

    expect(harness.moveLocalTemplate).toHaveBeenCalledTimes(2)
    expect(harness.markPlaced).toHaveBeenCalledOnce()
  })

  it('reverts an existing template to its original placement on cancel', async () => {
    const moves = await import('./move.js')
    moves.beginMove('test', vi.fn())

    await moves.abort()

    expect(harness.clearLocalPreview).toHaveBeenCalledWith('test')
    expect(harness.moveLocalTemplate).not.toHaveBeenCalled()
    expect(harness.removeLocalTemplate).not.toHaveBeenCalled()
  })

  it('discards a fresh image import on its first cancel', async () => {
    harness.localTemplates.mockReturnValue([
      {
        id: 'test',
        name: 'Test',
        source: 'image',
        originX: 10,
        originY: 20,
        width: 10,
        height: 10,
        everPlaced: false,
      },
    ])
    const moves = await import('./move.js')
    moves.beginMove('test', vi.fn())

    await moves.abort()

    expect(harness.removeLocalTemplate).toHaveBeenCalledWith('test')
    expect(harness.moveLocalTemplate).not.toHaveBeenCalled()
  })
})
