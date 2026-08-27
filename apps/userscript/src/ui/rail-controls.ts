import { redraw } from '../main.js'
import { getState, setState } from '../state.js'
import { icon } from './icons.js'

export const RAIL_BUTTON_CLASS = 'btn btn-square shadow-md relative'
export const MISMATCH_MODE_ID = 'caelestis-mismatch-mode'

export const syncMismatchModeState = (): void => {
  const button = document.getElementById(MISMATCH_MODE_ID)
  if (button === null) return
  const on = getState().appearance.markMismatch
  button.className = on ? `${RAIL_BUTTON_CLASS} btn-primary` : RAIL_BUTTON_CLASS
  button.setAttribute('aria-pressed', String(on))
  const label = on ? 'Hide global mismatch markers' : 'Show global mismatch markers'
  button.title = `${label} (W)`
  button.setAttribute('aria-label', label)
}

/** The always-reachable switch for the global marker default. */
export const mismatchModeButton = (): HTMLButtonElement => {
  const existing = document.getElementById(MISMATCH_MODE_ID)
  if (existing !== null) return existing as HTMLButtonElement
  const button = document.createElement('button')
  button.id = MISMATCH_MODE_ID
  button.appendChild(icon('bug'))
  button.addEventListener('click', () => {
    const appearance = getState().appearance
    setState({ appearance: { ...appearance, markMismatch: !appearance.markMismatch } })
    syncMismatchModeState()
    redraw()
  })
  syncMismatchModeState()
  return button
}
