// @vitest-environment happy-dom

import { type RegionDocument, regionDocumentContainsPixel } from '@caelestis/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  scale: 1,
  regions: [] as { id: string; document: RegionDocument }[],
  saved: [] as { id: string | null; document: RegionDocument }[],
  removed: [] as string[],
  saveError: null as string | null,
  template: 'Mural' as string | null,
  map: null as HTMLElement | null,
  panned: [] as [number, number][],
}))

vi.mock('./main.js', () => ({
  canvasPixelAt: (x: number, y: number) => ({ x: x / harness.scale, y: y / harness.scale }),
  screenProjection: () => ({
    pointFor: (x: number, y: number) => ({ x: x * harness.scale, y: y * harness.scale }),
    pixelsPerCanvasPixel: { x: harness.scale, y: harness.scale },
  }),
  isMapInteractionTarget: (target: EventTarget | null) => target === harness.map,
}))
vi.mock('./map-handle.js', () => ({
  getMap: () => ({ panBy: (offset: [number, number]) => harness.panned.push(offset) }),
}))
vi.mock('./debug.js', () => ({ log: vi.fn(), warn: vi.fn() }))
vi.mock('./ui/theme.js', () => ({ applyWplaceTheme: vi.fn() }))
vi.mock('@caelestis/ui/elements', () => ({ CLAIM_MODE_TAG: 'caelestis-claim-mode' }))

const host = () => ({
  templateFor: () => harness.template,
  myRegions: () => harness.regions,
  save: async (id: string | null, document: RegionDocument) => {
    harness.saved.push({ id, document })
    return harness.saveError
  },
  remove: async (id: string) => {
    harness.removed.push(id)
    return null
  },
  changed: vi.fn(),
})

const map = (): HTMLElement => {
  if (harness.map === null) throw new Error('map missing')
  return harness.map
}

const pointer = (
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  x: number,
  y: number,
  target: Element = map(),
): PointerEvent => {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
    pointerId: 1,
  })
  target.dispatchEvent(event)
  return event
}

const drag = (fromX: number, fromY: number, toX: number, toY: number): void => {
  pointer('pointerdown', fromX, fromY)
  pointer('pointermove', toX, toY)
  pointer('pointerup', toX, toY)
}

const click = (x: number, y: number): PointerEvent => {
  const down = pointer('pointerdown', x, y)
  pointer('pointerup', x, y)
  return down
}

const key = (value: string): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })
  document.dispatchEvent(event)
  return event
}

const handle = (name: string): HTMLElement => {
  const element = document.querySelector<HTMLElement>(
    `#caelestis-claim-overlay [data-handle="${name}"]`,
  )
  if (element === null) throw new Error(`handle ${name} missing`)
  return element
}

const setup = async (
  tool?: Parameters<typeof import('./claim-editor.js')['startClaimMode']>[0],
) => {
  const editor = await import('./claim-editor.js')
  editor.installClaimEditor(host())
  editor.startClaimMode(tool)
  return editor
}

beforeEach(() => {
  harness.scale = 1
  harness.regions = []
  harness.saved = []
  harness.removed = []
  harness.saveError = null
  harness.template = 'Mural'
  document.body.innerHTML = ''
  const canvas = document.createElement('canvas')
  canvas.className = 'maplibregl-canvas'
  document.body.appendChild(canvas)
  harness.map = canvas
  Element.prototype.setPointerCapture ??= () => undefined
  Element.prototype.releasePointerCapture ??= () => undefined
})

afterEach(async () => {
  const { resetClaimEditor } = await import('./claim-editor.js')
  resetClaimEditor()
  vi.resetModules()
})

