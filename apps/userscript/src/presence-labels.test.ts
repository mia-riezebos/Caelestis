// @vitest-environment happy-dom

import { regionDocumentPixels, TILE_SIZE } from '@caelestis/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TileFrame } from './tile-transform.js'

const harness = vi.hoisted(() => ({
  peers: [] as unknown[],
  regions: [] as unknown[],
  showPresence: true,
  flags: {} as Record<string, boolean>,
  displayed: new Map<string, { x: number; y: number; w: number; h: number }>(),
}))

vi.mock('./presence-client.js', () => ({
  presenceView: () => ({
    peers: harness.peers,
    regions: harness.regions,
    online: 0,
    connected: true,
    me: null,
  }),
}))
vi.mock('./claim-editor.js', () => ({ claimEditorEditingIds: () => [] }))
vi.mock('./gl/presence-layer.js', () => ({
  displayedPresenceRect: (key: string) => harness.displayed.get(key) ?? null,
  regionPixelsFor: (_id: string, document: Parameters<typeof regionDocumentPixels>[0]) =>
    regionDocumentPixels(document),
}))
vi.mock('./state.js', () => ({
  getState: () => ({ showPresence: harness.showPresence, ...harness.flags }),
}))
vi.mock('./tile-transform.js', () => ({ isDrawingTiles: () => true }))

const rect = (x: number, y: number, w: number, h: number) => ({
  kind: 'rectangle' as const,
  x,
  y,
  w,
  h,
})

/** A claim of two pieces: one at x 0..10 and one at x 60..70, both 10 tall. */
const twoPieces = {
  id: 'r1',
  season: 3,
  surface: { kind: 'world', allianceId: null },
  templateId: null,
  claimant: { wplaceUserId: 9, displayName: 'Sam' },
  document: {
    items: [
      { id: 'a', op: 'add', shape: rect(0, 0, 10, 10) },
      { id: 'b', op: 'add', shape: rect(60, 0, 10, 10) },
    ],
  },
  rect: { x: 0, y: 0, w: 70, h: 10 },
  label: '',
  createdAt: 1,
}

/** Tile 0/0 drawn at the canvas origin at `scale` device pixels per canvas pixel. */
const frameAt = (scale: number, canvas?: HTMLCanvasElement): TileFrame => ({
  canvas: canvas ?? ({ width: 800, height: 600 } as HTMLCanvasElement),
  quads: [
    { tile: { x: 0, y: 0 }, x: 0, y: 0, width: TILE_SIZE * scale, height: TILE_SIZE * scale },
  ],
})

const tagsAt = async (frame: TileFrame, x: number, y: number) => {
  const { presenceTagsAt } = await import('./presence-labels.js')
  return presenceTagsAt(frame, { x, y }, () => 100, 1)
}

beforeEach(() => {
  harness.peers = []
  harness.regions = []
  harness.showPresence = true
  harness.flags = {}
  harness.displayed = new Map()
})

afterEach(async () => {
  const { resetPresenceLabels } = await import('./presence-labels.js')
  const { resetPresenceHover } = await import('./presence-hover.js')
  resetPresenceLabels()
  resetPresenceHover()
  document.body.innerHTML = ''
  vi.resetModules()
})

