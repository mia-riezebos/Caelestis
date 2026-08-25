import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_APPEARANCE } from './appearance.js'
import {
  appearanceWithPreview,
  clearAppearancePreview,
  hasAppearancePreview,
  setAppearancePreview,
} from './appearance-preview.js'

const ID = 'template-a'

afterEach(() => clearAppearancePreview(ID))

describe('appearance previews', () => {
  it('overlays live values without changing the durable appearance', () => {
    setAppearancePreview(ID, 'size', 0.7)

    expect(appearanceWithPreview(ID, DEFAULT_APPEARANCE).size).toBe(0.7)
    expect(DEFAULT_APPEARANCE.size).not.toBe(0.7)
    expect(hasAppearancePreview(ID)).toBe(true)
  })

  it('does not let an older write clear a newer preview', () => {
    setAppearancePreview(ID, 'size', 0.7)
    setAppearancePreview(ID, 'size', 0.8)

    clearAppearancePreview(ID, 'size', 0.7)

    expect(appearanceWithPreview(ID, DEFAULT_APPEARANCE).size).toBe(0.8)
  })
})
