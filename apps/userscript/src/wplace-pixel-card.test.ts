// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import { dismissWplacePixelCard } from './wplace-pixel-card.js'

describe('dismissing the pixel card', () => {
  it('clicks the card’s Close button and leaves dialogs and our own chrome alone', () => {
    document.body.innerHTML = `
      <div class="card"><div class="flex"><button aria-label="Close" class="btn btn-circle btn-xs"></button></div><button>Paint</button></div>
      <dialog open><button aria-label="Close">x</button></dialog>
      <div id="caelestis-panel"><button aria-label="Close"></button></div>
      <div class="paint-drawer"><div><button title="Undo"></button><button title="Redo"></button><button aria-label="Close"></button></div></div>
    `
    const clicks = [...document.querySelectorAll('button[aria-label="Close"]')].map((button) => {
      const spy = vi.fn()
      button.addEventListener('click', spy)
      return spy
    })
    expect(dismissWplacePixelCard()).toBe(true)
    expect(clicks.map((spy) => spy.mock.calls.length)).toEqual([1, 0, 0, 0])
    document.body.innerHTML = ''
    expect(dismissWplacePixelCard()).toBe(false)
  })
})
