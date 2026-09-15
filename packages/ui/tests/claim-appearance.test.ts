import { mount, tick, unmount } from 'svelte'
import { afterEach, describe, expect, it } from 'vitest'
import AppearanceEditor from '../src/appearance/AppearanceEditor.svelte'
import ClaimMode from '../src/claim/ClaimMode.svelte'
import type {
  AppearanceEditorIntent,
  AppearanceEditorModel,
  ClaimModeIntent,
  ClaimModeModel,
} from '../src/types.js'

const mounted: object[] = []
afterEach(async () => {
  await Promise.all(mounted.splice(0).map((component) => unmount(component)))
  document.body.replaceChildren()
})
describe('claim and appearance intent boundaries', () => {
  it('opens a tool flyout, selects the requested tool, and blocks pending actions', async () => {
    const intents: ClaimModeIntent[] = []
    const model = {
      tool: 'rectangle',
      tools: [
        { tool: 'rectangle', group: 'shape', label: 'Rectangle', key: 'R', icon: 'toolRectangle' },
        { tool: 'ellipse', group: 'shape', label: 'Ellipse', key: 'E', icon: 'toolEllipse' },
      ],
      subtract: false,
      items: 0,
      pixels: 0,
      template: null,
      selected: false,
      selectedCount: 0,
      dirty: false,
      pending: false,
      options: { minCorners: 3, maxCorners: 12, maxWidth: 200 },
      groups: [
        {
          id: 'shape',
          label: 'Shapes',
          shown: 'rectangle',
          tools: [
            {
              tool: 'rectangle',
              group: 'shape',
              label: 'Rectangle',
              key: 'R',
              icon: 'toolRectangle',
            },
            { tool: 'ellipse', group: 'shape', label: 'Ellipse', key: 'E', icon: 'toolEllipse' },
          ],
        },
      ],
    } satisfies ClaimModeModel
    const target = document.body.appendChild(document.createElement('div'))
    mounted.push(
      mount(ClaimMode, {
        target,
        props: { model, onIntent: (intent: ClaimModeIntent) => intents.push(intent) },
      }),
    )
    const tool = target.querySelector('button[aria-label="Rectangle"]') as HTMLButtonElement
    tool.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    await tick()
    ;(target.querySelector('[data-tool="ellipse"]') as HTMLButtonElement).click()
    expect(intents).toEqual([{ type: 'set-tool', tool: 'ellipse' }])
  })

  it('separates slider preview from commit and respects group ownership', async () => {
    const intents: AppearanceEditorIntent[] = []
    const model = {
      values: {
        size: 1,
        radius: 0,
        translateX: 0,
        translateY: 0,
        rotation: 0,
        opacity: 1,
        contrastOutline: false,
        contrastOutlineSize: 1,
        markerSize: 9,
        markMismatch: true,
        markerColour: '#ffffff',
        markUnpainted: false,
        unpaintedLimit: 0.05,
        dimOthers: false,
        otherOpacity: 0.15,
        markSelectedColour: false,
        selectedMarkerSize: 9,
        selectedMarkerColour: '#ffffff',
        otherColour: null,
      },
      sliders: [
        {
          key: 'opacity',
          label: 'Opacity',
          value: 0.5,
          defaultValue: 1,
          min: 0,
          max: 1,
          step: 0.1,
          format: 'percent',
        },
      ],
      pixelPresets: [],
      colourPresets: [],
      palette: [],
      onlySelectedColour: false,
      paintOpen: false,
      groups: { pixels: { owned: false }, markers: { owned: true }, colours: { owned: true } },
    } satisfies AppearanceEditorModel
    const target = document.body.appendChild(document.createElement('div'))
    mounted.push(
      mount(AppearanceEditor, {
        target,
        props: { model, onIntent: (intent: AppearanceEditorIntent) => intents.push(intent) },
      }),
    )
    const ownership = target.querySelector(
      'input[aria-label="Use default pixels"]',
    ) as HTMLInputElement
    expect(ownership.checked).toBe(true)
    ownership.click()
    expect(intents).toContainEqual({ type: 'set-group-owned', group: 'pixels', owned: true })
    const slider = target.querySelector('input[type="range"]') as HTMLInputElement
    slider.value = '0.7'
    slider.dispatchEvent(new Event('input', { bubbles: true }))
    slider.dispatchEvent(new Event('change', { bubbles: true }))
    expect(intents).toContainEqual({ type: 'preview-number', key: 'opacity', value: 0.7 })
    expect(intents).toContainEqual({ type: 'commit-number', key: 'opacity', value: 0.7 })
  })
})
