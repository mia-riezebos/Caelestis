// @vitest-environment happy-dom

import type { RegionShape } from '@caelestis/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  scale: 1,
  regions: [] as { id: string; shape: RegionShape }[],
  saved: [] as { id: string | null; shape: RegionShape }[],
  removed: [] as string[],
  saveError: null as string | null,
  template: 'Mural' as string | null,
  paintOpen: false,
  map: null as HTMLElement | null,
}))

vi.mock('./main.js', () => ({
  // Client pixel (x, y) is canvas pixel (x / scale, y / scale): a plain zoom about the origin.
  canvasPixelAt: (x: number, y: number) => ({ x: x / harness.scale, y: y / harness.scale }),
  screenProjection: () => ({
    pointFor: (x: number, y: number) => ({ x: x * harness.scale, y: y * harness.scale }),
    pixelsPerCanvasPixel: { x: harness.scale, y: harness.scale },
  }),
  isMapInteractionTarget: (target: EventTarget | null) => target === harness.map,
}))
vi.mock('./debug.js', () => ({ log: vi.fn(), warn: vi.fn() }))
vi.mock('./ui/theme.js', () => ({ applyWplaceTheme: vi.fn() }))
vi.mock('./wplace-paint.js', () => ({ isPaintOpen: () => harness.paintOpen }))
vi.mock('./templates/move.js', () => ({ isMoving: () => false }))
vi.mock('@caelestis/ui/elements', () => ({ CLAIM_TOOL_TAG: 'caelestis-claim-tool' }))

const host = () => ({
  templateFor: () => harness.template,
  myRegions: () => harness.regions,
  save: async (id: string | null, shape: RegionShape) => {
    harness.saved.push({ id, shape })
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
  init: Partial<PointerEventInit> = {},
  target: Element = map(),
): PointerEvent => {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
    pointerId: 1,
    ...init,
  })
  target.dispatchEvent(event)
  return event
}

const drag = (
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  init: Partial<PointerEventInit> = {},
): void => {
  pointer('pointerdown', fromX, fromY, init)
  pointer('pointermove', toX, toY, init)
  pointer('pointerup', toX, toY, init)
}

const key = (value: string, init: Partial<KeyboardEventInit> = {}): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', {
    key: value,
    bubbles: true,
    cancelable: true,
    ...init,
  })
  document.dispatchEvent(event)
  return event
}

const setup = async (kind?: 'rectangle' | 'ellipse' | 'polygon' | 'star') => {
  const tool = await import('./claim-tool.js')
  tool.installClaimTool(host())
  if (kind !== undefined) tool.startClaimTool(kind)
  return tool
}

beforeEach(() => {
  harness.scale = 1
  harness.regions = []
  harness.saved = []
  harness.removed = []
  harness.saveError = null
  harness.template = 'Mural'
  harness.paintOpen = false
  document.body.innerHTML = ''
  const canvas = document.createElement('canvas')
  canvas.className = 'maplibregl-canvas'
  document.body.appendChild(canvas)
  harness.map = canvas
  Element.prototype.setPointerCapture ??= () => undefined
  Element.prototype.releasePointerCapture ??= () => undefined
})

afterEach(async () => {
  const { resetClaimTool } = await import('./claim-tool.js')
  resetClaimTool()
  vi.resetModules()
})

