import { describe, expect, it } from 'vitest'
import { OUTLINE_FRAGMENT_SOURCE } from './shaders.js'

describe('outline shader', () => {
  it('draws a palette-faded ring across full-cell boundaries', () => {
    expect(OUTLINE_FRAGMENT_SOURCE).toContain('for (int y = -1; y <= 1; y++)')
    expect(OUTLINE_FRAGMENT_SOURCE).toContain('outer - inner')
    expect(OUTLINE_FRAGMENT_SOURCE).toContain('* paletteAlpha')
  })

  it('measures ring width in canvas pixels while keeping antialiasing device-pixel stable', () => {
    expect(OUTLINE_FRAGMENT_SOURCE).toContain('float expansion = u_outlineWidth;')
    expect(OUTLINE_FRAGMENT_SOURCE).not.toContain('pixel * u_outlineWidth')
    expect(OUTLINE_FRAGMENT_SOURCE).toContain('expansion - pixel * 0.5')
  })
})
