// @vitest-environment happy-dom
import { registerCaelestisUi } from '@caelestis/ui/elements'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  appearance: { markMismatch: false },
  redraw: vi.fn(),
  toolActive: false,
  connected: false,
  me: null as { wplaceUserId: number; displayName: string } | null,
  openClaimTool: vi.fn(() => true),
  stopClaimTool: vi.fn(),
}))

vi.mock('../main.js', () => ({ redraw: harness.redraw }))
vi.mock('../claim-tool.js', () => ({
  isClaimToolActive: () => harness.toolActive,
  stopClaimTool: harness.stopClaimTool,
}))
vi.mock('../presence-client.js', () => ({
  presenceView: () => ({
    peers: [],
    regions: [],
    online: 0,
    connected: harness.connected,
    me: harness.me,
  }),
}))
vi.mock('./presence-actions.js', () => ({ openClaimTool: harness.openClaimTool }))
vi.mock('../state.js', () => ({
  getState: () => ({ appearance: harness.appearance }),
  setState: (patch: { appearance: { markMismatch: boolean } }) => {
    harness.appearance = patch.appearance
  },
}))

import {
  claimToolButton,
  MISMATCH_MODE_ID,
  mismatchModeButton,
  syncClaimToolState,
  syncMismatchModeState,
} from './rail-controls.js'

beforeEach(() => {
  registerCaelestisUi()
  document.body.replaceChildren()
  harness.appearance = { markMismatch: false }
  harness.redraw.mockClear()
  harness.toolActive = false
  harness.connected = false
  harness.me = null
  harness.openClaimTool.mockClear()
  harness.stopClaimTool.mockClear()
})

describe('region claim rail control', () => {
  it('is always on the rail, disabled until presence is connected and signed in', async () => {
    const button = claimToolButton()
    document.body.appendChild(button)
    syncClaimToolState()
    await Promise.resolve()
    expect(button.model.disabled).toBe(true)
    expect(button.model.label).toBe('Claim a region (M)')

    harness.connected = true
    harness.me = { wplaceUserId: 7, displayName: 'Mia' }
    syncClaimToolState()
    expect(button.model.disabled).toBeUndefined()
  })

  it('opens the tool on click and closes it when pressed again', async () => {
    harness.connected = true
    harness.me = { wplaceUserId: 7, displayName: 'Mia' }
    const button = claimToolButton()
    document.body.appendChild(button)
    syncClaimToolState()
    await Promise.resolve()
    button.shadowRoot?.querySelector('button')?.click()
    expect(harness.openClaimTool).toHaveBeenCalledOnce()

    harness.toolActive = true
    syncClaimToolState()
    expect(button.model.pressed).toBe(true)
    button.shadowRoot?.querySelector('button')?.click()
    expect(harness.stopClaimTool).toHaveBeenCalledOnce()
  })
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

    expect(button.shadowRoot?.querySelector('button')?.title).toBe(
      'Hide global mismatch markers (W)',
    )
    expect(button.model.pressed).toBe(true)
  })

  it('reuses the mounted control after a rail sync', () => {
    const button = mismatchModeButton()
    document.body.appendChild(button)

    expect(mismatchModeButton()).toBe(button)
    expect(document.querySelectorAll(`#${MISMATCH_MODE_ID}`)).toHaveLength(1)
  })
})
