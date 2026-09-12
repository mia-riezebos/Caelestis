// @vitest-environment happy-dom

import { flushSync, mount, tick, unmount } from 'svelte'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CaelestisOverlayControls, registerCaelestisUi } from '../src/elements/index.js'
import OverlayControls from '../src/overlay/OverlayControls.svelte'
import type { OverlayControlsModel } from '../src/types.js'

beforeAll(() => registerCaelestisUi())
beforeEach(() => document.body.replaceChildren())

const model: OverlayControlsModel = {
  name: 'Forsaken City',
  lifecycle: { finished: true, frozen: false, griefed: true },
  failures: [{ id: 'visibility', message: 'Could not hide Forsaken City.', announce: true }],
  appearance: {
    values: {
      size: 1,
      radius: 0,
      translateX: 0,
      translateY: 0,
      rotation: 0,
      opacity: 1,
      contrastOutline: false,
      contrastOutlineSize: 1,
      markMismatch: true,
      markUnpainted: true,
      unpaintedLimit: 0.05,
      markerColour: '#ff0000',
      markerSize: 9,
      markSelectedColour: false,
      selectedMarkerColour: '#ffffff',
      selectedMarkerSize: 9,
      dimOthers: false,
      otherOpacity: 0.15,
      otherColour: null,
    },
    sliders: [],
    pixelPresets: [],
    colourPresets: [],
    palette: [],
    onlySelectedColour: false,
    paintOpen: false,
    groups: {
      pixels: { owned: true },
      markers: { owned: false },
      colours: { owned: true },
    },
  },
}

describe('overlay controls', () => {
  it('exposes the artwork action only when editable and disables it while pending', () => {
    const onIntent = vi.fn()
    const component = mount(OverlayControls, {
      target: document.body,
      props: { model: { ...model, updateArtwork: { pending: false, disabled: false } }, onIntent },
    })
    flushSync()
    const button = document.querySelector<HTMLButtonElement>(
      '[data-caelestis-control="update-artwork"]',
    )
    expect(button?.textContent).toContain('Use canvas artwork')
    button?.click()
    expect(onIntent).toHaveBeenCalledWith({ type: 'update-artwork' })
    void unmount(component)
    const pending = mount(OverlayControls, {
      target: document.body,
      props: { model: { ...model, updateArtwork: { pending: true, disabled: false } }, onIntent },
    })
    flushSync()
    expect(
      document.querySelector<HTMLButtonElement>('[data-caelestis-control="update-artwork"]')
        ?.disabled,
    ).toBe(true)
    void unmount(pending)
    const readonly = mount(OverlayControls, { target: document.body, props: { model } })
    flushSync()
    expect(document.querySelector('[data-caelestis-control="update-artwork"]')).toBeNull()
    void unmount(readonly)
  })
  it('uses Wplace compact-menu insets', () => {
    const component = mount(OverlayControls, { target: document.body, props: { model } })
    flushSync()

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
    const editor = document.querySelector<HTMLElement>('.editor')
    expect(getComputedStyle(dialog as Element).padding).toBe('16px')
    expect(getComputedStyle(editor as Element).paddingTop).toBe('0px')
    void unmount(component)
  })

  it('renders lifecycle and failures and emits typed host intents', () => {
    const onIntent = vi.fn()
    const component = mount(OverlayControls, {
      target: document.body,
      props: { model, onIntent },
    })
    flushSync()

    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe(
      'Forsaken City display options',
    )
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not hide Forsaken City.',
    )
    document.querySelector<HTMLButtonElement>('[aria-label="Close"]')?.click()
    expect(onIntent).toHaveBeenCalledWith({ type: 'close' })

    document.querySelector<HTMLInputElement>('[aria-label="Use default markers"]')?.click()
    expect(onIntent).toHaveBeenCalledWith({
      type: 'appearance',
      intent: { type: 'set-group-owned', group: 'markers', owned: true },
    })
    void unmount(component)
  })

  it('closes the display options on Escape', () => {
    const onIntent = vi.fn()
    const component = mount(OverlayControls, {
      target: document.body,
      props: { model, onIntent },
    })
    flushSync()

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
    dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(onIntent).toHaveBeenCalledWith({ type: 'close' })
    void unmount(component)
  })

  it('keeps the colour picker open for a retargeted shadow-DOM pointer event', async () => {
    const controls = new CaelestisOverlayControls()
    controls.model = model
    document.body.append(controls)
    await tick()

    const root = controls.shadowRoot
    const swatch = root?.querySelector<HTMLButtonElement>('[aria-label^="Marker colour:"]')
    swatch?.click()
    await tick()

    const picker = root?.querySelector<HTMLElement>('[data-caelestis-colour-picker]')
    const square = root?.querySelector<HTMLElement>('[aria-label="Saturation and brightness"]')
    if (picker === null || picker === undefined || square === null || square === undefined) {
      throw new Error('missing colour picker')
    }
    const path = [square, picker, root as ShadowRoot, controls, document.body, document, window]
    const pointer = new (class extends PointerEvent {
      override get target(): EventTarget | null {
        return controls
      }
      override composedPath(): EventTarget[] {
        return path
      }
    })('pointerdown')

    window.dispatchEvent(pointer)
    await tick()

    expect(root?.querySelector('[data-caelestis-colour-picker]')).toBe(picker)
  })
})
