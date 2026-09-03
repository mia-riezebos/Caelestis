import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  active: {
    surface: { kind: 'alliance-headquarters', allianceId: 535_245 },
  },
  template: {
    id: 'local',
    name: 'Local',
    source: 'image',
    everPlaced: true,
    originX: -10,
    originY: -20,
    width: 4,
    height: 6,
    surface: { kind: 'alliance-headquarters', allianceId: 535_245 },
  },
  preview: null as { x: number; y: number } | null,
  navigateAlliance: vi.fn(() => true),
  navigateWorld: vi.fn(),
}))

vi.mock('../alliance-navigation.js', () => ({
  navigateAllianceArtboardTo: harness.navigateAlliance,
}))
vi.mock('../alliance-surface.js', () => ({
  activeAllianceSurface: () => harness.active,
}))
vi.mock('../templates/local-store.js', () => ({
  previewOriginFor: () => harness.preview,
  templateById: () => harness.template,
}))
vi.mock('../templates/navigate.js', () => ({
  centreOf: vi.fn(() => ({ x: 1, y: 2 })),
  centreOfBounds: vi.fn(() => ({ x: 3, y: 4 })),
  navigateTo: harness.navigateWorld,
}))
vi.mock('../ui/toast.js', () => ({ toast: vi.fn() }))

import { goToLocalTemplate, goToServerTemplate } from './tree-navigation.js'

beforeEach(() => {
  vi.clearAllMocks()
  harness.preview = null
})

describe('surface-aware tree navigation', () => {
  it('centres a local alliance template through the active artboard', () => {
    goToLocalTemplate('local')

    expect(harness.navigateAlliance).toHaveBeenCalledWith(harness.active, { x: -8, y: -17 })
    expect(harness.navigateWorld).not.toHaveBeenCalled()
  })

  it('uses the live placement origin while an alliance template is moving', () => {
    harness.preview = { x: 10, y: 20 }

    goToLocalTemplate('local')

    expect(harness.navigateAlliance).toHaveBeenCalledWith(harness.active, { x: 12, y: 23 })
  })

  it('centres an alliance manifest row without interpreting it as world coordinates', () => {
    goToServerTemplate(
      { minX: -100, minY: -50, maxX: -80, maxY: -30 },
      { kind: 'alliance-headquarters', allianceId: 535_245 },
    )

    expect(harness.navigateAlliance).toHaveBeenCalledWith(harness.active, { x: -90, y: -40 })
    expect(harness.navigateWorld).not.toHaveBeenCalled()
  })
})
