// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { isDarkMapTheme } from './contrast-outline.js'

describe('contrast outline', () => {
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
