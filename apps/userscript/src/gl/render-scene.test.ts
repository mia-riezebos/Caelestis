import { WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type Appearance,
  DEFAULT_APPEARANCE,
  PIXEL_STYLE_PRESETS,
} from '../templates/appearance.js'
import type { PlacedTemplate } from '../templates/local-store.js'

const fixture = vi.hoisted(() => ({
  appearance: null as Appearance | null,
  visible: true,
}))

vi.mock('../templates/appearance-preview.js', () => ({
  appearanceWithPreview: (_id: string, appearance: Appearance) => appearance,
  hasAppearancePreview: () => false,
}))
vi.mock('../templates/colour-filter.js', () => ({
  hiddenColoursFor: (appearance: Appearance) => appearance.hiddenColours,
}))
vi.mock('../templates/local-store.js', () => ({
  appearanceOf: () => fixture.appearance,
  isTemplateVisible: () => fixture.visible,
}))

import { RenderScene } from './render-scene.js'

const template: PlacedTemplate = {
  id: 'template',
  name: 'Template',
  source: 'image',
  originX: 0,
  originY: 0,
  width: 1,
  height: 1,
  indices: new Uint8Array([1]),
  moved: 0,
  opaque: 1,
  tiles: new Set(),
  visible: true,
  everPlaced: true,
  appearance: null,
  revision: 1,
  owns: [],
  folderId: null,
}

beforeEach(() => {
  fixture.appearance = { ...DEFAULT_APPEARANCE }
  fixture.visible = true
})

describe('shared render scene', () => {
  it.each([
    { kind: 'alliance-headquarters', allianceId: 535_245 },
    { kind: 'alliance-picture', allianceId: 535_245 },
    { kind: 'alliance-banner', allianceId: 535_245 },
  ] as const)('produces the world scene state for $kind', (surface) => {
    fixture.appearance = {
      ...DEFAULT_APPEARANCE,
      hiddenColours: [2],
      markMismatch: true,
      markSelectedColour: true,
    }
    const world = new RenderScene()
    const artboard = new RenderScene()
    for (const now of [0, 75, 150, 225, 300]) {
      const worldTemplates = world.advanceTemplates([template], WORLD_TEMPLATE_SURFACE, now, false)
      const artboardTemplates = artboard.advanceTemplates([template], surface, now, false)
      expect(artboardTemplates).toEqual(worldTemplates)
      expect(artboard.advanceMarkers(artboardTemplates.templates, 1, now)).toEqual(
        world.advanceMarkers(worldTemplates.templates, 1, now),
      )
    }
  })

  it('drives template visibility and colour filters through the same fade curve', () => {
    const scene = new RenderScene()

    expect(
      scene.advanceTemplates([template], WORLD_TEMPLATE_SURFACE, 0, false).templates[0]?.fade,
    ).toBe(0)
    const visible = scene.advanceTemplates([template], WORLD_TEMPLATE_SURFACE, 300, false)
    expect(visible.templates[0]?.fade).toBe(1)
    expect(visible.templates[0]?.palette?.[7]).toBe(255)

    fixture.appearance = { ...DEFAULT_APPEARANCE, hiddenColours: [1] }
    const leaving = scene.advanceTemplates([template], WORLD_TEMPLATE_SURFACE, 301, false)
    expect(leaving.animating).toBe(true)
    expect(leaving.templates[0]?.palette?.[7]).toBe(255)
    expect(
      scene.advanceTemplates([template], WORLD_TEMPLATE_SURFACE, 601, false).templates[0]
        ?.palette?.[7],
    ).toBe(0)
  })

  it('retargets pixel-style transitions from the value on screen', () => {
    const scene = new RenderScene()
    scene.advanceTemplates([template], WORLD_TEMPLATE_SURFACE, 0, false)
    scene.advanceTemplates([template], WORLD_TEMPLATE_SURFACE, 300, false)
    const full = PIXEL_STYLE_PRESETS.find(({ id }) => id === 'full')
    if (full === undefined) throw new Error('expected the full pixel preset')
    fixture.appearance = { ...DEFAULT_APPEARANCE, ...full.values }

    const start = scene.advanceTemplates([template], WORLD_TEMPLATE_SURFACE, 301, false)
    const middle = scene.advanceTemplates([template], WORLD_TEMPLATE_SURFACE, 451, false)
    const end = scene.advanceTemplates([template], WORLD_TEMPLATE_SURFACE, 601, false)

    expect(start.templates[0]?.appearance.size).toBe(DEFAULT_APPEARANCE.size)
    expect(middle.templates[0]?.appearance.size).toBeGreaterThan(DEFAULT_APPEARANCE.size)
    expect(middle.templates[0]?.appearance.size).toBeLessThan(full.values.size)
    expect(end.templates[0]?.appearance.size).toBe(full.values.size)
  })

  it('cross-fades selected-colour markers and keeps mismatch fades independent', () => {
    const scene = new RenderScene()
    fixture.appearance = {
      ...DEFAULT_APPEARANCE,
      markMismatch: true,
      markSelectedColour: true,
    }
    scene.advanceTemplates([template], WORLD_TEMPLATE_SURFACE, 0, false)
    const templates = scene.advanceTemplates([template], WORLD_TEMPLATE_SURFACE, 300, false)

    scene.advanceMarkers(templates.templates, 1, 300)
    const first = scene.advanceMarkers(templates.templates, 1, 600)
    expect(first.templates[0]?.mismatchFade).toBe(1)
    expect(first.templates[0]?.selectedFades).toEqual([{ index: 1, fade: 1 }])

    scene.advanceMarkers(templates.templates, 2, 600)
    const middle = scene.advanceMarkers(templates.templates, 2, 750)
    expect(middle.templates[0]?.selectedFades).toHaveLength(2)
    expect(middle.templates[0]?.selectedFades[0]?.fade).toBeCloseTo(0.5, 1)
    expect(middle.templates[0]?.selectedFades[1]?.fade).toBeCloseTo(0.5, 1)

    const end = scene.advanceMarkers(templates.templates, 2, 900)
    expect(end.templates[0]?.selectedFades).toEqual([{ index: 2, fade: 1 }])
  })
})
