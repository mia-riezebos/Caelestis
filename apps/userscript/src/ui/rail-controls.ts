import type { CaelestisRailControl, RailControlIntent } from '@caelestis/ui/elements'
import { isClaimModeActive, stopClaimMode } from '../claim-editor.js'
import { redraw } from '../main.js'
import { presenceView } from '../presence-client.js'
import { getState, setState } from '../state.js'
import { openClaimTool } from './presence-actions.js'
import { applyWplaceTheme } from './theme.js'

export const MISMATCH_MODE_ID = 'caelestis-mismatch-mode'
export const CLAIM_TOOL_ID = 'caelestis-claim-tool-mode'

export const syncClaimToolState = (): void => {
  const button = document.getElementById(CLAIM_TOOL_ID) as CaelestisRailControl | null
  if (button === null) return
  const active = isClaimModeActive()
  const view = presenceView()
  const ready = view.connected && view.me !== null
  button.model = {
    id: 'claim',
    label: active ? 'Leave claim mode (Esc)' : 'Claim a region (M)',
    title:
      ready || active
        ? active
          ? 'Leave claim mode without saving (Esc)'
          : 'Claim a region: draw shapes, paths, and strokes over the map (M or L)'
        : 'Claim a region. Needs a connected server with painter presence and a Wplace sign-in.',
    pressed: active,
    ...(ready || active ? {} : { disabled: true }),
  }
}

/** The always-reachable way into the region claim tool, beside the panel and marker switches. */
export const claimToolButton = (): CaelestisRailControl => {
  const existing = document.getElementById(CLAIM_TOOL_ID)
  if (existing !== null) return existing as CaelestisRailControl
  const button = document.createElement('caelestis-rail-control')
  button.id = CLAIM_TOOL_ID
  applyWplaceTheme(button)
  button.addEventListener('caelestis-rail-intent', (event) => {
    const intent = (event as CustomEvent<RailControlIntent>).detail
    if (intent.id !== 'claim') return
    if (isClaimModeActive()) stopClaimMode()
    else openClaimTool()
    syncClaimToolState()
  })
  syncClaimToolState()
  return button
}

export const syncMismatchModeState = (): void => {
  const button = document.getElementById(MISMATCH_MODE_ID) as CaelestisRailControl | null
  if (button === null) return
  const on = getState().appearance.markMismatch
  const label = on ? 'Hide global mismatch markers' : 'Show global mismatch markers'
  button.model = { id: 'mismatch', label: `${label} (W)`, pressed: on }
}

/** The always-reachable switch for the global marker default. */
export const mismatchModeButton = (): CaelestisRailControl => {
  const existing = document.getElementById(MISMATCH_MODE_ID)
  if (existing !== null) return existing as CaelestisRailControl
  const button = document.createElement('caelestis-rail-control')
  button.id = MISMATCH_MODE_ID
  applyWplaceTheme(button)
  button.addEventListener('caelestis-rail-intent', (event) => {
    const intent = (event as CustomEvent<RailControlIntent>).detail
    if (intent.id !== 'mismatch') return
    const appearance = getState().appearance
    setState({ appearance: { ...appearance, markMismatch: !appearance.markMismatch } })
    syncMismatchModeState()
    redraw()
  })
  syncMismatchModeState()
  return button
}
