// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import type { ActiveAllianceSurface } from '../alliance-surface.js'
import {
  artboardGeometry,
  artboardPlacement,
  insertAllianceOverlayCanvas,
} from './artboard-layer.js'

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
})

describe('alliance artboard stacking', () => {
  it('inserts above HQ tiles and below Wplace overlay feedback', () => {
    const frame = document.createElement('div')
    const tiles = document.createElement('div')
    tiles.className = 'hq-tile-layer'
    const nativeOverlay = document.createElement('canvas')
    frame.append(tiles, nativeOverlay)
    const caelestis = document.createElement('canvas')

    insertAllianceOverlayCanvas(frame, caelestis)

    expect([...frame.children]).toEqual([tiles, caelestis, nativeOverlay])
  })

  it('keeps the asset art below and its native overlay above', () => {
    const frame = document.createElement('div')
    const art = document.createElement('canvas')
    const nativeOverlay = document.createElement('canvas')
    frame.append(art, nativeOverlay)
    const caelestis = document.createElement('canvas')

    insertAllianceOverlayCanvas(frame, caelestis)

    expect([...frame.children]).toEqual([art, caelestis, nativeOverlay])
  })
})
