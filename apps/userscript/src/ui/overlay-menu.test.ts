// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Appearance, DEFAULT_APPEARANCE } from '../templates/appearance.js'

const harness = vi.hoisted(() => ({
  beginMove: vi.fn(),
  localTemplates: vi.fn(() => [] as unknown[]),
  previewOriginFor: vi.fn(() => null as { x: number; y: number } | null),
  removeCustomOrderKeys: vi.fn(),
  removeLocalTemplate: vi.fn(async (_id: string) => true),
  screenPointFor: vi.fn(() => ({ x: 100, y: 200 }) as { x: number; y: number } | null),
  setAppearance: vi.fn(async (_id: string, _appearance: Appearance) => true),
  setLocalVisible: vi.fn(async (_id: string, _visible: boolean) => true),
}))

/** The appearance handed to the nth `setAppearance` call, or a failure naming the missing call. */
const appearanceWritten = (nth: number): Appearance => {
  const written = harness.setAppearance.mock.calls[nth]?.[1]
  if (written === undefined) throw new Error(`setAppearance was not called ${nth + 1} time(s)`)
  return written
}

vi.mock('../debug.js', () => ({ log: vi.fn(), warn: vi.fn() }))
vi.mock('../main.js', () => ({ screenPointFor: harness.screenPointFor }))
vi.mock('../state.js', () => ({ removeCustomOrderKeys: harness.removeCustomOrderKeys }))
vi.mock('../templates/local-store.js', () => ({
  localTemplates: harness.localTemplates,
  previewOriginFor: harness.previewOriginFor,
  removeLocalTemplate: harness.removeLocalTemplate,
  setAppearance: harness.setAppearance,
  setLocalVisible: harness.setLocalVisible,
}))
vi.mock('../templates/move.js', () => ({ beginMove: harness.beginMove }))

type Overrides = {
  id?: string
  name?: string
  visible?: boolean
  appearance?: Partial<typeof DEFAULT_APPEARANCE>
  originX?: number
  originY?: number
}

const template = (overrides: Overrides = {}) => ({
  id: overrides.id ?? 'a',
  name: overrides.name ?? 'alpha.png',
  visible: overrides.visible ?? true,
  width: 10,
  height: 10,
  originX: overrides.originX ?? 0,
  originY: overrides.originY ?? 0,
  appearance: { ...DEFAULT_APPEARANCE, ...overrides.appearance },
})

/** Let the awaited store write and its `.then` land before asserting on the DOM. */
const settle = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

const gear = (id: string): HTMLButtonElement => {
  const button = document.getElementById(`wts-overlay-button-${id}`)
  if (button === null) throw new Error(`no gear button for ${id}`)
  return button as HTMLButtonElement
}

const menu = (): HTMLElement => {
  const el = document.getElementById('wts-overlay-menu')
  if (el === null) throw new Error('no overlay menu')
  return el
}

const byLabel = (root: ParentNode, label: string): HTMLButtonElement => {
  const el = root.querySelector(`[aria-label="${label}"]`)
  if (el === null) throw new Error(`no control labelled ${label}`)
  return el as HTMLButtonElement
}

const swatch = (index: number): HTMLButtonElement => {
  const el = menu().querySelectorAll('.wts-swatch')[index]
  if (el === undefined) throw new Error(`no colour swatch at ${index}`)
  return el as HTMLButtonElement
}

const byText = (root: ParentNode, text: string): HTMLButtonElement => {
  const el = [...root.querySelectorAll('button')].find((node) => node.textContent === text)
  if (el === undefined) throw new Error(`no button reading ${text}`)
  return el as HTMLButtonElement
}

let render: (rerender: () => void) => void
const rerender = () => render(rerender)

beforeEach(async () => {
  document.body.innerHTML = ''
  const canvas = document.createElement('canvas')
  canvas.className = 'maplibregl-canvas'
  const host = document.createElement('div')
  host.appendChild(canvas)
  document.body.appendChild(host)
  render = (await import('./overlay-menu.js')).renderOverlayControls
})

afterEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  harness.localTemplates.mockReturnValue([])
  harness.previewOriginFor.mockReturnValue(null)
  harness.screenPointFor.mockReturnValue({ x: 100, y: 200 })
  harness.removeLocalTemplate.mockResolvedValue(true)
  harness.setAppearance.mockResolvedValue(true)
  harness.setLocalVisible.mockResolvedValue(true)
})

