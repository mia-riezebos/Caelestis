// @vitest-environment happy-dom

import { tick } from 'svelte'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  CaelestisPaletteProgress,
  CaelestisTemplateAdmin,
  CaelestisTemplateState,
  registerCaelestisUi,
} from '../src/elements/index.js'
import { PaletteProgress, TemplateAdmin, TemplateState } from '../src/index.js'

beforeAll(() => registerCaelestisUi())

describe('@caelestis/ui', () => {
  it('exposes ordinary Svelte components from the root entry', () => {
    expect(TemplateState).toBeTypeOf('function')
    expect(TemplateAdmin).toBeTypeOf('function')
    expect(PaletteProgress).toBeTypeOf('function')
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
