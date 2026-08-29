// @vitest-environment happy-dom

import { tick } from 'svelte'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CaelestisRailControl, registerCaelestisUi } from '../src/elements/index.js'

beforeAll(() => registerCaelestisUi())
beforeEach(() => document.body.replaceChildren())

describe('rail control', () => {
  it('renders pressed, expanded, and badge state from one model', async () => {
    const control = new CaelestisRailControl()
    control.model = {
      id: 'panel',
      label: 'Caelestis — shared templates (C)',
      pressed: true,
      expanded: true,
      controls: 'caelestis-panel',
      badge: 3,
    }
    document.body.append(control)
    await tick()

    const button = control.shadowRoot?.querySelector('button')
    expect(button?.getAttribute('aria-pressed')).toBe('true')
    expect(button?.getAttribute('aria-expanded')).toBe('true')
    expect(button?.getAttribute('aria-controls')).toBe('caelestis-panel')
    expect(control.shadowRoot?.textContent).toContain('3')
  })

  it('emits one composed activation intent', async () => {
    const control = new CaelestisRailControl()
    const intent = vi.fn()
    control.model = { id: 'colour', label: 'Show only the selected colour', pressed: false }
    control.addEventListener('caelestis-rail-intent', intent)
    document.body.append(control)
    await tick()

    control.shadowRoot?.querySelector('button')?.click()
    expect(intent).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { type: 'activate', id: 'colour' }, composed: true }),
    )
  })

  it('matches the circular Wplace rail controls', async () => {
    const control = new CaelestisRailControl()
    control.model = { id: 'panel', label: 'Caelestis', pressed: false }
    document.body.append(control)
    await tick()

    const button = control.shadowRoot?.querySelector('button')
    expect(button).not.toBeNull()
    expect(getComputedStyle(button as Element).borderRadius).toBe('999px')
  })

  it('uses Wplace raised surfaces for inactive controls in every theme', async () => {
    const control = new CaelestisRailControl()
    control.model = { id: 'panel', label: 'Caelestis', pressed: false }
    document.body.append(control)
    await tick()

    const styles = [...(control.shadowRoot?.querySelectorAll('style') ?? [])]
      .map((style) => style.textContent)
      .join('\n')
    expect(styles).toMatch(/--button-base-colour:\s*var\(--caelestis-raised-surface/)
    expect(styles).toMatch(/border:\s*var\(--border,\s*1px\)/)
    expect(styles).toContain('0 4px 6px -1px')
  })

  it('uses the complete Material palette glyph', async () => {
    const control = new CaelestisRailControl()
    control.model = { id: 'colour', label: 'Show only the selected colour', pressed: false }
    document.body.append(control)
    await tick()

    expect(control.shadowRoot?.querySelector('path')?.getAttribute('d')).toContain('Zm-220-440')
  })
})
