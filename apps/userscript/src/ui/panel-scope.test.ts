// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import {
  AllianceDrawerInset,
  alliancePanelTitle,
  bindRailActivation,
  PanelSessions,
} from './panel-scope.js'

describe('scoped panel sessions', () => {
  it('keeps the world panel open state and view separate from the alliance drawer', () => {
    const sessions = new PanelSessions()
    sessions.setOpen(true)
    sessions.setView('settings')

    sessions.select('alliance')
    expect(sessions.isOpen()).toBe(false)
    expect(sessions.view()).toBe('tree')

    sessions.setOpen(true)
    sessions.setView('appearance')
    sessions.select('world')
    expect(sessions.isOpen()).toBe(true)
    expect(sessions.view()).toBe('settings')

    sessions.select('alliance')
    expect(sessions.isOpen()).toBe(true)
    expect(sessions.view()).toBe('appearance')
    sessions.setView('settings')
    expect(sessions.view()).toBe('appearance')
  })

  it('reports only the open world tree as globally visible', () => {
    const sessions = new PanelSessions()
    sessions.setOpen(true)
    expect(sessions.isWorldTreeVisible()).toBe(true)

    sessions.select('alliance')
    sessions.setOpen(true)
    expect(sessions.isWorldTreeVisible()).toBe(false)

    sessions.select('world')
    sessions.setView('appearance')
    expect(sessions.isWorldTreeVisible()).toBe(false)
  })

  it('names every alliance drawer for its exact artboard', () => {
    expect(alliancePanelTitle({ kind: 'alliance-headquarters', allianceId: 1 })).toBe(
      'Headquarters overlays',
    )
    expect(alliancePanelTitle({ kind: 'alliance-picture', allianceId: 1 })).toBe('Picture overlays')
    expect(alliancePanelTitle({ kind: 'alliance-banner', allianceId: 1 })).toBe('Banner overlays')
  })
})

describe('alliance drawer DOM contracts', () => {
  it('activates from either the component intent or a direct host click', () => {
    const element = document.createElement('caelestis-rail-control')
    const activate = vi.fn()
    bindRailActivation(element, 'alliance-panel', activate)

    element.click()
    element.dispatchEvent(
      new CustomEvent('caelestis-rail-intent', {
        detail: { id: 'alliance-panel' },
        bubbles: true,
        composed: true,
      }),
    )

    expect(activate).toHaveBeenCalledTimes(2)
  })

  it('takes drawer width from the stage and restores Wplace ownership on close', () => {
    const stage = document.createElement('div')
    stage.style.marginInlineEnd = '4px'
    const inset = new AllianceDrawerInset()

    inset.apply(stage, 320, 12)
    expect(stage.style.marginInlineEnd).toBe('332px')

    inset.clear()
    expect(stage.style.marginInlineEnd).toBe('4px')
  })
})
