import { tick } from 'svelte'
import { afterEach, describe, expect, it } from 'vitest'
import { type CaelestisPanel, registerCaelestisUi } from '../src/elements/index.js'

afterEach(() => document.body.replaceChildren())

describe('custom element host boundary', () => {
  it('accepts its public model and forwards a composed panel intent', async () => {
    registerCaelestisUi()
    const element = document.createElement('caelestis-panel') as CaelestisPanel
    element.model = { view: 'tree', width: 320, minWidth: 280, maxWidth: 400 }
    const details: unknown[] = []
    element.addEventListener('caelestis-panel-intent', (event) =>
      details.push((event as CustomEvent).detail),
    )
    document.body.append(element)
    await tick()
    const close = element.shadowRoot?.querySelector(
      'button[aria-label="Close"]',
    ) as HTMLButtonElement
    close.click()
    expect(details).toEqual([{ type: 'close' }])
  })
})
