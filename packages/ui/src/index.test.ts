// @vitest-environment happy-dom

import { beforeAll, describe, expect, it, vi } from 'vitest'
import { CaelestisTemplateAdmin, CaelestisTemplateState, registerCaelestisUi } from './index.js'

beforeAll(() => registerCaelestisUi())

describe('@caelestis/ui', () => {
  it('registers idempotently and renders inside shadow DOM', async () => {
    expect(() => registerCaelestisUi()).not.toThrow()
    const state = document.createElement('caelestis-template-state')
    state.finished = true
    state.frozen = true
    document.body.append(state)
    await state.updateComplete

    expect(state).toBeInstanceOf(CaelestisTemplateState)
    expect(state.shadowRoot?.textContent).toContain('Finished')
    expect(state.shadowRoot?.textContent).toContain('Timelapse frozen')
    expect(state.childNodes).toHaveLength(0)
  })

  it('only raises the grief alarm for a finished template', async () => {
    const state = new CaelestisTemplateState()
    state.griefed = true
    document.body.append(state)
    await state.updateComplete
    expect(state.shadowRoot?.textContent).not.toContain('Grief detected')

    state.finished = true
    await state.updateComplete
    expect(state.shadowRoot?.querySelector('[role="status"]')?.textContent).toContain(
      'Grief detected',
    )
  })

  it('emits composed lifecycle intents and disables both actions while busy', async () => {
    const admin = new CaelestisTemplateAdmin()
    const changed = vi.fn()
    admin.addEventListener('caelestis-finished-change', changed)
    document.body.append(admin)
    await admin.updateComplete

    admin.shadowRoot?.querySelector<HTMLButtonElement>('button')?.click()
    expect(changed).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { value: true }, bubbles: true, composed: true }),
    )

    admin.busy = true
    await admin.updateComplete
    expect(
      Array.from(admin.shadowRoot?.querySelectorAll('button') ?? []).every(
        (button) => button.disabled,
      ),
    ).toBe(true)
  })
})
