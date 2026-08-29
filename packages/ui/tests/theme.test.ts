// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { applyThemeTokens, themeProperty } from '../src/theme.js'

describe('theme tokens', () => {
  it('maps typed token names to the public custom-property contract', () => {
    expect(themeProperty('raisedSurface')).toBe('--caelestis-raised-surface')
    expect(themeProperty('selectorRadius')).toBe('--caelestis-selector-radius')
    expect(themeProperty('touchTarget')).toBe('--caelestis-touch-target')
  })

  it('applies only the host values it receives', () => {
    const root = document.createElement('div')
    applyThemeTokens(root, { surface: 'black', text: 'white', panelRadius: '1rem' })

    expect(root.style.getPropertyValue('--caelestis-surface')).toBe('black')
    expect(root.style.getPropertyValue('--caelestis-text')).toBe('white')
    expect(root.style.getPropertyValue('--caelestis-panel-radius')).toBe('1rem')
    expect(root.style.getPropertyValue('--caelestis-danger')).toBe('')
  })
})
