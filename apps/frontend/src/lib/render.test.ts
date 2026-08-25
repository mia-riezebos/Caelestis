// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { osmTileDrawRect } from './render.js'

describe('OpenStreetMap tile placement', () => {
  it('overdraws adjacent tiles by one device pixel so filtering cannot expose their edges', () => {
    const span = 625
    for (const deviceScale of [0.4, 1.75]) {
      const left = osmTileDrawRect(11, 7, span, deviceScale)
      const right = osmTileDrawRect(12, 7, span, deviceScale)
      const below = osmTileDrawRect(11, 8, span, deviceScale)

      expect((left.x + left.width - right.x) * deviceScale).toBeCloseTo(1)
      expect((left.y + left.height - below.y) * deviceScale).toBeCloseTo(1)
    }
  })
})
