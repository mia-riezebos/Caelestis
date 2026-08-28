// @vitest-environment happy-dom
import { registerCaelestisUi } from '@caelestis/ui/elements'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  appearance: { markMismatch: false },
  redraw: vi.fn(),
}))

vi.mock('../main.js', () => ({ redraw: harness.redraw }))
vi.mock('../state.js', () => ({
  getState: () => ({ appearance: harness.appearance }),
  setState: (patch: { appearance: { markMismatch: boolean } }) => {
    harness.appearance = patch.appearance
  },
}))

import { MISMATCH_MODE_ID, mismatchModeButton, syncMismatchModeState } from './rail-controls.js'

beforeEach(() => {
  registerCaelestisUi()
  document.body.replaceChildren()
  harness.appearance = { markMismatch: false }
  harness.redraw.mockClear()
})

describe('global mismatch-marker rail control', () => {
  it('toggles the global default and exposes the pressed state', async () => {
    const button = mismatchModeButton()
    document.body.appendChild(button)
    syncMismatchModeState()

    await Promise.resolve()
    expect(button.shadowRoot?.querySelector('button')?.getAttribute('aria-pressed')).toBe('false')
    button.shadowRoot?.querySelector('button')?.click()
    await Promise.resolve()

    expect(harness.appearance.markMismatch).toBe(true)
    expect(button.model.pressed).toBe(true)
    expect(button.shadowRoot?.querySelector('button')?.getAttribute('aria-pressed')).toBe('true')
    expect(harness.redraw).toHaveBeenCalledOnce()
  })

  it('synchronizes changes made from the appearance panel', async () => {
    const button = mismatchModeButton()
    document.body.appendChild(button)
    harness.appearance = { ...harness.appearance, markMismatch: true }

    syncMismatchModeState()
    await Promise.resolve()

    expect(button.shadowRoot?.querySelector('button')?.title).toBe('Hide global mismatch markers (W)')
    expect(button.model.pressed).toBe(true)
  })

  it('reuses the mounted control after a rail sync', () => {
    const button = mismatchModeButton()
    document.body.appendChild(button)

    expect(mismatchModeButton()).toBe(button)
    expect(document.querySelectorAll(`#${MISMATCH_MODE_ID}`)).toHaveLength(1)
  })
})
