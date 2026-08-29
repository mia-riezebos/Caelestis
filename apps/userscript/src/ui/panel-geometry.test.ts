import { describe, expect, it } from 'vitest'
import { panelWidthAfterMount } from './panel-geometry.js'

describe('panel geometry', () => {
  it('keeps the configured width while a freshly connected custom element still measures zero', () => {
    expect(panelWidthAfterMount(0, 320)).toBe(320)
  })

  it('keeps an established live resize measurement', () => {
    expect(panelWidthAfterMount(376, 320)).toBe(376)
  })
})