describe('claim tool', () => {
  it('draws a whole-pixel rectangle from a drag, inclusive of both corners', async () => {
    const tool = await setup('rectangle')
    drag(10.6, 20.2, 14.9, 22.1)
    expect(tool.claimToolShape()).toEqual({ kind: 'rectangle', x: 10, y: 20, w: 5, h: 3 })
    expect(tool.claimToolModel()).toMatchObject({ drawn: true, editing: false, pixels: 15 })
  })

  it('leaves the map alone with no tool selected and nothing under the pointer', async () => {
    await setup()
    const down = pointer('pointerdown', 10, 10)
    expect(down.defaultPrevented).toBe(false)
    const move = pointer('pointermove', 20, 20)
    expect(move.defaultPrevented).toBe(false)
  })

  it('does not consume the wheel, so the map still zooms with a tool selected', async () => {
    await setup('rectangle')
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 })
    map().dispatchEvent(wheel)
    expect(wheel.defaultPrevented).toBe(false)
  })

  it('never produces a half pixel when zoomed in', async () => {
    harness.scale = 8
    const tool = await setup('ellipse')
    drag(83, 163, 131, 199)
    expect(tool.claimToolShape()).toEqual({ kind: 'ellipse', x: 10, y: 20, w: 7, h: 5 })
  })

  it('draws round shapes from the centre with a whole-degree rotation', async () => {
    const tool = await setup('polygon')
    tool.handleClaimToolIntent({ type: 'set-sides', sides: 5 })
    drag(100, 100, 100, 130)
    expect(tool.claimToolShape()).toEqual({
      kind: 'polygon',
      cx: 100,
      cy: 100,
      r: 30,
      sides: 5,
      rotation: 90,
    })
    tool.handleClaimToolIntent({ type: 'set-kind', kind: 'star' })
    tool.handleClaimToolIntent({ type: 'set-points', points: 6 })
    expect(tool.claimToolShape()).toMatchObject({
      kind: 'star',
      cx: 100,
      cy: 100,
      r: 30,
      points: 6,
    })
  })

  it('switches kinds with M and L, saves on Enter, and switches off after saving', async () => {
    const tool = await setup('polygon')
    key('l')
    expect(tool.claimToolModel().kind).toBe('ellipse')
    key('m')
    expect(tool.claimToolModel().kind).toBe('rectangle')
    drag(0, 0, 3, 3)
    expect(key('Enter').defaultPrevented).toBe(true)
    await vi.waitFor(() => expect(harness.saved).toHaveLength(1))
    expect(harness.saved[0]).toEqual({
      id: null,
      shape: { kind: 'rectangle', x: 0, y: 0, w: 4, h: 4 },
    })
    await vi.waitFor(() => expect(tool.claimToolMode()).toBe('off'))
    expect(document.getElementById('caelestis-claim-toolbar')).toBeNull()
  })

  it('claims a shape that touches no template at all', async () => {
    harness.template = null
    const tool = await setup('rectangle')
    drag(0, 0, 3, 3)
    expect(tool.claimToolModel().template).toBeNull()
    tool.handleClaimToolIntent({ type: 'claim' })
    await vi.waitFor(() => expect(harness.saved).toHaveLength(1))
  })

  it('selects one of my claims with a plain click when no tool is selected', async () => {
    harness.regions = [{ id: 'r1', shape: { kind: 'rectangle', x: 50, y: 50, w: 10, h: 10 } }]
    const tool = await setup()
    const down = pointer('pointerdown', 55, 55)
    pointer('pointerup', 55, 55)
    expect(down.defaultPrevented).toBe(true)
    expect(tool.claimToolMode()).toBe('edit')
    expect(tool.claimToolEditingId()).toBe('r1')
    expect(document.getElementById('caelestis-claim-toolbar')).not.toBeNull()
    const outer = document.querySelector<HTMLElement>(
      '#caelestis-claim-handles [data-mode="outer"]',
    )
    expect(outer?.style.display).toBe('block')
    // A press on empty canvas ends the edit and is left to the map, so it pans.
    const away = pointer('pointerdown', 5, 5)
    pointer('pointerup', 5, 5)
    expect(away.defaultPrevented).toBe(false)
    expect(tool.claimToolMode()).toBe('off')
  })

  it('moves a claim with a plain drag and saves it under the same id', async () => {
    harness.regions = [{ id: 'r1', shape: { kind: 'rectangle', x: 50, y: 50, w: 10, h: 10 } }]
    const tool = await setup()
    drag(55, 55, 60, 58)
    expect(tool.claimToolShape()).toEqual({ kind: 'rectangle', x: 55, y: 53, w: 10, h: 10 })
    expect(map().style.cursor).toBe('grab')
    tool.handleClaimToolIntent({ type: 'claim' })
    await vi.waitFor(() => expect(harness.saved).toHaveLength(1))
    expect(harness.saved[0]?.id).toBe('r1')
    await vi.waitFor(() => expect(tool.claimToolMode()).toBe('off'))
  })

  it('leaves claims alone while the paint drawer is open', async () => {
    harness.paintOpen = true
    harness.regions = [{ id: 'r1', shape: { kind: 'rectangle', x: 50, y: 50, w: 10, h: 10 } }]
    const tool = await setup()
    const press = pointer('pointerdown', 55, 55)
    pointer('pointerup', 55, 55)
    expect(press.defaultPrevented).toBe(false)
    expect(tool.claimToolMode()).toBe('off')
  })

  it('draws over a claim rather than selecting it while a shape tool is chosen', async () => {
    harness.regions = [{ id: 'r1', shape: { kind: 'rectangle', x: 50, y: 50, w: 10, h: 10 } }]
    const tool = await setup('ellipse')
    drag(55, 55, 58, 58)
    expect(tool.claimToolEditingId()).toBeNull()
    expect(tool.claimToolShape()).toEqual({ kind: 'ellipse', x: 55, y: 55, w: 4, h: 4 })
  })

  it('deletes the selected claim with Delete and clears an unsaved shape', async () => {
    harness.regions = [{ id: 'r1', shape: { kind: 'ellipse', x: 50, y: 50, w: 10, h: 10 } }]
    const tool = await setup()
    pointer('pointerdown', 55, 55)
    pointer('pointerup', 55, 55)
    key('Delete')
    await vi.waitFor(() => expect(harness.removed).toEqual(['r1']))
    await vi.waitFor(() => expect(tool.claimToolMode()).toBe('off'))
    tool.startClaimTool('rectangle')
    drag(0, 0, 2, 2)
    expect(tool.claimToolShape()).not.toBeNull()
    key('Backspace')
    await Promise.resolve()
    expect(tool.claimToolShape()).toBeNull()
    expect(harness.removed).toEqual(['r1'])
  })

  it('drags the inner handle of a star to change its inner radius', async () => {
    const tool = await setup('star')
    drag(100, 100, 100, 140)
    const inner = document.querySelector<HTMLElement>(
      '#caelestis-claim-handles [data-mode="inner"]',
    )
    expect(inner?.style.display).toBe('block')
    if (inner === null) throw new Error('inner handle missing')
    pointer('pointerdown', 100, 100, {}, inner)
    pointer('pointermove', 110, 100)
    pointer('pointerup', 110, 100)
    expect(tool.claimToolShape()).toMatchObject({ kind: 'star', r: 40, inner: 10 })
  })
})