describe('the open menu tracks the store rather than a snapshot', () => {
  it('applies a second appearance edit on top of the first', async () => {
    const shaped = template({ appearance: { shape: 'circle' } })
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    byText(menu(), 'Dot').click()
    await settle()
    // The store now holds the shape; the next edit has to build on that, not on what was
    // captured when the menu opened.
    harness.localTemplates.mockReturnValue([shaped])
    rerender()
    const opacity = menu().querySelectorAll('input[type="range"]')
    const last = opacity[opacity.length - 1] as HTMLInputElement
    last.value = '0.5'
    last.dispatchEvent(new Event('input'))
    await settle()

    expect(harness.setAppearance).toHaveBeenLastCalledWith(
      'a',
      expect.objectContaining({ shape: 'circle', opacity: 0.5 }),
    )
  })

  it('accumulates hidden colours across successive swatch clicks', async () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    swatch(0).click()
    await settle()
    const first = appearanceWritten(0)
    harness.localTemplates.mockReturnValue([template({ appearance: first })])
    rerender()

    swatch(1).click()
    await settle()

    // Hiding a second colour must not un-hide the first.
    expect(first.hiddenColours).toHaveLength(1)
    expect(appearanceWritten(1).hiddenColours).toEqual([...first.hiddenColours, expect.any(Number)])
  })

  it('asks to show an overlay it has just hidden', async () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    byLabel(menu(), 'Hide this overlay').click()
    await settle()
    harness.localTemplates.mockReturnValue([template({ visible: false })])
    rerender()

    byLabel(menu(), 'Show this overlay').click()
    await settle()

    expect(harness.setLocalVisible).toHaveBeenNthCalledWith(1, 'a', false)
    expect(harness.setLocalVisible).toHaveBeenNthCalledWith(2, 'a', true)
  })

  it('reveals size and anchor once a sub-pixel shape is chosen', async () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    expect(menu().querySelector('[role="radiogroup"][aria-label="Anchor"]')).toBeNull()

    harness.localTemplates.mockReturnValue([template({ appearance: { shape: 'circle' } })])
    rerender()

    expect(menu().querySelector('[role="radiogroup"][aria-label="Anchor"]')).not.toBeNull()
  })

  it('rebuilds for the template whose gear was clicked', () => {
    harness.localTemplates.mockReturnValue([template(), template({ id: 'b', name: 'beta.png' })])
    rerender()
    gear('a').click()
    rerender()
    expect(menu().textContent).toContain('alpha.png')

    gear('b').click()
    rerender()

    expect(menu().textContent).toContain('beta.png')
    expect(menu().textContent).not.toContain('alpha.png')
  })

  it('follows a rename into the menu title and the gear tooltip', () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    harness.localTemplates.mockReturnValue([template({ name: 'renamed.png' })])
    rerender()

    expect(menu().textContent).toContain('renamed.png')
    expect(gear('a').title).toBe('renamed.png — display options')
  })

  it('keeps a dragged slider alive across the repaint it causes', async () => {
    harness.localTemplates.mockReturnValue([template({ appearance: { opacity: 0.4 } })])
    rerender()
    gear('a').click()
    rerender()
    const before = menu().querySelector('input[type="range"]')

    harness.localTemplates.mockReturnValue([template({ appearance: { opacity: 0.45 } })])
    rerender()

    // Opacity is outside the rebuild signature precisely so the pointer keeps its grip.
    expect(menu().querySelector('input[type="range"]')).toBe(before)
  })
})

describe('controls are reconciled against the templates that exist', () => {
  it('removes the gear of a template deleted elsewhere', () => {
    harness.localTemplates.mockReturnValue([template(), template({ id: 'b' })])
    rerender()
    expect(document.getElementById('wts-overlay-button-b')).not.toBeNull()

    harness.localTemplates.mockReturnValue([template()])
    rerender()

    expect(document.getElementById('wts-overlay-button-b')).toBeNull()
  })

  it('closes the open menu of a template deleted elsewhere', () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    expect(document.getElementById('wts-overlay-menu')).not.toBeNull()

    harness.localTemplates.mockReturnValue([])
    rerender()

    expect(document.getElementById('wts-overlay-menu')).toBeNull()
  })

  it('strips every control when the map host is gone', () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    document.querySelector('canvas.maplibregl-canvas')?.remove()

    rerender()

    expect(document.getElementById('wts-overlay-button-a')).toBeNull()
    expect(document.getElementById('wts-overlay-menu')).toBeNull()
  })

  it('drops the ordering key when the delete goes through', async () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    byLabel(menu(), 'Delete this template').click()
    byText(menu(), 'Delete').click()
    await settle()

    expect(harness.removeCustomOrderKeys).toHaveBeenCalledWith(new Set(['local:a']))
  })
})

describe('refused writes are reported rather than swallowed', () => {
  it('keeps the menu open and says so when a delete is refused', async () => {
    harness.localTemplates.mockReturnValue([template()])
    harness.removeLocalTemplate.mockResolvedValue(false)
    rerender()
    gear('a').click()
    rerender()
    byLabel(menu(), 'Delete this template').click()
    byText(menu(), 'Delete').click()
    await settle()

    expect(document.getElementById('wts-overlay-menu')).not.toBeNull()
    expect(menu().querySelector('[data-wts-error]')?.textContent).toContain('Could not delete')
    expect(harness.removeCustomOrderKeys).not.toHaveBeenCalled()
  })

  it('says so when a visibility change is refused', async () => {
    harness.localTemplates.mockReturnValue([template()])
    harness.setLocalVisible.mockResolvedValue(false)
    rerender()
    gear('a').click()
    rerender()
    byLabel(menu(), 'Hide this overlay').click()
    await settle()

    expect(menu().querySelector('[data-wts-error]')?.textContent).toContain('Could not change')
  })

  it('says so when an appearance change is refused', async () => {
    harness.localTemplates.mockReturnValue([template()])
    harness.setAppearance.mockResolvedValue(false)
    rerender()
    gear('a').click()
    rerender()
    byText(menu(), 'Dot').click()
    await settle()

    expect(menu().querySelector('[data-wts-error]')?.textContent).toContain('Could not update')
  })
})

describe('placement', () => {
  it('anchors the gear to the move preview while one is running', () => {
    harness.localTemplates.mockReturnValue([template({ originX: 0, originY: 0 })])
    harness.previewOriginFor.mockReturnValue({ x: 500, y: 600 })
    rerender()

    // width 10, so the top-right corner of the previewed overlay, not of the durable one.
    expect(harness.screenPointFor).toHaveBeenCalledWith(510, 600)
  })

  it('clamps the menu against the left viewport edge', () => {
    harness.localTemplates.mockReturnValue([template()])
    harness.screenPointFor.mockReturnValue({ x: -400, y: 300 })
    rerender()
    gear('a').click()
    rerender()

    expect(Number.parseFloat(menu().style.left)).toBeGreaterThanOrEqual(0)
  })
})
