// @vitest-environment happy-dom

import { tick } from 'svelte'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  CaelestisPaletteProgress,
  CaelestisShortcutHelp,
  CaelestisTemplateAdmin,
  CaelestisTemplateState,
  registerCaelestisUi,
} from '../src/elements/index.js'
import { PaletteProgress, ShortcutHelp, TemplateAdmin, TemplateState } from '../src/index.js'

beforeAll(() => registerCaelestisUi())

describe('@caelestis/ui', () => {
  it('exposes ordinary Svelte components from the root entry', () => {
    expect(TemplateState).toBeTypeOf('function')
    expect(TemplateAdmin).toBeTypeOf('function')
    expect(PaletteProgress).toBeTypeOf('function')
    expect(ShortcutHelp).toBeTypeOf('function')
  })

  it('renders shortcut help through the registered shared element', async () => {
    const help = new CaelestisShortcutHelp()
    help.model = { platform: 'mac' }
    document.body.append(help)
    await tick()

    expect(help.shadowRoot?.querySelector('dialog')?.open).toBe(true)
    expect(help.shadowRoot?.textContent).toContain('Cmd+Shift+Z')
  })

  it('renders Wplace palette progress through an independently mounted shared root', async () => {
    const progress = new CaelestisPaletteProgress()
    progress.model = { value: '1,234' }
    document.body.append(progress)
    await tick()
    expect(progress.shadowRoot?.textContent).toContain('1,234')
  })

  it('registers idempotently and renders inside shadow DOM', async () => {
    expect(() => registerCaelestisUi()).not.toThrow()
    const state = document.createElement('caelestis-template-state')
    state.finished = true
    state.frozen = true
    document.body.append(state)
    await tick()

    expect(state).toBeInstanceOf(CaelestisTemplateState)
    expect(state.shadowRoot?.textContent).toContain('Finished')
    expect(state.shadowRoot?.textContent).toContain('Timelapse frozen')
    expect(state.childNodes).toHaveLength(0)
  })

  it('only raises the grief alarm for a finished template', async () => {
    const state = new CaelestisTemplateState()
    state.griefed = true
    document.body.append(state)
    await tick()
    expect(state.shadowRoot?.textContent).not.toContain('Grief detected')

    state.finished = true
    await tick()
    expect(state.shadowRoot?.querySelector('[role="status"]')?.textContent).toContain(
      'Grief detected',
    )
  })

  it('renders server-owned regression and sustained-griefing alarms independently', async () => {
    const state = new CaelestisTemplateState()
    state.alarmKind = 'regression'
    state.pixelsLost = 1234
    document.body.append(state)
    await tick()
    expect(state.shadowRoot?.textContent).toContain('Regression · 1,234 px lost')

    state.alarmKind = 'sustained-griefing'
    await tick()
    expect(state.shadowRoot?.textContent).toContain('Sustained griefing · 1,234 px lost')
  })

  it.each([
    [true, false, 'Finished'],
    [false, true, 'Timelapse frozen'],
    [true, true, 'Finished Timelapse frozen'],
  ])(
    'keeps passive lifecycle states outside the live status region (%s, %s)',
    async (finished, frozen, label) => {
      const state = new CaelestisTemplateState()
      state.finished = finished
      state.frozen = frozen
      document.body.append(state)
      await tick()

      expect(state.shadowRoot?.querySelector('.lifecycle')?.textContent?.trim()).toBe(label)
      expect(state.shadowRoot?.querySelector('[role="status"]')).toBeNull()
      state.remove()
    },
  )

  it('keeps completion and frozen history while updating one explicit alarm', async () => {
    const state = new CaelestisTemplateState()
    state.finished = true
    state.frozen = true
    state.griefed = true
    state.alarmKind = 'regression'
    state.pixelsLost = 0
    document.body.append(state)
    await tick()

    const alarm = () => state.shadowRoot?.querySelector('[role="status"]')
    expect(state.shadowRoot?.querySelectorAll('[role="status"]')).toHaveLength(1)
    expect(alarm()?.getAttribute('aria-label')).toBe('Template alarm: Grief detected · Regression · 0 pixels lost')
    expect(alarm()?.getAttribute('aria-atomic')).toBe('true')
    expect(alarm()?.textContent).toContain('Grief detected · Regression · 0 px lost')

    state.alarmKind = 'sustained-griefing'
    state.pixelsLost = 1234
    await tick()
    expect(alarm()?.textContent).toContain('Sustained griefing · 1,234 px lost')
    expect(alarm()?.textContent).not.toContain('Regression')
    expect(state.shadowRoot?.querySelector('.lifecycle')?.textContent?.trim()).toBe(
      'Finished Timelapse frozen',
    )

    state.alarmKind = undefined
    await tick()
    expect(alarm()?.textContent).toContain('Grief detected')
    expect(alarm()?.textContent).not.toContain('px lost')

    state.griefed = false
    await tick()
    expect(alarm()).toBeNull()
    expect(state.shadowRoot?.querySelector('.lifecycle')?.textContent?.trim()).toBe(
      'Finished Timelapse frozen',
    )
    state.remove()
  })

  it('emits composed lifecycle intents and disables both actions while busy', async () => {
    const admin = new CaelestisTemplateAdmin()
    const changed = vi.fn()
    admin.addEventListener('caelestis-finished-change', changed)
    document.body.append(admin)
    await tick()

    admin.shadowRoot?.querySelector<HTMLButtonElement>('button')?.click()
    expect(changed).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { value: true }, bubbles: true, composed: true }),
    )

    admin.busy = true
    await tick()
    expect(
      Array.from(admin.shadowRoot?.querySelectorAll('button') ?? []).every(
        (button) => button.disabled,
      ),
    ).toBe(true)
  })
})
