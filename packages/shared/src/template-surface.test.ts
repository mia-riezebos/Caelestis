import { describe, expect, it } from 'vitest'
import {
  sameTemplateSurface,
  templateSurface,
  templateSurfaceBounds,
  templateSurfaceKey,
  WORLD_TEMPLATE_SURFACE,
} from './template-surface.js'

describe('template surfaces', () => {
  it('requires a positive alliance id only on alliance surfaces', () => {
    expect(templateSurface('world', null)).toBe(WORLD_TEMPLATE_SURFACE)
    expect(templateSurface('world', 1)).toBeNull()
    expect(templateSurface('alliance-headquarters', 535_245)).toEqual({
      kind: 'alliance-headquarters',
      allianceId: 535_245,
    })
    expect(templateSurface('alliance-picture', 0)).toBeNull()
    expect(templateSurface('alliance-banner', 1.5)).toBeNull()
    expect(templateSurface('unknown', null)).toBeNull()
  })

  it('keeps HQ centred and assets zero-based', () => {
    expect(templateSurfaceBounds({ kind: 'alliance-headquarters', allianceId: 1 })).toEqual({
      minX: -1_000,
      minY: -1_000,
      maxX: 1_000,
      maxY: 1_000,
    })
    expect(templateSurfaceBounds({ kind: 'alliance-picture', allianceId: 1 })).toEqual({
      minX: 0,
      minY: 0,
      maxX: 64,
      maxY: 64,
    })
    expect(templateSurfaceBounds({ kind: 'alliance-banner', allianceId: 1 })).toEqual({
      minX: 0,
      minY: 0,
      maxX: 384,
      maxY: 128,
    })
  })

  it('uses the kind and alliance together as scope identity', () => {
    const hq = { kind: 'alliance-headquarters', allianceId: 7 } as const
    expect(sameTemplateSurface(hq, { ...hq })).toBe(true)
    expect(sameTemplateSurface(hq, { kind: 'alliance-headquarters', allianceId: 8 })).toBe(false)
    expect(templateSurfaceKey(WORLD_TEMPLATE_SURFACE)).toBe('world')
    expect(templateSurfaceKey(hq)).toBe('alliance-headquarters:7')
  })
})
