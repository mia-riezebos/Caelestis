// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActiveAllianceSurface } from '../alliance-surface.js'

const controls = vi.hoisted(() => ({ detach: vi.fn(), render: vi.fn() }))

vi.mock('../ui/overlay-menu.js', () => ({
  detachOverlayControls: controls.detach,
  renderAllianceOverlayControls: controls.render,
}))

import {
  type ArtboardViewport,
  artboardDevicePlacement,
  artboardGeometry,
  artboardPlacement,
  insertAllianceArtboardCanvases,
  reconcileAllianceControlsForViewport,
} from './artboard-layer.js'

beforeEach(() => vi.clearAllMocks())

const active = (
  kind: ActiveAllianceSurface['surface']['kind'],
  bounds: ActiveAllianceSurface['bounds'],
): ActiveAllianceSurface => {
  const stage = document.createElement('div')
  const frame = document.createElement('div')
  return {
    surface: { kind, allianceId: 535_245 },
    stage,
    frame,
    draftId: kind === 'alliance-headquarters' ? null : 129,
    bounds,
  }
}

describe('alliance artboard projection', () => {
  it('projects signed HQ coordinates relative to the current centred bounds', () => {
    const small = artboardGeometry(
      active('alliance-headquarters', { minX: -125, minY: -125, maxX: 125, maxY: 125 }),
    )
    const upgraded = artboardGeometry(
      active('alliance-headquarters', { minX: -250, minY: -250, maxX: 250, maxY: 250 }),
    )
    if (small === null || upgraded === null) throw new Error('expected HQ geometry')
    const template = { originX: -100, originY: -50, width: 20, height: 10 }

    expect(artboardPlacement(template, small)).toEqual({
      left: 25,
      top: 75,
      right: 45,
      bottom: 85,
    })
    expect(artboardPlacement(template, upgraded)).toEqual({
      left: 150,
      top: 200,
      right: 170,
      bottom: 210,
    })
  })

  it.each([
    ['alliance-picture', 64, 64],
    ['alliance-banner', 384, 128],
  ] as const)('uses the fixed %s dimensions', (kind, width, height) => {
    expect(artboardGeometry(active(kind, null))).toEqual({
      originX: 0,
      originY: 0,
      width,
      height,
    })
  })

  it('projects source pixels at the live artboard zoom instead of scaling a fixed LOD bitmap', () => {
    expect(
      artboardDevicePlacement(
        { originX: -100, originY: -50, width: 20, height: 10 },
        { originX: -1_000, originY: -1_000, width: 2_000, height: 2_000 },
        {
          bufferWidth: 2_400,
          bufferHeight: 1_600,
          frameLeft: -300,
          frameTop: -200,
          frameWidth: 8_000,
          frameHeight: 8_000,
        },
      ),
    ).toEqual({ left: 3_300, top: 3_600, right: 3_380, bottom: 3_640 })
  })
})

describe('alliance artboard stacking', () => {
  it('inserts above HQ tiles and below Wplace overlay feedback', () => {
    const frame = document.createElement('div')
    const tiles = document.createElement('div')
    tiles.className = 'hq-tile-layer'
    const nativeOverlay = document.createElement('canvas')
    frame.append(tiles, nativeOverlay)
    const outline = document.createElement('canvas')
    outline.setAttribute('data-caelestis-alliance-outline', '')
    const overlay = document.createElement('canvas')
    overlay.setAttribute('data-caelestis-alliance-overlay', '')

    insertAllianceArtboardCanvases(frame, outline, overlay)

    expect([...frame.children]).toEqual([outline, tiles, overlay, nativeOverlay])
    expect(outline.style.imageRendering).toBe('pixelated')
    expect(overlay.style.imageRendering).toBe('pixelated')
  })

  it('keeps the asset art below and its native overlay above', () => {
    const frame = document.createElement('div')
    const art = document.createElement('canvas')
    const nativeOverlay = document.createElement('canvas')
    frame.append(art, nativeOverlay)
    const outline = document.createElement('canvas')
    outline.setAttribute('data-caelestis-alliance-outline', '')
    const overlay = document.createElement('canvas')
    overlay.setAttribute('data-caelestis-alliance-overlay', '')

    insertAllianceArtboardCanvases(frame, outline, overlay)

    expect([...frame.children]).toEqual([outline, art, overlay, nativeOverlay])
    expect(outline.style.imageRendering).toBe('pixelated')
    expect(overlay.style.imageRendering).toBe('pixelated')
  })
})

describe('alliance artboard control lifecycle', () => {
  it('removes fixed controls when a visible artboard collapses to zero size', () => {
    const control = document.createElement('button')
    controls.detach.mockImplementation(() => control.remove())
    const viewport: ArtboardViewport = {
      bufferWidth: 250,
      bufferHeight: 250,
      frameLeft: 0,
      frameTop: 0,
      frameWidth: 250,
      frameHeight: 250,
    }

    expect(
      reconcileAllianceControlsForViewport(viewport, () => document.body.append(control)),
    ).toBe(true)
    expect(control.isConnected).toBe(true)

    expect(reconcileAllianceControlsForViewport(null, vi.fn())).toBe(false)
    expect(controls.detach).toHaveBeenCalledOnce()
    expect(control.isConnected).toBe(false)
  })
})
