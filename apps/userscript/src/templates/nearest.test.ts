import { TRANSPARENT_INDEX } from '@caelestis/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  centre: { x: 10, y: 10 } as { x: number; y: number } | null,
  hiddenColours: {} as Record<string, readonly number[]>,
  templates: [] as Array<{
    id: string
    originX: number
    originY: number
    width: number
    height: number
    visible: boolean
    indices: Uint8Array
    surface?: {
      kind: 'alliance-headquarters' | 'alliance-picture' | 'alliance-banner'
      allianceId: number
    }
  }>,
  alliance: null as null | {
    surface: { kind: 'alliance-headquarters'; allianceId: number }
    stage: { getBoundingClientRect: () => Partial<DOMRect> }
    frame: { getBoundingClientRect: () => Partial<DOMRect> }
    draftId: null
    bounds: { minX: number; minY: number; maxX: number; maxY: number }
  },
}))

vi.mock('../alliance-surface.js', () => ({ activeAllianceSurface: () => harness.alliance }))
vi.mock('../main.js', () => ({ viewportCentre: () => harness.centre }))
vi.mock('./colour-filter.js', () => ({
  claimedHiddenFor: (appearance: { templateId: string }) =>
    harness.hiddenColours[appearance.templateId] ?? [],
}))
vi.mock('./local-store.js', () => ({
  appearanceOf: (candidate: { id: string }) => ({ templateId: candidate.id }),
  displayTemplatesForSurface: (surface: { kind: string; allianceId: number | null }) =>
    harness.templates.filter((template) => {
      const candidate = template.surface ?? { kind: 'world', allianceId: null }
      return candidate.kind === surface.kind && candidate.allianceId === surface.allianceId
    }),
  isTemplateVisible: vi.fn((template: { visible: boolean }) => template.visible),
}))

const template = (id: string, originX: number, originY: number, width: number, height: number) => ({
  id,
  originX,
  originY,
  width,
  height,
  visible: true,
  indices: new Uint8Array(width * height),
})

beforeEach(() => {
  harness.centre = { x: 10, y: 10 }
  harness.hiddenColours = {}
  harness.templates = []
  harness.alliance = null
  return import('./local-store.js').then(({ isTemplateVisible }) => {
    vi.mocked(isTemplateVisible).mockImplementation((candidate) => candidate.visible)
  })
})

describe('template focus at the viewport centre', () => {
  it('uses the active alliance viewport and excludes world templates behind its modal', async () => {
    harness.alliance = {
      surface: { kind: 'alliance-headquarters', allianceId: 535_245 },
      stage: {
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 100 }),
      },
      frame: {
        getBoundingClientRect: () => ({
          left: -50,
          top: -50,
          right: 150,
          bottom: 150,
          width: 200,
          height: 200,
        }),
      },
      draftId: null,
      bounds: { minX: -100, minY: -100, maxX: 100, maxY: 100 },
    }
    harness.templates = [
      template('world-behind', 5, 5, 10, 10),
      {
        ...template('alliance', -5, -5, 10, 10),
        surface: { kind: 'alliance-headquarters', allianceId: 535_245 },
      },
    ]
    const { focusedTemplate } = await import('./nearest.js')

    expect(focusedTemplate()?.id).toBe('alliance')
  })

  it('prefers a large template containing the viewport centre over a nearer template centre', async () => {
    harness.templates = [
      template('large-containing', 0, 0, 1_000, 1_000),
      template('small-nearby', 20, 5, 10, 10),
    ]
    const { focusedTemplate } = await import('./nearest.js')

    expect(focusedTemplate()?.id).toBe('large-containing')
  })

  it('chooses the topmost template when multiple visible templates contain the centre', async () => {
    harness.templates = [template('underneath', 0, 0, 20, 20), template('on-top', 5, 5, 20, 20)]
    const { focusedTemplate } = await import('./nearest.js')

    expect(focusedTemplate()?.id).toBe('on-top')
  })

  it('lets an opaque lower template show through a transparent top template cell', async () => {
    const underneath = template('underneath', 0, 0, 20, 20)
    const onTop = template('transparent-on-top', 5, 5, 20, 20)
    onTop.indices[5 * onTop.width + 5] = TRANSPARENT_INDEX
    harness.templates = [underneath, onTop]
    const { focusedTemplate } = await import('./nearest.js')

    expect(focusedTemplate()?.id).toBe('underneath')
  })

  it('lets a lower template show through a manually hidden top-template colour', async () => {
    const underneath = template('underneath', 0, 0, 20, 20)
    const onTop = template('hidden-colour-on-top', 5, 5, 20, 20)
    harness.hiddenColours[onTop.id] = [0]
    harness.templates = [underneath, onTop]
    const { focusedTemplate } = await import('./nearest.js')

    expect(focusedTemplate()?.id).toBe('underneath')
  })

  it('falls back to nearest-centre distance when the viewport centre is in empty space', async () => {
    harness.templates = [template('farther', 100, 100, 10, 10), template('nearer', 20, 20, 10, 10)]
    const { focusedTemplate } = await import('./nearest.js')

    expect(focusedTemplate()?.id).toBe('nearer')
  })
})

describe('hidden-template restoration', () => {
  it('does not expose a hidden template to ordinary template-local actions', async () => {
    harness.templates = [{ ...template('hidden-containing', 0, 0, 20, 20), visible: false }]
    const { focusedTemplate } = await import('./nearest.js')

    expect(focusedTemplate()).toBeNull()
  })

  it('lets a containing visible template outrank the hidden restoration candidate', async () => {
    harness.templates = [
      { ...template('visible-under', 0, 0, 20, 20), visible: true },
      { ...template('hidden-on-top', 5, 5, 20, 20), visible: false },
    ]
    const { focusedTemplate } = await import('./nearest.js')

    expect(focusedTemplate({ restoreHiddenAtCentre: true })?.id).toBe('visible-under')
  })

  it('keeps the topmost-in-draw-order rule within the hidden tier', async () => {
    harness.templates = [
      { ...template('hidden-under', 0, 0, 20, 20), visible: false },
      { ...template('hidden-on-top', 5, 5, 20, 20), visible: false },
    ]
    const { focusedTemplate } = await import('./nearest.js')

    expect(focusedTemplate({ restoreHiddenAtCentre: true })?.id).toBe('hidden-on-top')
  })

  it('never reaches a hidden template through nearest-centre fallback', async () => {
    harness.templates = [{ ...template('hidden-nearby', 20, 20, 10, 10), visible: false }]
    const { focusedTemplate } = await import('./nearest.js')

    expect(focusedTemplate({ restoreHiddenAtCentre: true })).toBeNull()
  })

  it('does not pretend an own-visible template hidden by an ancestor can be restored locally', async () => {
    harness.templates = [{ ...template('ancestor-hidden', 0, 0, 20, 20), visible: true }]
    const { focusedTemplate } = await import('./nearest.js')
    const { isTemplateVisible } = await import('./local-store.js')
    vi.mocked(isTemplateVisible).mockReturnValue(false)

    expect(focusedTemplate({ restoreHiddenAtCentre: true })).toBeNull()
  })
})
