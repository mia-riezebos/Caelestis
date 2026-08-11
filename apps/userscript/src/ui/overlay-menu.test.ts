// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Appearance, DEFAULT_APPEARANCE } from '../templates/appearance.js'

const harness = vi.hoisted(() => ({
  beginMove: vi.fn(),
  isMoving: vi.fn(() => false),
  localTemplates: vi.fn(() => [] as unknown[]),
  previewOriginFor: vi.fn(() => null as { x: number; y: number } | null),
  removeCustomOrderKeys: vi.fn(),
  removeLocalTemplate: vi.fn(async (_id: string) => true),
  // A projection, not a constant: the module now derives the overlay's on-screen box from two
  // corners, and a constant would make every template look like a zero-size point.
  screenPointFor: vi.fn((x: number, y: number) => ({ x, y }) as { x: number; y: number } | null),
  setAppearance: vi.fn(async (_id: string, _appearance: Appearance) => true),
  setLocalVisible: vi.fn(async (_id: string, _visible: boolean) => true),
}))

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
vi.mock('../templates/move.js', () => ({
  beginMove: harness.beginMove,
  isMoving: harness.isMoving,
}))

/** The appearance handed to the nth `setAppearance` call, or a failure naming the missing call. */
const appearanceWritten = (nth: number): Appearance => {
  const written = harness.setAppearance.mock.calls[nth]?.[1]
  if (written === undefined) throw new Error(`setAppearance was not called ${nth + 1} time(s)`)
  return written
}

type Overrides = {
  id?: string
  name?: string
  visible?: boolean
  appearance?: Partial<Appearance>
  originX?: number
  originY?: number
  width?: number
}

const template = (overrides: Overrides = {}) => ({
  id: overrides.id ?? 'a',
  name: overrides.name ?? 'alpha.png',
  visible: overrides.visible ?? true,
  width: overrides.width ?? 10,
  height: 10,
  originX: overrides.originX ?? 0,
  originY: overrides.originY ?? 0,
  appearance: { ...DEFAULT_APPEARANCE, ...overrides.appearance },
})

