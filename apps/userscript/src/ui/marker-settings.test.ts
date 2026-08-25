// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_APPEARANCE } from '../templates/appearance.js'
import { mismatchSettings } from './marker-settings.js'

describe('marker settings', () => {
  it('exposes an independently styled selected-colour marker', () => {
    const settings = mismatchSettings(DEFAULT_APPEARANCE, vi.fn(), vi.fn())
    const selectedToggle = [...settings.querySelectorAll('label')].find((label) =>
      label.textContent?.includes('Mark selected colour'),
    )
    const selectedGroup = settings.querySelector<HTMLElement>(
      '[data-caelestis-marker="selected-colour"]',
    )

    expect(selectedToggle?.querySelector('input[type="checkbox"]')).toBeInstanceOf(HTMLInputElement)
    expect(selectedGroup?.textContent).toContain('Size')
    expect(selectedGroup?.textContent).toContain('Colour')
    expect(
      selectedGroup?.querySelector('button[aria-label^="Selected colour marker colour:"]'),
    ).toBeInstanceOf(HTMLButtonElement)
  })
})
