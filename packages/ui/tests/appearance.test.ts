// @vitest-environment happy-dom

import { flushSync, mount, unmount } from 'svelte'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AppearanceEditor from '../src/appearance/AppearanceEditor.svelte'
import type { AppearanceEditorModel } from '../src/types.js'

beforeEach(() => document.body.replaceChildren())

const model: AppearanceEditorModel = {
  values: {
    size: 0.6,
    radius: 0,
    translateX: 0,
    translateY: 0,
    rotation: 0,
    opacity: 0.85,
    contrastOutline: true,
    contrastOutlineSize: 0.85,
    markMismatch: false,
    markUnpainted: false,
    unpaintedLimit: 0.05,
    markerColour: '#ff00ff',
    markerSize: 9,
    markSelectedColour: false,
    selectedMarkerColour: '#00e5ff',
    selectedMarkerSize: 9,
    dimOthers: true,
    otherOpacity: 0.15,
    otherColour: null,
  },
  sliders: [
    {
      key: 'opacity',
      label: 'Opacity',
      value: 0.85,
      defaultValue: 0.85,
      min: 0.05,
      max: 1,
      step: 0.05,
      format: 'percent',
    },
  ],
  pixelPresets: [{ id: 'full', label: 'Full pixel', active: false }],
  colourPresets: [{ id: 'free', label: 'Free', active: false }],
  palette: [{ index: 0, name: 'Black', hex: '#000000', kind: 'free', visible: true }],
  onlySelectedColour: false,
  paintOpen: false,
  markerBudget: 16_384,
  markerBudgetOptions: [8_192, 16_384],
}

describe('appearance editor', () => {
  it('keeps the Wplace section structure and DaisyUI control geometry', () => {
    const component = mount(AppearanceEditor, { target: document.body, props: { model } })
    flushSync()

    expect(
      Array.from(document.querySelectorAll('[data-caelestis-section-title]')).map(
        (heading) => heading.textContent,
      ),
    ).toEqual(['Appearance', 'Markers', 'Colours'])
    expect(document.querySelectorAll('[data-caelestis-section-icon]')).toHaveLength(3)
    const section = document
      .querySelector('[data-caelestis-section-title]')
      ?.closest<HTMLElement>('.section')
    const opacity = document.querySelector<HTMLInputElement>('[aria-label="Opacity"]')
    expect(getComputedStyle(section as Element).paddingLeft).toBe('16px')
    expect(getComputedStyle(opacity?.closest('label') as Element).paddingTop).toBe('8px')
    expect(document.querySelectorAll('[aria-label="Reset size"]')).toHaveLength(0)

    void unmount(component)
  })

  it('emits previews during slider movement and one commit at the change seam', () => {
    const onIntent = vi.fn()
    const component = mount(AppearanceEditor, { target: document.body, props: { model, onIntent } })
    flushSync()
    const opacity = document.querySelector<HTMLInputElement>('[aria-label="Opacity"]')
    if (opacity === null) throw new Error('missing opacity slider')

    opacity.value = '0.65'
    opacity.dispatchEvent(new Event('input', { bubbles: true }))
    expect(onIntent).toHaveBeenCalledWith({ type: 'preview-number', key: 'opacity', value: 0.65 })
    opacity.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onIntent).toHaveBeenCalledWith({ type: 'commit-number', key: 'opacity', value: 0.65 })
    void unmount(component)
  })

  it('routes presets, marker switches, palette changes, and marker budgets as typed intents', () => {
    const onIntent = vi.fn()
    const component = mount(AppearanceEditor, { target: document.body, props: { model, onIntent } })
    flushSync()

    document.querySelector<HTMLButtonElement>('[aria-label="Full pixel"]')?.click()
    document
      .querySelector<HTMLButtonElement>('[aria-pressed="true"][aria-label="Black, free"]')
      ?.click()
    document.querySelector<HTMLInputElement>('[aria-label="Mark mismatched pixels"]')?.click()
    const budget = document.querySelector<HTMLSelectElement>('[aria-label="Visible marker limit"]')
    if (budget === null) throw new Error('missing marker budget')
    budget.value = '8192'
    budget.dispatchEvent(new Event('change', { bubbles: true }))

    expect(onIntent).toHaveBeenCalledWith({ type: 'pixel-preset', id: 'full' })
    expect(onIntent).toHaveBeenCalledWith({ type: 'toggle-colour', index: 0, visible: false })
    expect(onIntent).toHaveBeenCalledWith({ type: 'set-boolean', key: 'markMismatch', value: true })
    expect(onIntent).toHaveBeenCalledWith({ type: 'marker-budget', value: 8_192 })
    void unmount(component)
  })
})