/** Flush the microtask queue, however many turns the store's continuation chain actually takes. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

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

const byKey = (key: string): HTMLElement => {
  const el = menu().querySelector(`[data-wts-key="${key}"]`)
  if (el === null) throw new Error(`no control keyed ${key}`)
  return el as HTMLElement
}

const byText = (root: ParentNode, text: string): HTMLButtonElement => {
  const el = [...root.querySelectorAll('button')].find((node) => node.textContent === text)
  if (el === undefined) throw new Error(`no button reading ${text}`)
  return el as HTMLButtonElement
}

const errorText = (): string | null => menu().querySelector('[data-wts-error]')?.textContent ?? null

let mapCanvas: HTMLCanvasElement
let render: (rerender: () => void, canvas: HTMLCanvasElement) => void
const rerender = () => render(rerender, mapCanvas)

beforeEach(async () => {
  document.body.innerHTML = ''
  mapCanvas = document.createElement('canvas')
  // The class the module used to look itself up by; kept so the pre-fix module is still runnable
  // when these tests are checked for red.
  mapCanvas.className = 'maplibregl-canvas'
  const host = document.createElement('div')
  host.appendChild(mapCanvas)
  document.body.appendChild(host)
  render = (await import('./overlay-menu.js')).renderOverlayControls
})

afterEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  harness.localTemplates.mockReturnValue([])
  harness.previewOriginFor.mockReturnValue(null)
  harness.screenPointFor.mockImplementation((x: number, y: number) => ({ x, y }))
  harness.isMoving.mockReturnValue(false)
  harness.removeLocalTemplate.mockResolvedValue(true)
  harness.setAppearance.mockImplementation(async () => true)
  harness.setLocalVisible.mockResolvedValue(true)
})

describe('the open menu tracks intended state, not a snapshot and not a lagging store', () => {
  it('applies a second appearance edit on top of the first', async () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    byText(menu(), 'Dot').click()
    await settle()
    harness.localTemplates.mockReturnValue([template({ appearance: { shape: 'circle' } })])
    rerender()
    const opacity = byKey('opacity') as HTMLInputElement
    opacity.value = '0.5'
    opacity.dispatchEvent(new Event('change'))
    await settle()

    expect(appearanceWritten(1)).toMatchObject({ shape: 'circle', opacity: 0.5 })
  })

  it('builds the next edit on one the store has not acknowledged yet', async () => {
    // The store only publishes after the durable write resolves. Two clicks inside that window is
    // ordinary human speed, and reading the store would hand the second one a pre-Dot base.
    let acknowledge = (_saved: boolean): void => {}
    harness.setAppearance.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        acknowledge = resolve
      }),
    )
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    byText(menu(), 'Dot').click()
    rerender()
    byKey('swatch:1').click()
    await settle()

    expect(appearanceWritten(1).shape).toBe('circle')
    acknowledge(true)
  })

  it('accumulates hidden colours across successive swatch clicks', async () => {
    harness.localTemplates.mockReturnValue([template()])
    // A store that actually commits, so the second click reads the first one's result rather than
    // a value the fake never moved.
    harness.setAppearance.mockImplementation(async (_id, appearance) => {
      harness.localTemplates.mockReturnValue([template({ appearance })])
      return true
    })
    rerender()
    gear('a').click()
    rerender()

    byKey('swatch:1').click()
    await settle()
    rerender()
    byKey('swatch:2').click()
    await settle()

    expect(appearanceWritten(0).hiddenColours).toEqual([1])
    expect(appearanceWritten(1).hiddenColours).toEqual([1, 2])
  })

  it('asks to show an overlay it has just hidden', async () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    byKey('hide').click()
    await settle()
    harness.localTemplates.mockReturnValue([template({ visible: false })])
    rerender()

    byKey('hide').click()
    await settle()

    expect(harness.setLocalVisible).toHaveBeenNthCalledWith(1, 'a', false)
    expect(harness.setLocalVisible).toHaveBeenNthCalledWith(2, 'a', true)
  })

  it('reveals size and anchor once a sub-pixel shape is chosen', () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    expect(menu().querySelector('[aria-label="Anchor"]')).toBeNull()

    harness.localTemplates.mockReturnValue([template({ appearance: { shape: 'circle' } })])
    rerender()

    expect(menu().querySelector('[aria-label="Anchor"]')).not.toBeNull()
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

  it('keeps a dragged slider alive across the repaint it causes', () => {
    harness.localTemplates.mockReturnValue([template({ appearance: { opacity: 0.4 } })])
    rerender()
    gear('a').click()
    rerender()
    const before = byKey('opacity')

    harness.localTemplates.mockReturnValue([template({ appearance: { opacity: 0.45 } })])
    rerender()

    // Opacity is outside the rebuild signature precisely so the pointer keeps its grip.
    expect(byKey('opacity')).toBe(before)
  })

  it('moves an unfocused slider to a value changed elsewhere', () => {
    harness.localTemplates.mockReturnValue([template({ appearance: { opacity: 0.4 } })])
    rerender()
    gear('a').click()
    rerender()
    expect((byKey('opacity') as HTMLInputElement).value).toBe('0.4')

    harness.localTemplates.mockReturnValue([template({ appearance: { opacity: 0.9 } })])
    rerender()

    // Outside the signature must not mean frozen: another tab can move this.
    expect((byKey('opacity') as HTMLInputElement).value).toBe('0.9')
  })

  it('writes once per slider drag, on release', async () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    const opacity = byKey('opacity') as HTMLInputElement

    for (const value of ['0.5', '0.55', '0.6']) {
      opacity.value = value
      opacity.dispatchEvent(new Event('input'))
    }
    await settle()
    // Each of those used to be a durable write that also cleared the stamped-tile cache.
    expect(harness.setAppearance).not.toHaveBeenCalled()

    opacity.dispatchEvent(new Event('change'))
    await settle()

    expect(harness.setAppearance).toHaveBeenCalledTimes(1)
    expect(appearanceWritten(0).opacity).toBe(0.6)
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
    mapCanvas.remove()

    rerender()

    expect(document.getElementById('wts-overlay-button-a')).toBeNull()
    expect(document.getElementById('wts-overlay-menu')).toBeNull()
  })

  it('gives no control to a template that is entirely off screen', () => {
    // Projection succeeds for any coordinate, so nothing but an explicit box test stops every
    // template in the store from clamping a button onto the same viewport corner.
    harness.localTemplates.mockReturnValue([
      template(),
      template({ id: 'far', originX: 50_000, originY: 50_000 }),
    ])

    rerender()

    expect(document.getElementById('wts-overlay-button-a')).not.toBeNull()
    expect(document.getElementById('wts-overlay-button-far')).toBeNull()
  })

  it('does not adopt a button the page planted under our id', () => {
    const impostor = document.createElement('button')
    impostor.id = 'wts-overlay-button-a'
    document.body.appendChild(impostor)
    harness.localTemplates.mockReturnValue([template()])

    rerender()

    const ours = [...document.querySelectorAll('#wts-overlay-button-a')].filter(
      (el) => el !== impostor,
    )
    expect(ours).toHaveLength(1)
    expect(ours[0]?.getAttribute('aria-label')).toBe('alpha.png display options')
  })

  it('drops the ordering key when the delete goes through', async () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    byKey('delete').click()
    byKey('confirm-delete').click()
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
    byKey('delete').click()
    byKey('confirm-delete').click()
    await settle()

    expect(document.getElementById('wts-overlay-menu')).not.toBeNull()
    expect(errorText()).toContain('Could not delete')
    expect(harness.removeCustomOrderKeys).not.toHaveBeenCalled()
  })

  it('says so when a visibility change is refused', async () => {
    harness.localTemplates.mockReturnValue([template()])
    harness.setLocalVisible.mockResolvedValue(false)
    rerender()
    gear('a').click()
    rerender()
    byKey('hide').click()
    await settle()

    expect(errorText()).toContain('Could not change')
  })

  it('says so when an appearance change is refused', async () => {
    harness.localTemplates.mockReturnValue([template()])
    harness.setAppearance.mockResolvedValue(false)
    rerender()
    gear('a').click()
    rerender()
    byText(menu(), 'Dot').click()
    await settle()

    expect(errorText()).toContain('Could not update')
  })

  it('reports a refusal raised after a rebuild replaced the menu', async () => {
    let acknowledge = (_saved: boolean): void => {}
    harness.setLocalVisible.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        acknowledge = resolve
      }),
    )
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    byKey('hide').click()

    // Something else changes the menu while the write is in flight.
    harness.localTemplates.mockReturnValue([template({ name: 'renamed.png' })])
    rerender()
    acknowledge(false)
    await settle()

    // The handler must not report into the node it was built with; that one is detached.
    expect(errorText()).toContain('Could not change')
  })

  it('says so when Move is refused because a placement is already running', () => {
    harness.isMoving.mockReturnValue(true)
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    byKey('move').click()

    expect(harness.beginMove).not.toHaveBeenCalled()
    expect(document.getElementById('wts-overlay-menu')).not.toBeNull()
    expect(errorText()).toContain('placement already in progress')
  })
})

describe('a rebuild does not take the interaction with it', () => {
  it('keeps the delete question up when something else changes the menu', () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    byKey('delete').click()
    expect(menu().querySelector('[data-wts-confirm]')).not.toBeNull()

    harness.localTemplates.mockReturnValue([template({ name: 'renamed.png' })])
    rerender()

    // Answering "are you sure" should not be interrupted by a repaint.
    expect(menu().querySelector('[data-wts-confirm]')).not.toBeNull()
  })

  it('keeps the keyboard where it was', () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    byKey('swatch:5').focus()

    harness.localTemplates.mockReturnValue([template({ name: 'renamed.png' })])
    rerender()

    expect((document.activeElement as HTMLElement | null)?.dataset.wtsKey).toBe('swatch:5')
  })

  it('moves focus into the menu when it opens', () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()

    gear('a').click()
    rerender()

    expect((document.activeElement as HTMLElement | null)?.dataset.wtsKey).toBe('hide')
  })
})

describe('the exclusive choices behave like the radiogroups they announce', () => {
  it('is a single tab stop with the selected option on it', () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    const shapes = [...menu().querySelectorAll('[role="radio"]')] as HTMLElement[]
    expect(shapes.filter((cell) => cell.tabIndex === 0)).toHaveLength(1)
    expect(byKey('Shape:full').tabIndex).toBe(0)
  })

  it('selects the next option on an arrow key', async () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    byKey('Shape:full').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    )
    await settle()

    expect(appearanceWritten(0).shape).toBe('square')
  })

  it('does not contradict its own label on the hide toggle', () => {
    harness.localTemplates.mockReturnValue([template({ visible: false })])
    rerender()
    gear('a').click()
    rerender()

    const hide = byKey('hide')
    expect(hide.getAttribute('aria-label')).toBe('Show this overlay')
    // "Show this overlay, pressed" reads as though showing were already on.
    expect(hide.hasAttribute('aria-pressed')).toBe(false)
  })

  it('tells assistive technology the gear owns a dialog', () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    expect(gear('a').getAttribute('aria-expanded')).toBe('false')

    gear('a').click()
    rerender()

    expect(gear('a').getAttribute('aria-expanded')).toBe('true')
    expect(gear('a').getAttribute('aria-haspopup')).toBe('dialog')
    expect(menu().getAttribute('role')).toBe('dialog')
  })
})

describe('placement and geometry', () => {
  it('anchors the gear to the move preview while one is running', () => {
    harness.localTemplates.mockReturnValue([template({ originX: 0, originY: 0 })])
    harness.previewOriginFor.mockReturnValue({ x: 500, y: 600 })
    rerender()

    // The previewed box, not the durable one.
    expect(harness.screenPointFor).toHaveBeenCalledWith(500, 600)
    expect(harness.screenPointFor).toHaveBeenCalledWith(510, 610)
  })

  it('keeps the menu clear of the left viewport edge', () => {
    // Top-right corner at x=1, so an unclamped menu would sit at 7px and creep off screen.
    harness.localTemplates.mockReturnValue([template({ originX: -9, width: 10 })])
    rerender()
    gear('a').click()
    rerender()

    expect(Number.parseFloat(menu().style.left)).toBeGreaterThanOrEqual(8)
  })

  it('sits below the panel rather than over it', () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    // The panel mounts at z-30 and is the focused surface while it is open.
    expect(Number(gear('a').style.zIndex)).toBeLessThan(30)
    expect(Number(menu().style.zIndex)).toBeLessThan(30)
  })
})
