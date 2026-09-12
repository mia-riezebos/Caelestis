// @vitest-environment happy-dom

import { tick } from 'svelte'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type CaelestisClaimMode,
  CLAIM_MODE_TAG,
  type ClaimModeIntent,
  type ClaimModeModel,
  registerCaelestisUi,
} from '../src/elements/index.js'

beforeAll(() => registerCaelestisUi())
beforeEach(() => {
  document.body.replaceChildren()
  vi.useRealTimers()
})

const tools: ClaimModeModel['tools'] = [
  { tool: 'select', group: 'selection', label: 'Selection', key: 'V', icon: 'toolSelect' },
  { tool: 'direct', group: 'selection', label: 'Direct selection', key: 'A', icon: 'toolDirect' },
  { tool: 'lasso', group: 'selection', label: 'Lasso', key: 'Q', icon: 'toolLasso' },
  { tool: 'rectangle', group: 'shape', label: 'Rectangle', key: 'M', icon: 'toolRectangle' },
  { tool: 'ellipse', group: 'shape', label: 'Ellipse', key: 'L', icon: 'toolEllipse' },
  { tool: 'hand', group: 'navigate', label: 'Hand', key: 'H', icon: 'toolHand' },
]

const model = (tool: ClaimModeModel['tool'] = 'select'): ClaimModeModel => ({
  tool,
  tools,
  groups: [
    {
      id: 'selection',
      label: 'Selection tools',
      tools: tools.filter((entry) => entry.group === 'selection'),
      shown: 'select',
    },
    {
      id: 'shape',
      label: 'Shape tools',
      tools: tools.filter((entry) => entry.group === 'shape'),
      shown: 'ellipse',
    },
    {
      id: 'navigate',
      label: 'Navigation tools',
      tools: [tools[5] as (typeof tools)[number]],
      shown: 'hand',
    },
  ],
  options: { minCorners: 3, maxCorners: 32, maxWidth: 200 },
  subtract: false,
  items: 2,
  selected: true,
  selectedCount: 2,
  dirty: true,
  template: null,
  pixels: 40,
  pending: false,
})

const mount = async (tool?: ClaimModeModel['tool']) => {
  const element = document.createElement(CLAIM_MODE_TAG) as CaelestisClaimMode
  const intents: ClaimModeIntent[] = []
  element.addEventListener('caelestis-claim-mode-intent', (event) => {
    intents.push((event as CustomEvent<ClaimModeIntent>).detail)
  })
  element.model = model(tool)
  document.body.append(element)
  await tick()
  const root = element.shadowRoot as ShadowRoot
  const group = (id: string): HTMLButtonElement => {
    const button = root.querySelector<HTMLButtonElement>(`button[data-group="${id}"]`)
    if (button === null) throw new Error(`group ${id} missing`)
    return button
  }
  return { element, intents, root, group }
}

describe('claim mode drawer', () => {
  it('shows one button per group, with the shown tool and a corner where more hide', async () => {
    const { root, group, intents } = await mount()
    expect(root.querySelectorAll('button[data-group]')).toHaveLength(3)
    expect(group('selection').getAttribute('aria-label')).toBe('Selection')
    expect(group('shape').getAttribute('aria-label')).toBe('Ellipse')
    expect(group('selection').querySelector('.corner')).not.toBeNull()
    expect(group('navigate').querySelector('.corner')).toBeNull()
    group('shape').click()
    expect(intents).toEqual([{ type: 'set-tool', tool: 'ellipse' }])
  })

  it('opens the flyout on right-click and picks a tool from it', async () => {
    const { root, group, intents } = await mount()
    expect(root.querySelector('[role="menu"]')).toBeNull()
    group('selection').dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
    )
    await tick()
    const menu = root.querySelector<HTMLElement>('[role="menu"]')
    expect(menu?.getAttribute('aria-label')).toBe('Selection tools')
    expect(
      [...(menu?.querySelectorAll('[data-tool]') ?? [])].map((b) => b.getAttribute('data-tool')),
    ).toEqual(['select', 'direct', 'lasso'])
    menu?.querySelector<HTMLButtonElement>('[data-tool="lasso"]')?.click()
    await tick()
    expect(intents).toEqual([{ type: 'set-tool', tool: 'lasso' }])
    expect(root.querySelector('[role="menu"]')).toBeNull()
  })

  it('opens the flyout on a long press without also switching on release', async () => {
    vi.useFakeTimers()
    const { root, group, intents } = await mount()
    const button = group('selection')
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    vi.advanceTimersByTime(450)
    await tick()
    expect(root.querySelector('[role="menu"]')).not.toBeNull()
    button.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }))
    button.click()
    await tick()
    expect(intents).toEqual([])
    expect(root.querySelector('[role="menu"]')).not.toBeNull()
  })

  it('labels the delete action with the selection size', async () => {
    const { root } = await mount()
    const labels = [...root.querySelectorAll('button')].map((button) => button.textContent?.trim())
    expect(labels).toContain('Delete 2 shapes')
  })
})
