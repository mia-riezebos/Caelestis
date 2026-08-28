// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import {
  DARK_THEME_LUMA_MAX,
  isDarkMapTheme,
  LIGHT_THEME_LUMA_MIN,
  needsContrastOutline,
  srgbLuma,
} from './contrast-outline.js'

describe('contrast outline', () => {
  it('outlines dark colours only on the dark map', () => {
    expect(needsContrastOutline([0, 0, 0], true)).toBe(true)
    expect(needsContrastOutline([0, 0, 0], false)).toBe(false)
    expect(needsContrastOutline([255, 255, 255], true)).toBe(false)
  })

  it('outlines light colours only on the light map', () => {
    expect(needsContrastOutline([255, 255, 255], false)).toBe(true)
    expect(needsContrastOutline([255, 255, 255], true)).toBe(false)
    expect(needsContrastOutline([0, 0, 0], false)).toBe(false)
  })

  it('uses the same inclusive thresholds as the shader', () => {
    const darkBoundary = Math.floor(DARK_THEME_LUMA_MAX * 255)
    const lightBoundary = Math.ceil(LIGHT_THEME_LUMA_MIN * 255)
    expect(srgbLuma([darkBoundary, darkBoundary, darkBoundary])).toBeLessThanOrEqual(
      DARK_THEME_LUMA_MAX,
    )
    expect(needsContrastOutline([darkBoundary, darkBoundary, darkBoundary], true)).toBe(true)
    expect(needsContrastOutline([lightBoundary, lightBoundary, lightBoundary], false)).toBe(true)
  })

  it('tracks the root theme and falls back to its colour scheme', () => {
    const root = document.documentElement
    root.dataset.theme = 'dark'
    expect(isDarkMapTheme(root)).toBe(true)
    root.dataset.theme = 'light'
    expect(isDarkMapTheme(root)).toBe(false)
    delete root.dataset.theme
    root.style.colorScheme = 'dark'
    expect(isDarkMapTheme(root)).toBe(true)
    root.style.colorScheme = ''
  })
})
