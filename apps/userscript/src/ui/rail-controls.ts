import type { CaelestisRailControl, RailControlIntent } from '@caelestis/ui/elements'
import { redraw } from '../main.js'
import { getState, setState } from '../state.js'
import { applyWplaceTheme } from './theme.js'

export const MISMATCH_MODE_ID = 'caelestis-mismatch-mode'

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