describe('presence tags', () => {
  it('tags the hovered piece of a claim and nothing when the pointer is in the gap', async () => {
    harness.regions = [twoPieces]
    // At 4 px per canvas px the two tags, 100 px wide, are 240 px apart: each piece has its own.
    expect(await tagsAt(frameAt(4), 5, 5)).toEqual([
      expect.objectContaining({
        key: 'region:r1',
        text: 'Sam · claimed',
        rect: { x: 0, y: 0, w: 10, h: 10 },
      }),
    ])
    expect(await tagsAt(frameAt(4), 65, 5)).toEqual([
      expect.objectContaining({ rect: { x: 60, y: 0, w: 10, h: 10 } }),
    ])
    expect(await tagsAt(frameAt(4), 30, 5)).toEqual([])
    expect(await tagsAt(frameAt(4), 5, 20)).toEqual([])
  })

  it('merges the tags of pieces whose tags would collide, until zoomed in enough', async () => {
    harness.regions = [twoPieces]
    // At 1 px per canvas px the tag centres are 60 px apart and the tags 100 px wide: one tag.
    expect(await tagsAt(frameAt(1), 5, 5)).toEqual([
      expect.objectContaining({ rect: { x: 0, y: 0, w: 70, h: 10 } }),
    ])
    expect(await tagsAt(frameAt(1), 65, 5)).toEqual([
      expect.objectContaining({ rect: { x: 0, y: 0, w: 70, h: 10 } }),
    ])
    expect(await tagsAt(frameAt(4), 65, 5)).toEqual([
      expect.objectContaining({ rect: { x: 60, y: 0, w: 10, h: 10 } }),
    ])
  })

  it('merges a piece into the piece above it when its tag would land on that piece', async () => {
    // A big piece on top and a small one just under it: the small one's tag would sit on the big.
    harness.regions = [
      {
        ...twoPieces,
        rect: { x: 0, y: 0, w: 40, h: 35 },
        document: {
          items: [
            { id: 'a', op: 'add', shape: rect(0, 0, 40, 20) },
            { id: 'b', op: 'add', shape: rect(10, 30, 10, 5) },
          ],
        },
      },
    ]
    // At 1 px per canvas px the 21 px tall tag above y 30 covers the big piece: one tag, on top.
    expect(await tagsAt(frameAt(1), 15, 32)).toEqual([
      expect.objectContaining({ rect: { x: 0, y: 0, w: 40, h: 35 } }),
    ])
    expect(await tagsAt(frameAt(1), 5, 5)).toEqual([
      expect.objectContaining({ rect: { x: 0, y: 0, w: 40, h: 35 } }),
    ])
    // At 8 px per canvas px the gap is 80 px tall: the small piece has its own tag again.
    expect(await tagsAt(frameAt(8), 15, 32)).toEqual([
      expect.objectContaining({ rect: { x: 10, y: 30, w: 10, h: 5 } }),
    ])
    expect(await tagsAt(frameAt(8), 5, 5)).toEqual([
      expect.objectContaining({ rect: { x: 0, y: 0, w: 40, h: 20 } }),
    ])
  })

  it('grows a cluster until its tag lands on no further piece', async () => {
    // Three pieces stacked: the bottom one's tag hits the middle, the merged tag hits the top.
    harness.regions = [
      {
        ...twoPieces,
        rect: { x: 0, y: 0, w: 40, h: 65 },
        document: {
          items: [
            { id: 'a', op: 'add', shape: rect(0, 0, 40, 10) },
            { id: 'b', op: 'add', shape: rect(0, 25, 40, 10) },
            { id: 'c', op: 'add', shape: rect(0, 50, 40, 15) },
          ],
        },
      },
    ]
    expect(await tagsAt(frameAt(1), 5, 55)).toEqual([
      expect.objectContaining({ rect: { x: 0, y: 0, w: 40, h: 65 } }),
    ])
  })

  it('tags a hovered viewport where it is drawn, and a draft over its viewport', async () => {
    harness.peers = [
      {
        sessionId: 'a',
        painter: { wplaceUserId: 3, displayName: 'Kim' },
        viewport: { x: 100, y: 100, w: 200, h: 100 },
        draft: null,
      },
      {
        sessionId: 'b',
        painter: { wplaceUserId: 4, displayName: 'Lee' },
        viewport: { x: 400, y: 100, w: 200, h: 100 },
        draft: { rect: { x: 450, y: 120, w: 10, h: 10 }, pixels: 4 },
      },
    ]
    // Kim's viewport is mid-glide: the drawn rect, not the published one, is what is hovered.
    harness.displayed.set('peer:a:viewport', { x: 150, y: 100, w: 200, h: 100 })
    expect(await tagsAt(frameAt(1), 120, 150)).toEqual([])
    expect(await tagsAt(frameAt(1), 320, 150)).toEqual([
      expect.objectContaining({
        key: 'peer:a:viewport',
        text: 'Kim',
        rect: { x: 150, y: 100, w: 200, h: 100 },
      }),
    ])
    expect(await tagsAt(frameAt(1), 455, 125)).toEqual([
      expect.objectContaining({
        key: 'peer:b:draft',
        text: 'Lee · painting 4 px',
        rect: { x: 450, y: 120, w: 10, h: 10 },
      }),
    ])
    expect(await tagsAt(frameAt(1), 410, 110)).toEqual([
      expect.objectContaining({ key: 'peer:b:viewport', text: 'Lee · painting 4 px' }),
    ])
  })
})

