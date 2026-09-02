import type { TemplateSurface } from '@caelestis/shared'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_APPEARANCE, drawableIndices } from './appearance.js'

const harness = vi.hoisted(() => ({
  selected: 7,
  paintOpen: true,
  onlySelected: (surface: TemplateSurface) => surface.kind === 'alliance-headquarters',
}))

vi.mock('../state.js', () => ({
  getState: () => ({ hiddenColours: [4] }),
  onlySelectedColourFor: harness.onlySelected,
}))
vi.mock('../wplace-paint.js', () => ({
  isPaintOpen: () => harness.paintOpen,
  selectedColour: () => harness.selected,
}))

import { hiddenColoursFor } from './colour-filter.js'

describe('surface-scoped selected-colour filtering', () => {
  it('filters only the active alliance canvas preference', () => {
    const own = { ...DEFAULT_APPEARANCE, hiddenColours: [4] }
    const headquarters = { kind: 'alliance-headquarters', allianceId: 535_245 } as const
    const picture = { kind: 'alliance-picture', allianceId: 535_245 } as const

    expect(hiddenColoursFor(own, headquarters)).toEqual(
      drawableIndices().filter((index) => index !== harness.selected),
    )
    expect(hiddenColoursFor(own, picture)).toEqual([4])
    expect(hiddenColoursFor(own)).toEqual([4])
  })
})
