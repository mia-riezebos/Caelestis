import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  canvasPixelAt: vi.fn(() => ({ x: 2, y: 3 })),
  cssPixelsPerCanvasPixel: vi.fn(() => ({ x: 1, y: 1 })),
  isDeletingLocal: vi.fn((_id: string) => false),
  isServerTemplate: vi.fn((template: { serverUrl?: string }) => template.serverUrl !== undefined),
  clearLocalPreview: vi.fn(() => true),
  repaint: vi.fn(),
  isMapInteractionTarget: vi.fn(() => true),
  localTemplates: vi.fn(),
  placeLocalTemplate: vi.fn(async () => true),
  previewLocalTemplate: vi.fn(() => true),
  reconciliationObservers: new Map<string, Set<() => void>>(),
  removeLocalTemplate: vi.fn(async () => true),
}))

vi.mock('../main.js', () => ({
  canvasPixelAt: harness.canvasPixelAt,
  cssPixelsPerCanvasPixel: harness.cssPixelsPerCanvasPixel,
  isMapInteractionTarget: harness.isMapInteractionTarget,
  repaint: harness.repaint,
}))
vi.mock('../debug.js', () => ({ log: vi.fn(), warn: vi.fn() }))
vi.mock('../ui/icons.js', () => ({ icon: vi.fn(() => ({})) }))
vi.mock('./local-store.js', () => ({
  clearLocalPreview: harness.clearLocalPreview,
  isDeletingLocal: harness.isDeletingLocal,
  isServerTemplate: harness.isServerTemplate,
  localTemplates: harness.localTemplates,
  onLocalReconciliation: (id: string, observer: () => void) => {
    const observers = harness.reconciliationObservers.get(id) ?? new Set<() => void>()
    observers.add(observer)
    harness.reconciliationObservers.set(id, observers)
    return () => observers.delete(observer)
  },
  placeLocalTemplate: harness.placeLocalTemplate,
  previewLocalTemplate: harness.previewLocalTemplate,
  removeLocalTemplate: harness.removeLocalTemplate,
  templateById: (id: string) =>
    harness.localTemplates().find((template: { id: string }) => template.id === id),
}))