describe('renderPresenceLabels', () => {
  const canvasAt = (): HTMLCanvasElement => {
    const canvas = document.createElement('canvas')
    canvas.className = 'maplibregl-canvas'
    canvas.width = 800
    canvas.height = 600
    canvas.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }) as DOMRect
    document.body.appendChild(canvas)
    return canvas
  }

  const hover = (canvas: HTMLCanvasElement, x: number, y: number): void => {
    canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true }))
  }

  it('shows a chip above the hovered claim only while the pointer is on it', async () => {
    harness.regions = [
      {
        ...twoPieces,
        rect: { x: 100, y: 100, w: 40, h: 20 },
        document: { items: [{ id: 'a', op: 'add', shape: rect(100, 100, 40, 20) }] },
      },
    ]
    const { renderPresenceLabels } = await import('./presence-labels.js')
    const canvas = canvasAt()
    const frame = frameAt(1, canvas)
    renderPresenceLabels(frame)
    expect(document.querySelectorAll('#caelestis-presence-labels span')).toHaveLength(0)
    hover(canvas, 120, 110)
    renderPresenceLabels(frame)
    const chip = document.querySelector<HTMLElement>('#caelestis-presence-labels span')
    expect(chip?.textContent).toBe('Sam · claimed')
    // Centred over the 40 px wide claim, sitting above its top edge at y 100.
    const match = /translate\((-?\d+)px, (-?\d+)px\)/.exec(chip?.style.transform ?? '')
    expect(match).not.toBeNull()
    const [, x, y] = match as RegExpExecArray
    expect(Number(y)).toBeLessThan(100)
    expect(Number(y)).toBeGreaterThan(100 - 30)
    expect(Number(x)).toBeLessThan(120)
    expect(Number(x) + 40).toBeGreaterThan(100)
    hover(canvas, 300, 300)
    renderPresenceLabels(frame)
    expect(document.querySelectorAll('#caelestis-presence-labels span')).toHaveLength(0)
  })

  it("climbs off another painter's claim instead of covering it", async () => {
    harness.regions = [
      {
        ...twoPieces,
        id: 'mine',
        rect: { x: 100, y: 130, w: 40, h: 10 },
        document: { items: [{ id: 'a', op: 'add', shape: rect(100, 130, 40, 10) }] },
      },
      {
        ...twoPieces,
        id: 'theirs',
        claimant: { wplaceUserId: 2, displayName: 'Ada' },
        rect: { x: 90, y: 100, w: 60, h: 20 },
        document: { items: [{ id: 'a', op: 'add', shape: rect(90, 100, 60, 20) }] },
      },
    ]
    const { renderPresenceLabels } = await import('./presence-labels.js')
    const canvas = canvasAt()
    const frame = frameAt(1, canvas)
    renderPresenceLabels(frame)
    hover(canvas, 120, 135)
    renderPresenceLabels(frame)
    const chips = [...document.querySelectorAll<HTMLElement>('#caelestis-presence-labels span')]
    expect(chips.map((chip) => chip.textContent)).toEqual(['Sam · claimed'])
    const match = /translate\((-?\d+)px, (-?\d+)px\)/.exec(chips[0]?.style.transform ?? '')
    const y = Number((match as RegExpExecArray)[2])
    // Not in the 21 px band above y 130, which Ada's claim (y 100..120) occupies; above hers instead.
    expect(y + 17).toBeLessThanOrEqual(100)
  })

  it('publishes which of the claims the pointer is over, for the layer to fade', async () => {
    harness.regions = [twoPieces]
    const { renderPresenceLabels } = await import('./presence-labels.js')
    const { hoveredPresenceRegions } = await import('./presence-hover.js')
    const canvas = canvasAt()
    const frame = frameAt(1, canvas)
    renderPresenceLabels(frame)
    hover(canvas, 5, 5)
    renderPresenceLabels(frame)
    expect([...hoveredPresenceRegions()]).toEqual(['r1'])
    hover(canvas, 300, 300)
    renderPresenceLabels(frame)
    expect(hoveredPresenceRegions().size).toBe(0)
  })

  it('leaves out viewports or claims when their own switch is off', async () => {
    harness.regions = [twoPieces]
    harness.peers = [
      {
        sessionId: 'a',
        painter: { wplaceUserId: 3, displayName: 'Kim' },
        viewport: { x: 0, y: 0, w: 100, h: 100 },
        draft: null,
      },
    ]
    harness.flags = { showPresenceClaims: false }
    expect((await tagsAt(frameAt(4), 5, 5)).map((tag) => tag.key)).toEqual(['peer:a:viewport'])
    harness.flags = { showPresenceViewports: false }
    expect((await tagsAt(frameAt(4), 5, 5)).map((tag) => tag.key)).toEqual(['region:r1'])
  })

  it('rechecks other claims after the top-edge clamp moves a chip', async () => {
    // Mine sits at the very top; its chip has to drop inside the map, where Ada's claim is.
    harness.regions = [
      {
        ...twoPieces,
        id: 'mine',
        rect: { x: 100, y: 0, w: 40, h: 4 },
        document: { items: [{ id: 'a', op: 'add', shape: rect(100, 0, 40, 4) }] },
      },
      {
        ...twoPieces,
        id: 'theirs',
        claimant: { wplaceUserId: 2, displayName: 'Ada' },
        rect: { x: 90, y: 4, w: 60, h: 40 },
        document: { items: [{ id: 'a', op: 'add', shape: rect(90, 4, 60, 40) }] },
      },
    ]
    const { renderPresenceLabels } = await import('./presence-labels.js')
    const canvas = canvasAt()
    const frame = frameAt(1, canvas)
    renderPresenceLabels(frame)
    hover(canvas, 120, 2)
    renderPresenceLabels(frame)
    const chip = document.querySelector<HTMLElement>('#caelestis-presence-labels span')
    const match = /translate\((-?\d+)px, (-?\d+)px\)/.exec(chip?.style.transform ?? '')
    const y = Number((match as RegExpExecArray)[2])
    // Not over Ada's claim (y 4..44): the clamp put it inside, and the recheck moved it clear.
    expect(y + 17 <= 4 || y >= 44).toBe(true)
  })

  it('hides every chip while other painters are hidden', async () => {
    harness.regions = [twoPieces]
    harness.showPresence = false
    const { renderPresenceLabels } = await import('./presence-labels.js')
    const canvas = canvasAt()
    renderPresenceLabels(frameAt(1, canvas))
    hover(canvas, 5, 5)
    renderPresenceLabels(frameAt(1, canvas))
    expect(document.querySelectorAll('#caelestis-presence-labels span')).toHaveLength(0)
  })
})
