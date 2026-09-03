// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import {
  AllianceDrawerInset,
  alliancePanelTitle,
  allianceRailInlineEnd,
  allianceRailTop,
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

  it('keeps an artboard parent from capturing the alliance control pointer', () => {
    const stage = document.createElement('div')
    const element = document.createElement('caelestis-rail-control')
    const stagePointerDown = vi.fn()
    const activate = vi.fn()
    stage.addEventListener('pointerdown', stagePointerDown)
    stage.append(element)

    bindRailActivation(element, 'alliance-panel', activate, { isolatePointerDown: true })
    element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }))
    element.dispatchEvent(
      new CustomEvent('caelestis-rail-intent', {
        detail: { id: 'alliance-panel' },
        bubbles: true,
        composed: true,
      }),
    )

    expect(stagePointerDown).not.toHaveBeenCalled()
    expect(activate).toHaveBeenCalledOnce()
  })

  it('sits below Wplace chrome while the artboard is full screen', () => {
    const dialog = document.createElement('dialog')
    dialog.setAttribute('open', '')
    const editor = document.createElement('div')
    const header = document.createElement('header')
    const actionGroup = document.createElement('div')
    const exit = document.createElement('button')
    exit.setAttribute('aria-label', 'Vollbild beenden')
    exit.setAttribute('aria-pressed', 'true')
    actionGroup.append(exit)
    header.append(actionGroup)
    const stage = document.createElement('div')
    editor.append(header, stage)
    dialog.append(editor)
    document.body.append(dialog)
    stage.getBoundingClientRect = () => ({ top: 100 }) as DOMRect
    header.getBoundingClientRect = () => ({ bottom: 180 }) as DOMRect
    actionGroup.getBoundingClientRect = () => ({ bottom: 168 }) as DOMRect

    expect(allianceRailTop(stage, 12, 12)).toBe(80)

    exit.setAttribute('aria-label', 'Vollbild')
    exit.setAttribute('aria-pressed', 'false')
    expect(allianceRailTop(stage, 12, 12)).toBe(12)
    dialog.remove()
  })

  it('takes drawer width from the stage and restores Wplace ownership on close', () => {
    const editor = document.createElement('div')
    const header = document.createElement('header')
    const actionGroup = document.createElement('div')
    const exit = document.createElement('button')
    exit.setAttribute('aria-pressed', 'true')
    actionGroup.append(exit)
    header.append(actionGroup)
    const stage = document.createElement('div')
    editor.append(header, stage)
    document.body.append(editor)
    stage.style.marginInlineEnd = '4px'
    header.style.marginInlineEnd = '6px'
    const inset = new AllianceDrawerInset()

    inset.apply(stage, 320, 12)
    expect(stage.style.marginInlineEnd).toBe('332px')
    expect(header.style.marginInlineEnd).toBe('332px')

    exit.setAttribute('aria-pressed', 'false')
    inset.apply(stage, 320, 12)
    expect(stage.style.marginInlineEnd).toBe('332px')
    expect(header.style.marginInlineEnd).toBe('6px')

    inset.clear()
    expect(stage.style.marginInlineEnd).toBe('4px')
    expect(header.style.marginInlineEnd).toBe('6px')
    editor.remove()
  })

  it('aligns the rail with the fullscreen action group and keeps normal dialog spacing', () => {
    const editor = document.createElement('div')
    const header = document.createElement('header')
    const title = document.createElement('div')
    const actionGroup = document.createElement('div')
    const exit = document.createElement('button')
    exit.setAttribute('aria-pressed', 'true')
    actionGroup.append(exit)
    header.append(title, actionGroup)
    const stage = document.createElement('div')
    editor.append(header, stage)
    document.body.append(editor)
    editor.getBoundingClientRect = () => ({ right: 1_000 }) as DOMRect
    actionGroup.getBoundingClientRect = () => ({ right: 976 }) as DOMRect

    expect(allianceRailInlineEnd(stage, editor, 12)).toBe(24)

    exit.setAttribute('aria-pressed', 'false')
    Object.defineProperties(editor, { clientWidth: { value: 1_000 } })
    Object.defineProperties(stage, {
      offsetLeft: { value: 100 },
      offsetWidth: { value: 800 },
    })
    expect(allianceRailInlineEnd(stage, editor, 12)).toBe(112)
    editor.remove()
  })
})
