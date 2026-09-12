import type { TemplateSurface } from '@caelestis/shared'
import { describe, expect, it } from 'vitest'
import { nativeAlliancePlacements } from './native-alliance.js'

const hq: TemplateSurface = { kind: 'alliance-headquarters', allianceId: 7 }
const body = (locations: unknown[], overrides = {}) => ({
  templates: [
    {
      id: 42,
      name: 'Alliance art',
      width: 32,
      height: 32,
      updatedAt: 100,
      opacity: 75,
      colorMetric: 'lab',
      colorPaletteMode: 'all',
      dithering: false,
      locations,
      ...overrides,
    },
  ],
})
const placement = { target: 'headquarters', x: -64, y: 32, width: 32, height: 32, revision: 1 }

describe('native alliance template wrapper', () => {
  it('keeps signed headquarters placements and per-placement settings', () => {
    const rows = nativeAlliancePlacements(
      body([{ ...placement, opacity: 25, colorMetric: 'ciede2000' }]),
      { target: 'headquarters' },
      hq,
    )
    expect(rows).toMatchObject([
      { id: '42', originX: -64, originY: 32, opacity: 0.25, colorMetric: 'ciede2000' },
    ])
  })

  it('matches the exact picture/banner draft rather than another draft of the same alliance', () => {
    const rows = nativeAlliancePlacements(
      body([
        { ...placement, target: 'draft', draftId: 1, x: 0, y: 0 },
        { ...placement, target: 'draft', draftId: 2, x: 5, y: 6 },
      ]),
      { target: 'draft', draftId: 2 },
      { kind: 'alliance-picture', allianceId: 7 },
    )
    expect(rows).toMatchObject([{ originX: 5, originY: 6 }])
  })

  it('keeps unplaced and unrelated templates out of the active canvas', () => {
    expect(
      nativeAlliancePlacements(body([{ target: 'headquarters' }]), { target: 'headquarters' }, hq),
    ).toEqual([])
    expect(
      nativeAlliancePlacements(
        body([{ ...placement, target: 'main_canvas' }]),
        { target: 'headquarters' },
        hq,
      ),
    ).toEqual([])
  })

  it('changes the cache version when artwork or placement changes', () => {
    const read = (response: unknown) =>
      nativeAlliancePlacements(response, { target: 'headquarters' }, hq)[0]?.version
    const original = read(body([placement]))
    expect(read(body([{ ...placement, x: -50 }]))).not.toBe(original)
    expect(read(body([placement], { imageRevision: 'new' }))).not.toBe(original)
  })

  it('rejects malformed responses without interpreting them as an empty authoritative list', () => {
    expect(() => nativeAlliancePlacements({}, { target: 'headquarters' }, hq)).toThrow()
    expect(() =>
      nativeAlliancePlacements(body([{ ...placement, x: -1001 }]), { target: 'headquarters' }, hq),
    ).toThrow()
    expect(() =>
      nativeAlliancePlacements(
        body([placement], { width: 1000000 }),
        { target: 'headquarters' },
        hq,
      ),
    ).toThrow()
  })
})
