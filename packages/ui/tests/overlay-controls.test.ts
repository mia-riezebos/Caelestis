// @vitest-environment happy-dom

import { flushSync, mount, unmount } from 'svelte'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import OverlayControls from '../src/overlay/OverlayControls.svelte'
import type { OverlayControlsModel } from '../src/types.js'

beforeEach(() => document.body.replaceChildren())

const model: OverlayControlsModel = {
  name: 'Forsaken City',
  lifecycle: { finished: true, frozen: false, griefed: true },
  failures: [{ id: 'visibility', message: 'Could not hide Forsaken City.', announce: true }],
  confirmingDelete: false,
  deleting: false,
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

  it('answers the delete question before Escape closes the menu', () => {
    const onIntent = vi.fn()
    const component = mount(OverlayControls, {
      target: document.body,
      props: { model: { ...model, confirmingDelete: true }, onIntent },
    })
    flushSync()

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
      'Delete “Forsaken City”?',
    )
    dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(onIntent).toHaveBeenCalledWith({ type: 'cancel-delete' })
    expect(onIntent).not.toHaveBeenCalledWith({ type: 'close' })
    void unmount(component)
  })
})
