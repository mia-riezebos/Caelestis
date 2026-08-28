import { describe, expect, it } from 'vitest'
import { OUTLINE_FRAGMENT_SOURCE } from './shaders.js'

describe('outline shader', () => {
  it('draws a palette-faded ring across full-cell boundaries', () => {
    expect(OUTLINE_FRAGMENT_SOURCE).toContain('for (int y = -1; y <= 1; y++)')
    expect(OUTLINE_FRAGMENT_SOURCE).toContain('outer - inner')
    expect(OUTLINE_FRAGMENT_SOURCE).toContain('* paletteAlpha')
  })
})
