// @vitest-environment happy-dom

import type { RegionDocument } from '@caelestis/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  scale: 1,
  saved: [] as { id: string | null; document: RegionDocument }[],
  removed: [] as string[],
  saveError: null as string | null,
  template: 'Mural' as string | null,
  map: null as HTMLElement | null,
}))

vi.mock('./main.js', () => ({
  canvasPixelAt: (x: number, y: number) => ({ x: x / harness.scale, y: y / harness.scale }),
  screenProjection: () => ({
    pointFor: (x: number, y: number) => ({ x: x * harness.scale, y: y * harness.scale }),
    pixelsPerCanvasPixel: { x: harness.scale, y: harness.scale },
  }),
  isMapInteractionTarget: (target: EventTarget | null) => target === harness.map,
}))
vi.mock('./debug.js', () => ({ log: vi.fn(), warn: vi.fn() }))
vi.mock('./ui/theme.js', () => ({ applyWplaceTheme: vi.fn() }))
vi.mock('@caelestis/ui/elements', () => ({ CLAIM_MODE_TAG: 'caelestis-claim-mode' }))

const host = () => ({
  templateFor: () => harness.template,
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

  it('never consumes the wheel, and leaves empty-canvas presses to the map with the selection tool', async () => {
    await setup('select')
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 })
    map().dispatchEvent(wheel)
    expect(wheel.defaultPrevented).toBe(false)
    expect(click(5, 5).defaultPrevented).toBe(false)
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

  it('cancels without saving', async () => {
    const editor = await setup('rectangle')
    drag(0, 0, 3, 3)
    editor.handleClaimModeIntent({ type: 'cancel' })
    expect(editor.isClaimModeActive()).toBe(false)
    expect(harness.saved).toHaveLength(0)
  })
})