const listeners = new Map<string, EventListener>()

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  listeners.clear()
  harness.reconciliationObservers.clear()
  harness.canvasPixelAt.mockReturnValue({ x: 2, y: 3 })
  harness.cssPixelsPerCanvasPixel.mockReturnValue({ x: 1, y: 1 })
  harness.isMapInteractionTarget.mockReturnValue(true)
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
      revision: 1,
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
    querySelector: vi.fn(() => null),
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
  it('leaves placement controls on the overlay instead of creating a move bar', async () => {
    const moves = await import('./move.js')

    expect(moves.beginMove('test', vi.fn())).toBe(true)
    expect(document.createElement).not.toHaveBeenCalled()
    await moves.commit()
  })

  it('reports when another placement prevents a new one from starting', async () => {
    const moves = await import('./move.js')

    expect(moves.beginMove('test', vi.fn())).toBe(true)
    expect(moves.beginMove('test', vi.fn())).toBe(false)
    await moves.commit()
  })

  it('does not offer Local placement for a server-owned template', async () => {
    harness.localTemplates.mockReturnValue([
      { ...harness.localTemplates()[0], serverUrl: 'https://example.test' },
    ])
    const moves = await import('./move.js')

    expect(moves.beginMove('test', vi.fn())).toBe(false)
    expect(harness.previewLocalTemplate).not.toHaveBeenCalled()
  })

  it('persists an accepted server placement remotely before accepting its local preview', async () => {
    harness.localTemplates.mockReturnValue([
      { ...harness.localTemplates()[0], serverUrl: 'https://example.test' },
    ])
    const persistRemote = vi.fn(async () => true)
    const moves = await import('./move.js')

    expect(moves.beginServerMove('test', vi.fn(), persistRemote)).toBe(true)
    const keydown = listeners.get('keydown')
    if (keydown === undefined) throw new Error('expected keydown listener')
    keydown({
      key: 'ArrowRight',
      shiftKey: false,
      target: { tagName: 'DIV', closest: vi.fn(() => null) },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as Event)

    await moves.commit()

    expect(persistRemote).toHaveBeenCalledWith(11, 20)
    expect(harness.placeLocalTemplate).toHaveBeenCalledWith('test', 11, 20)
  })

  it('keeps a refused server placement open and does not accept the local preview', async () => {
    harness.localTemplates.mockReturnValue([
      { ...harness.localTemplates()[0], serverUrl: 'https://example.test' },
    ])
    const moves = await import('./move.js')

    expect(
      moves.beginServerMove(
        'test',
        vi.fn(),
        vi.fn(async () => false),
      ),
    ).toBe(true)
    await moves.commit()

    expect(moves.movingId()).toBe('test')
    expect(harness.placeLocalTemplate).not.toHaveBeenCalled()
  })

  it('reserves the placement slot across asynchronous import preparation', async () => {
    const moves = await import('./move.js')
    const reservation = moves.reserveMove()
    if (reservation === null) throw new Error('expected move reservation')

    expect(moves.isMoving()).toBe(true)
    expect(moves.beginMove('test', vi.fn())).toBe(false)
    expect(reservation.start('test', vi.fn())).toBe(true)
    expect(moves.movingId()).toBe('test')

    reservation.release()
    await moves.commit()
  })

  it('releases an unused placement reservation', async () => {
    const moves = await import('./move.js')
    const reservation = moves.reserveMove()
    if (reservation === null) throw new Error('expected move reservation')

    reservation.release()

    expect(moves.isMoving()).toBe(false)
    expect(moves.beginMove('test', vi.fn())).toBe(true)
    await moves.commit()
  })

  it('does not reopen placement when its completion observer throws', async () => {
    const moves = await import('./move.js')
    moves.beginMove('test', () => {
      throw new Error('observer failed')
    })
    await expect(moves.commit()).resolves.toBeUndefined()
    await expect(moves.commit()).resolves.toBeUndefined()

    expect(harness.placeLocalTemplate).toHaveBeenCalledOnce()
    expect(window.removeEventListener).toHaveBeenCalled()
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

    pointerdown({
      button: 1,
      pointerId: 1,
      target: { tagName: 'CANVAS', closest: vi.fn(() => null) },
      clientX: 2,
      clientY: 3,
      preventDefault: vi.fn(),
    } as unknown as Event)
    auxclick(unrelated as unknown as Event)
    expect(unrelated.preventDefault).toHaveBeenCalledOnce()
  })

  it('does not capture placement pointers from page controls or outside the active map', async () => {
    const moves = await import('./move.js')
    moves.beginMove('test', vi.fn())
    const pointerdown = listeners.get('pointerdown')
    if (pointerdown === undefined) throw new Error('expected pointerdown listener')
    const control = { tagName: 'BUTTON', closest: vi.fn(() => null) }
    const controlEvent = {
      button: 1,
      pointerId: 1,
      target: control,
      clientX: 2,
      clientY: 3,
      preventDefault: vi.fn(),
    }

    pointerdown(controlEvent as unknown as Event)
    harness.isMapInteractionTarget.mockReturnValueOnce(false)
    const outsideEvent = {
      button: 1,
      pointerId: 2,
      target: { tagName: 'DIV', closest: vi.fn(() => null) },
      clientX: 2,
      clientY: 3,
      preventDefault: vi.fn(),
    }
    pointerdown(outsideEvent as unknown as Event)

    expect(controlEvent.preventDefault).not.toHaveBeenCalled()
    expect(outsideEvent.preventDefault).not.toHaveBeenCalled()
    expect(harness.canvasPixelAt).not.toHaveBeenCalled()
  })

  it('moves placement by keyboard with a larger Shift step', async () => {
    const moves = await import('./move.js')
    moves.beginMove('test', vi.fn())
    const keydown = listeners.get('keydown')
    if (keydown === undefined) throw new Error('expected keyboard listener')
    const preventDefault = vi.fn()
    const stopPropagation = vi.fn()

    keydown({
      key: 'ArrowRight',
      shiftKey: false,
      target: { tagName: 'DIV', closest: vi.fn(() => null) },
      preventDefault,
      stopPropagation,
    } as unknown as Event)
    keydown({
      key: 'ArrowUp',
      shiftKey: true,
      target: { tagName: 'DIV', closest: vi.fn(() => null) },
      preventDefault,
      stopPropagation,
    } as unknown as Event)

    expect(harness.previewLocalTemplate).toHaveBeenNthCalledWith(1, 'test', 11, 20)
    expect(harness.previewLocalTemplate).toHaveBeenNthCalledWith(2, 'test', 11, 10)
    expect(preventDefault).toHaveBeenCalledTimes(2)
    expect(stopPropagation).toHaveBeenCalledTimes(2)
  })

  it('allows only one commit while an asynchronous placement is finishing', async () => {
    let finishMove = (): void => undefined
    harness.placeLocalTemplate.mockImplementationOnce(async () => {
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

    expect(harness.placeLocalTemplate).toHaveBeenCalledOnce()
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

  it('converts drag deltas with independent horizontal and vertical CSS scales', async () => {
    harness.canvasPixelAt.mockReturnValue({ x: 12, y: 22 })
    harness.cssPixelsPerCanvasPixel.mockReturnValue({ x: 2, y: 4 })
    const moves = await import('./move.js')
    moves.beginMove('test', vi.fn())
    const pointerdown = listeners.get('pointerdown')
    const pointermove = listeners.get('pointermove')
    if (pointerdown === undefined || pointermove === undefined)
      throw new Error('expected listeners')

    pointerdown({
      button: 0,
      pointerId: 1,
      clientX: 100,
      clientY: 100,
      ctrlKey: true,
      metaKey: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as Event)
    pointermove({
      pointerId: 1,
      clientX: 200,
      clientY: 200,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as Event)

    expect(harness.previewLocalTemplate).toHaveBeenLastCalledWith('test', 60, 45)
  })

  it('does not rescale the accumulated drag delta when the map zoom changes mid-drag', async () => {
    harness.canvasPixelAt.mockReturnValue({ x: 12, y: 22 })
    harness.cssPixelsPerCanvasPixel.mockReturnValue({ x: 2, y: 4 })
    const moves = await import('./move.js')
    moves.beginMove('test', vi.fn())
    const pointerdown = listeners.get('pointerdown')
    const pointermove = listeners.get('pointermove')
    if (pointerdown === undefined || pointermove === undefined)
      throw new Error('expected listeners')

    pointerdown({
      button: 0,
      pointerId: 1,
      clientX: 100,
      clientY: 100,
      ctrlKey: true,
      metaKey: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as Event)
    harness.cssPixelsPerCanvasPixel.mockReturnValue({ x: 4, y: 8 })
    pointermove({
      pointerId: 1,
      clientX: 200,
      clientY: 200,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as Event)

    expect(harness.previewLocalTemplate).toHaveBeenLastCalledWith('test', 60, 45)
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
    pointercancel({
      pointerId: 7,
      clientX: 110,
      clientY: 110,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as Event)
    pointermove({
      pointerId: 7,
      clientX: 120,
      clientY: 120,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as Event)
    expect(harness.previewLocalTemplate).toHaveBeenCalledOnce()
  })

  it('does not let a second pointer replace or recenter an active drag', async () => {
    harness.canvasPixelAt.mockReturnValueOnce({ x: 12, y: 22 }).mockReturnValue({ x: 500, y: 600 })
    const moves = await import('./move.js')
    moves.beginMove('test', vi.fn())
    const pointerdown = listeners.get('pointerdown')
    const pointermove = listeners.get('pointermove')
    if (pointerdown === undefined || pointermove === undefined)
      throw new Error('expected pointer listeners')

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
    pointerdown({
      button: 0,
      pointerId: 8,
      clientX: 300,
      clientY: 300,
      ctrlKey: true,
      metaKey: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as Event)
    pointerdown({
      button: 1,
      pointerId: 8,
      clientX: 500,
      clientY: 600,
      preventDefault: vi.fn(),
    } as unknown as Event)
    pointermove({
      pointerId: 7,
      clientX: 110,
      clientY: 120,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as Event)

    expect(harness.previewLocalTemplate).toHaveBeenCalledOnce()
    expect(harness.previewLocalTemplate).toHaveBeenCalledWith('test', 20, 40)
  })

  it('ignores placement shortcuts in controls, dialogs and the panel tree', async () => {
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
    const panelTarget = {
      tagName: 'DIV',
      closest: vi.fn((selector: string) => (selector.includes('#caelestis-panel') ? {} : null)),
    }
    const panelPreventDefault = vi.fn()
    keydown({
      key: 'ArrowDown',
      target: panelTarget,
      preventDefault: panelPreventDefault,
      stopPropagation: vi.fn(),
    } as unknown as Event)
    keydown({
      key: 'Enter',
      target: panelTarget,
      preventDefault: panelPreventDefault,
    } as unknown as Event)
    keydown({
      key: 'Escape',
      target: panelTarget,
      preventDefault: panelPreventDefault,
    } as unknown as Event)
    await Promise.resolve()

    expect(harness.placeLocalTemplate).not.toHaveBeenCalled()
    expect(harness.previewLocalTemplate).not.toHaveBeenCalled()
    expect(harness.clearLocalPreview).not.toHaveBeenCalled()
    expect(panelPreventDefault).not.toHaveBeenCalled()
  })

  it('recovers placement controls after a final bitmap build rejects', async () => {
    harness.placeLocalTemplate.mockRejectedValueOnce(new Error('bitmap failed'))
    const moves = await import('./move.js')
    moves.beginMove('test', vi.fn())

    await expect(moves.commit()).resolves.toBeUndefined()
    await expect(moves.commit()).resolves.toBeUndefined()

    expect(harness.placeLocalTemplate).toHaveBeenCalledTimes(2)
  })

  it('finishes a placement whose template was deleted while Apply was pending', async () => {
    harness.placeLocalTemplate.mockResolvedValueOnce(false)
    const active = harness.localTemplates()
    harness.localTemplates.mockClear()
    harness.localTemplates.mockReturnValueOnce(active).mockReturnValueOnce([])
    const finished = vi.fn()
    const moves = await import('./move.js')
    moves.beginMove('test', finished)
    finished.mockClear()

    await moves.commit()

    expect(finished).toHaveBeenCalledOnce()
  })

  it('finishes at a reconciled winner instead of retrying stale Apply coordinates', async () => {
    harness.placeLocalTemplate.mockImplementationOnce(async () => {
      for (const observer of harness.reconciliationObservers.get('test') ?? []) observer()
      return false
    })
    const active = harness.localTemplates()
    harness.localTemplates.mockClear()
    harness.localTemplates
      .mockReturnValueOnce(active)
      .mockReturnValue([{ ...active[0], originX: 90, originY: 80, revision: 2 }])
    const finished = vi.fn()
    const moves = await import('./move.js')
    moves.beginMove('test', finished)
    finished.mockClear()

    await moves.commit()
    await moves.commit()

    expect(finished).toHaveBeenCalledOnce()
    expect(harness.placeLocalTemplate).toHaveBeenCalledOnce()
  })

  it('finishes at a reconciled winner instead of retrying stale Cancel', async () => {
    harness.removeLocalTemplate.mockImplementationOnce(async () => {
      for (const observer of harness.reconciliationObservers.get('test') ?? []) observer()
      return false
    })
    const active = (harness.localTemplates() as Array<Record<string, unknown>>).map((template) => ({
      ...template,
      everPlaced: false,
    }))
    harness.localTemplates.mockClear()
    harness.localTemplates
      .mockReturnValueOnce(active)
      .mockReturnValue([{ ...active[0], originX: 90, originY: 80, revision: 2 }])
    const finished = vi.fn()
    const moves = await import('./move.js')
    moves.beginMove('test', finished)
    finished.mockClear()

    await moves.abort()
    await moves.abort()

    expect(finished).toHaveBeenCalledOnce()
    expect(harness.removeLocalTemplate).toHaveBeenCalledOnce()
  })

  it('reverts an existing template to its original placement on cancel', async () => {
    const moves = await import('./move.js')
    moves.beginMove('test', vi.fn())

    await moves.abort()

    expect(harness.clearLocalPreview).toHaveBeenCalledWith('test')
    expect(harness.placeLocalTemplate).not.toHaveBeenCalled()
    expect(harness.removeLocalTemplate).not.toHaveBeenCalled()
  })

  it('releases placement ownership before another surface deletes the template', async () => {
    const finished = vi.fn()
    const moves = await import('./move.js')
    moves.beginMove('test', finished)

    const stopped = moves.stopMoveForDeletion('test')
    expect(stopped?.origin).toEqual({ x: 10, y: 20 })

    // Deletion has released the active preview, but keeps ownership of the one move slot until the
    // durable delete either succeeds or restores it.
    expect(moves.isMoving()).toBe(true)
    expect(moves.beginMove('other', vi.fn())).toBe(false)
    expect(harness.clearLocalPreview).toHaveBeenCalledWith('test')
    expect(finished).toHaveBeenCalledOnce()
    expect(moves.stopMoveForDeletion('other')).toBeNull()
    stopped?.reservation.release()
    expect(moves.isMoving()).toBe(false)
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
    expect(harness.placeLocalTemplate).not.toHaveBeenCalled()
  })
})