describe('claim editor', () => {
  it('draws a whole-pixel rectangle that becomes an editable item', async () => {
    const editor = await setup('rectangle')
    drag(10.6, 20.2, 14.9, 22.1)
    expect(editor.claimModeModel()).toMatchObject({ items: 1, selected: true, pixels: 15 })
    expect(editor.claimEditorPixels()?.rect).toEqual({ x: 10, y: 20, w: 5, h: 3 })
  })

  it('turns a plain wheel into a pan and leaves a modified wheel to the map to zoom', async () => {
    await setup('select')
    harness.panned = []
    // happy-dom's WheelEvent drops modifier flags, so they are pinned on by hand.
    const wheel = (deltaY: number, modifier?: 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey') => {
      const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY })
      for (const flag of ['shiftKey', 'altKey', 'ctrlKey', 'metaKey'] as const)
        Object.defineProperty(event, flag, { value: flag === modifier })
      map().dispatchEvent(event)
      return event
    }
    expect(wheel(120).defaultPrevented).toBe(true)
    expect(wheel(40, 'shiftKey').defaultPrevented).toBe(true)
    expect(harness.panned).toEqual([
      [0, 120],
      [40, 0],
    ])
    for (const modifier of ['altKey', 'ctrlKey', 'metaKey'] as const)
      expect(wheel(120, modifier).defaultPrevented).toBe(false)
    expect(harness.panned).toHaveLength(2)
  })

  it('only the hand tool leaves a press to the map, and Space is a temporary hand', async () => {
    const editor = await setup('select')
    drag(50, 50, 59, 59)
    editor.handleClaimModeIntent({ type: 'set-tool', tool: 'hand' })
    expect(click(55, 55).defaultPrevented).toBe(false)
    expect(map().style.cursor).toBe('grab')
    editor.handleClaimModeIntent({ type: 'set-tool', tool: 'select' })
    expect(map().style.cursor).toBe('default')
    key(' ')
    expect(editor.claimEditorTool()).toBe('hand')
    document.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true }))
    expect(editor.claimEditorTool()).toBe('select')
  })

  it('drags a marquee over empty canvas with the selection tool, lighting what it catches', async () => {
    const editor = await setup('rectangle')
    drag(10, 10, 19, 19)
    drag(40, 10, 49, 19)
    drag(80, 80, 89, 89)
    editor.handleClaimModeIntent({ type: 'set-tool', tool: 'select' })
    click(200, 200)
    expect(editor.claimModeModel().selectedCount).toBe(0)
    // The press on empty canvas is consumed, so the map does not pan under the marquee.
    expect(pointer('pointerdown', 5, 5).defaultPrevented).toBe(true)
    pointer('pointermove', 55, 25)
    expect(
      document.querySelector('#caelestis-claim-overlay [data-gesture="marquee"]'),
    ).not.toBeNull()
    expect(editor.claimModeModel().selectedCount).toBe(2)
    pointer('pointerup', 55, 25)
    expect(document.querySelector('#caelestis-claim-overlay [data-gesture="marquee"]')).toBeNull()
    expect(editor.claimModeModel().selectedCount).toBe(2)
    // Shift-click adds the third; Delete removes all three.
    const down = new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      clientX: 85,
      clientY: 85,
      button: 0,
      pointerId: 1,
      shiftKey: true,
    })
    map().dispatchEvent(down)
    pointer('pointerup', 85, 85)
    expect(editor.claimModeModel().selectedCount).toBe(3)
    key('Delete')
    expect(editor.claimModeModel().items).toBe(0)
  })

  it('selects with the lasso whatever its loop encloses, and moves a multi-selection together', async () => {
    const editor = await setup('rectangle')
    drag(10, 10, 19, 19)
    drag(40, 10, 49, 19)
    drag(80, 80, 89, 89)
    key('q')
    expect(editor.claimEditorTool()).toBe('lasso')
    expect(pointer('pointerdown', 0, 0).defaultPrevented).toBe(true)
    pointer('pointermove', 60, 0)
    pointer('pointermove', 60, 30)
    pointer('pointermove', 0, 30)
    expect(document.querySelector('#caelestis-claim-overlay [data-gesture="lasso"]')).not.toBeNull()
    pointer('pointerup', 0, 30)
    expect(editor.claimModeModel().selectedCount).toBe(2)
    key('v')
    drag(15, 15, 25, 15)
    const bounds = editor.claimEditorBounds()
    // Both caught shapes moved right by ten; the third stayed put.
    expect(bounds).toEqual({ x: 20, y: 10, w: 70, h: 80 })
  })

  it('subtracts a second shape and rasterises the difference', async () => {
    const editor = await setup('rectangle')
    drag(0, 0, 5, 5)
    // The toggle applies to the selected item too, so deselect before arming it for the cut-out.
    key('Escape')
    editor.handleClaimModeIntent({ type: 'set-tool', tool: 'ellipse' })
    editor.handleClaimModeIntent({ type: 'set-subtract', subtract: true })
    expect(editor.claimEditorPixels()?.count).toBe(36)
    drag(2, 2, 3, 3)
    expect(editor.claimModeModel().items).toBe(2)
    expect(editor.claimEditorPixels()?.count).toBe(32)
  })

  it('selects an item by clicking it and moves it by dragging with the selection tool', async () => {
    const editor = await setup('rectangle')
    drag(50, 50, 59, 59)
    editor.handleClaimModeIntent({ type: 'set-tool', tool: 'select' })
    click(80, 80)
    expect(editor.claimModeModel().selected).toBe(false)
    expect(click(55, 55).defaultPrevented).toBe(true)
    expect(editor.claimModeModel().selected).toBe(true)
    drag(55, 55, 65, 58)
    expect(editor.claimEditorPixels()?.rect).toEqual({ x: 60, y: 53, w: 10, h: 10 })
  })

  it('resizes a rectangle from a corner handle and keeps the opposite corner', async () => {
    const editor = await setup('rectangle')
    drag(10, 10, 19, 19)
    editor.handleClaimModeIntent({ type: 'set-tool', tool: 'select' })
    click(15, 15)
    const corner = handle('corner:2')
    pointer('pointerdown', 20, 20, corner)
    pointer('pointermove', 29, 24)
    pointer('pointerup', 29, 24)
    expect(editor.claimEditorPixels()?.rect).toEqual({ x: 10, y: 10, w: 20, h: 15 })
  })

  it('lets direct selection drag any anchor of a rectangle, turning it into a path', async () => {
    const editor = await setup('rectangle')
    drag(10, 10, 29, 29)
    editor.handleClaimModeIntent({ type: 'set-tool', tool: 'direct' })
    click(15, 15)
    expect(
      document.querySelectorAll('#caelestis-claim-overlay [data-handle^="anchor:"]'),
    ).toHaveLength(4)
    // Corner 2 is the bottom-right (30, 30); pulling it out makes a kite, no longer a box.
    const corner = handle('anchor:2')
    pointer('pointerdown', 30, 30, corner)
    pointer('pointermove', 50, 50)
    pointer('pointerup', 50, 50)
    expect(editor.claimModeModel().items).toBe(1)
    expect(
      document.querySelectorAll('#caelestis-claim-overlay [data-handle$=":anchor"]'),
    ).toHaveLength(4)
    key('Enter')
    await Promise.resolve()
    const document_ = harness.saved[0]?.document as RegionDocument
    const shape = document_.items[0]?.shape
    expect(shape?.kind).toBe('path')
    expect(shape?.kind === 'path' ? shape.nodes.length : 0).toBe(4)
    expect(regionDocumentContainsPixel(document_, 45, 45)).toBe(true)
    expect(regionDocumentContainsPixel(document_, 12, 45)).toBe(false)
    expect(regionDocumentContainsPixel(document_, 15, 15)).toBe(true)
  })

  it('keeps the pixels of an ellipse when its anchors turn it into a bezier path', async () => {
    const editor = await setup('ellipse')
    drag(10, 10, 49, 29)
    const before = editor.claimEditorPixels()?.count ?? 0
    editor.handleClaimModeIntent({ type: 'set-tool', tool: 'direct' })
    click(30, 20)
    const top = handle('anchor:0')
    pointer('pointerdown', 30, 10, top)
    pointer('pointerup', 30, 10)
    const after = editor.claimEditorPixels()?.count ?? 0
    expect(Math.abs(after - before)).toBeLessThanOrEqual(Math.ceil(before * 0.03))
    expect(document.querySelectorAll('#caelestis-claim-overlay [data-handle$=":in"]')).toHaveLength(
      4,
    )
  })

  it('rotates a polygon from the grip in whole degrees, and a rectangle from a corner zone', async () => {
    const editor = await setup('polygon')
    drag(100, 100, 140, 100)
    editor.handleClaimModeIntent({ type: 'set-tool', tool: 'direct' })
    click(100, 100)
    const grip = handle('rotate:0')
    // A quarter turn clockwise around the centre (100, 100): from straight above to the right.
    pointer('pointerdown', 100, 60, grip)
    pointer('pointermove', 140, 100)
    pointer('pointerup', 140, 100)
    const saved = editor.claimModeModel()
    expect(saved.items).toBe(1)
    key('Enter')
    await Promise.resolve()
    const shape = harness.saved[0]?.document.items[0]?.shape
    expect(shape?.kind).toBe('polygon')
    expect(shape?.kind === 'polygon' ? shape.rotation : -1).toBe(90)

    const again = await setup('rectangle')
    drag(200, 200, 239, 219)
    again.handleClaimModeIntent({ type: 'set-tool', tool: 'direct' })
    click(210, 210)
    // Just outside the bottom-right corner (240, 220) is a rotate zone, not a marquee start.
    expect(map().style.cursor).toBe('default')
    pointer('pointermove', 254, 234)
    expect(map().style.cursor).toContain('url(')
    expect(pointer('pointerdown', 254, 234).defaultPrevented).toBe(true)
    pointer('pointermove', 206, 234)
    pointer('pointerup', 206, 234)
    expect(document.querySelector('#caelestis-claim-overlay [data-gesture="marquee"]')).toBeNull()
    const bounds = again.claimEditorBounds()
    // Turned by about a quarter, the 40 by 20 box now stands roughly 20 by 40 about its centre.
    expect(bounds?.w).toBeLessThan(30)
    expect(bounds?.h).toBeGreaterThan(34)
  })

  it('builds a closed path with the pen, curving a segment by dragging', async () => {
    const editor = await setup('pen')
    click(0, 0)
    pointer('pointerdown', 20, 0)
    pointer('pointermove', 30, 10)
    pointer('pointerup', 30, 10)
    click(20, 20)
    click(0, 20)
    expect(editor.claimModeModel().items).toBe(0)
    // Clicking the first anchor closes the path into a filled item.
    click(0, 0)
    expect(editor.claimModeModel().items).toBe(1)
    const pixels = editor.claimEditorPixels()
    expect(pixels?.count).toBeGreaterThan(400)
  })

  it('finishes an open pen path with Enter as a stroke and drops one with Escape', async () => {
    const editor = await setup('pen')
    editor.handleClaimModeIntent({ type: 'set-option', option: 'width', value: 3 })
    click(0, 5)
    click(30, 5)
    key('Enter')
    expect(editor.claimModeModel().items).toBe(1)
    expect(editor.claimEditorPixels()?.count).toBeGreaterThan(80)
    click(50, 50)
    click(60, 60)
    key('Escape')
    expect(editor.claimModeModel().items).toBe(1)
  })

  it('records a brush stroke as an open path with the chosen width', async () => {
    const editor = await setup('brush')
    editor.handleClaimModeIntent({ type: 'set-option', option: 'width', value: 5 })
    pointer('pointerdown', 10, 10)
    pointer('pointermove', 20, 10)
    pointer('pointermove', 30, 12)
    pointer('pointerup', 30, 12)
    expect(editor.claimModeModel().items).toBe(1)
    expect(editor.claimEditorPixels()?.count).toBeGreaterThan(100)
  })

  it('switches tools with letters, deletes the selected item, and confirms into a save', async () => {
    const editor = await setup('rectangle')
    key('l')
    expect(editor.claimEditorTool()).toBe('ellipse')
    key('v')
    expect(editor.claimEditorTool()).toBe('select')
    key('m')
    drag(0, 0, 4, 4)
    drag(10, 10, 12, 12)
    expect(editor.claimModeModel().items).toBe(2)
    key('Delete')
    expect(editor.claimModeModel().items).toBe(1)
    key('Enter')
    await vi.waitFor(() => expect(harness.saved).toHaveLength(1))
    expect(harness.saved[0]?.document.items).toHaveLength(1)
    await vi.waitFor(() => expect(editor.isClaimModeActive()).toBe(false))
    expect(document.getElementById('caelestis-claim-mode')).toBeNull()
  })

  it('loads a saved claim for editing and saves it under the same id', async () => {
    const editor = await import('./claim-editor.js')
    editor.installClaimEditor(host())
    editor.startClaimMode('select', {
      id: 'r1',
      document: {
        items: [{ id: 'a', op: 'add', shape: { kind: 'rectangle', x: 5, y: 5, w: 4, h: 4 } }],
      },
    })
    expect(editor.claimEditorEditingId()).toBe('r1')
    expect(editor.claimModeModel()).toMatchObject({ editing: true, items: 1 })
    editor.handleClaimModeIntent({ type: 'confirm' })
    await vi.waitFor(() => expect(harness.saved[0]?.id).toBe('r1'))
  })

  it('loads one of my saved claims by clicking it in claim mode, unless work would be lost', async () => {
    harness.regions = [
      {
        id: 'r1',
        document: {
          items: [{ id: 'a', op: 'add', shape: { kind: 'ellipse', x: 40, y: 40, w: 20, h: 20 } }],
        },
      },
    ]
    const editor = await setup('select')
    expect(click(50, 50).defaultPrevented).toBe(true)
    expect(editor.claimEditorEditingId()).toBe('r1')
    expect(editor.claimModeModel()).toMatchObject({ editing: true, items: 1 })
    // Draw something new on top: now the loaded claim has unsaved work, so another claim
    // cannot replace it.
    harness.regions.push({
      id: 'r2',
      document: {
        items: [{ id: 'b', op: 'add', shape: { kind: 'rectangle', x: 100, y: 100, w: 5, h: 5 } }],
      },
    })
    editor.handleClaimModeIntent({ type: 'set-tool', tool: 'rectangle' })
    drag(70, 70, 72, 72)
    editor.handleClaimModeIntent({ type: 'set-tool', tool: 'select' })
    click(102, 102)
    expect(editor.claimEditorEditingId()).toBe('r1')
    expect(editor.claimModeModel().message).toMatch(/Confirm or cancel/)
  })

  it('cancels without saving', async () => {
    const editor = await setup('rectangle')
    drag(0, 0, 3, 3)
    editor.handleClaimModeIntent({ type: 'cancel' })
    expect(editor.isClaimModeActive()).toBe(false)
    expect(harness.saved).toHaveLength(0)
  })
})
