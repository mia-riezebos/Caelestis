// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Appearance, DEFAULT_APPEARANCE } from '../templates/appearance.js'

const harness = vi.hoisted(() => ({
  beginMove: vi.fn(),
  isMoving: vi.fn(() => false),
  localTemplates: vi.fn(() => [] as unknown[]),
  previewOriginFor: vi.fn(() => null as { x: number; y: number } | null),
  removeCustomOrderKeys: vi.fn(),
  isDeletingLocal: vi.fn((_id: string) => false),
  removeLocalTemplate: vi.fn(async (_id: string) => true),
  // A projection, not a constant: the module derives the overlay's on-screen box from one
  // projected corner plus the scale, and a constant would make every template a zero-size point.
  screenPointFor: vi.fn((x: number, y: number) => ({ x, y }) as { x: number; y: number } | null),
  cssPixelsPerCanvasPixel: vi.fn(() => ({ x: 1, y: 1 })),
  setAppearance: vi.fn(async (_id: string, _appearance: Appearance) => true),
  setLocalVisible: vi.fn(async (_id: string, _visible: boolean) => true),
}))

vi.mock('../debug.js', () => ({ log: vi.fn(), warn: vi.fn() }))
vi.mock('../main.js', () => ({
  cssPixelsPerCanvasPixel: harness.cssPixelsPerCanvasPixel,
  screenPointFor: harness.screenPointFor,
}))
vi.mock('../state.js', () => ({ removeCustomOrderKeys: harness.removeCustomOrderKeys }))
vi.mock('../templates/local-store.js', () => ({
  isDeletingLocal: harness.isDeletingLocal,
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
  const el = menu().querySelector(`[data-wts-control="${key}"]`)
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
  harness.cssPixelsPerCanvasPixel.mockReturnValue({ x: 1, y: 1 })
  harness.isMoving.mockReturnValue(false)
  harness.isDeletingLocal.mockReturnValue(false)
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
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let call = 0
    harness.setAppearance.mockImplementation(async (_id, appearance) => {
      if (++call === 1) await held
      harness.localTemplates.mockReturnValue([template({ appearance })])
      return true
    })
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    byText(menu(), 'Dot').click()
    rerender()
    byKey('swatch:1').click()
    release()
    await settle()

    // The second write must carry the first one's shape, not put it back to `full`.
    expect(appearanceWritten(1)).toMatchObject({ shape: 'circle', hiddenColours: [1] })
  })

  it('composes a queued edit against the store the earlier write left behind', async () => {
    // Each write sends a whole Appearance. A queued snapshot taken before an earlier write
    // reconciled another tab's change would put that change straight back.
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let call = 0
    harness.setAppearance.mockImplementation(async (_id, _appearance) => {
      if (++call === 1) {
        await held
        // The first write conflicts and reconciliation lands another tab's opacity.
        harness.localTemplates.mockReturnValue([template({ appearance: { opacity: 0.25 } })])
        return false
      }
      return true
    })
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    byText(menu(), 'Dot').click()
    byKey('swatch:1').click()
    release()
    await settle()

    // Only the colour was clicked, so only the colour may change.
    expect(appearanceWritten(1)).toMatchObject({ opacity: 0.25, hiddenColours: [1] })
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

    expect(errorText()).toContain('Could not change shape')
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

    expect((document.activeElement as HTMLElement | null)?.dataset.wtsControl).toBe('swatch:5')
  })

  it('moves focus into the menu when it opens', () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()

    gear('a').click()
    rerender()

    expect((document.activeElement as HTMLElement | null)?.dataset.wtsControl).toBe('hide')
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

  it('moves focus on an arrow key without committing a write', async () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    byKey('Shape:full').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    )
    await settle()

    // `shape` is in the stamped-tile cache key, so selection-follows-focus at OS key repeat would
    // re-stamp the viewport at scale 3 once per repeat.
    expect(document.activeElement).toBe(byKey('Shape:square'))
    expect(harness.setAppearance).not.toHaveBeenCalled()

    byKey('Shape:square').click()
    await settle()

    expect(appearanceWritten(0).shape).toBe('square')
  })

  it('does not contradict its own label on the hide toggle', async () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    byKey('hide').click()
    await settle()
    harness.localTemplates.mockReturnValue([template({ visible: false })])
    rerender()

    const hide = byKey('hide')
    expect(hide.getAttribute('aria-label')).toBe('Show this overlay')
    // "Show this overlay, pressed" reads as though showing were already on.
    expect(hide.hasAttribute('aria-pressed')).toBe(false)
  })

  it('keeps a hidden overlay’s controls only while its own menu is open', () => {
    harness.localTemplates.mockReturnValue([template(), template({ id: 'b', visible: false })])
    rerender()

    // A hidden overlay draws nothing, so its gear is a hole in the map with nothing to explain it.
    expect(document.getElementById('wts-overlay-button-b')).toBeNull()
    expect(document.getElementById('wts-overlay-button-a')).not.toBeNull()
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

    // The previewed origin, not the durable one. The far corner is derived from the scale rather
    // than projected again, so the two calls cannot resolve to different wrapped world copies.
    expect(harness.screenPointFor).toHaveBeenCalledWith(500, 600)
    expect(harness.screenPointFor).not.toHaveBeenCalledWith(0, 0)
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

describe('deferred work stays tied to the template that asked for it', () => {
  const twoTemplates = () => [template(), template({ id: 'b', name: 'beta.png' })]

  it('does not carry a delete question into another template’s menu', () => {
    harness.localTemplates.mockReturnValue(twoTemplates())
    rerender()
    gear('a').click()
    rerender()
    byKey('delete').click()

    gear('b').click()
    rerender()

    // Its Delete button still closes over template A. Under B's heading, that deletes the wrong one.
    expect(menu().querySelector('[data-wts-confirm]')).toBeNull()
  })

  it('does not carry a failure into another template’s menu', async () => {
    harness.localTemplates.mockReturnValue(twoTemplates())
    harness.setLocalVisible.mockResolvedValue(false)
    rerender()
    gear('a').click()
    rerender()
    byKey('hide').click()
    await settle()
    expect(errorText()).toContain('Could not change')

    gear('b').click()
    rerender()

    expect(errorText()).toBeNull()
  })

  it('reports a late failure only while its own menu is open', async () => {
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    harness.setLocalVisible.mockImplementation(async () => {
      await held
      return false
    })
    harness.localTemplates.mockReturnValue(twoTemplates())
    rerender()
    gear('a').click()
    rerender()
    byKey('hide').click()

    gear('b').click()
    rerender()
    release()
    await settle()

    // "Could not change visibility for alpha.png" under beta.png's heading is worse than silence.
    expect(errorText()).toBeNull()
  })

  it('does not close another template’s menu when a delete completes', async () => {
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    harness.removeLocalTemplate.mockImplementation(async () => {
      await held
      return true
    })
    harness.localTemplates.mockReturnValue(twoTemplates())
    rerender()
    gear('a').click()
    rerender()
    byKey('delete').click()
    byKey('confirm-delete').click()

    gear('b').click()
    rerender()
    release()
    await settle()

    expect(document.getElementById('wts-overlay-menu')).not.toBeNull()
    expect(menu().dataset.wtsTemplate).toBe('b')
  })

  it('stops offering Cancel once the delete is under way', () => {
    harness.removeLocalTemplate.mockImplementation(() => new Promise<boolean>(() => {}))
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    byKey('delete').click()
    byKey('confirm-delete').click()

    // A live Cancel takes the question away and reads as though it stopped something.
    const cancel = byText(menu(), 'Cancel')
    expect(cancel.disabled).toBe(true)
  })

  it('keeps a carried delete question naming the template as it is now', () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    byKey('delete').click()

    harness.localTemplates.mockReturnValue([template({ name: 'renamed.png' })])
    rerender()

    expect(menu().querySelector('[data-wts-confirm]')?.textContent).toContain('renamed.png')
  })

  it('lets the latest visibility request own the intent through an ABA sequence', async () => {
    const settled: Array<() => void> = []
    harness.setLocalVisible.mockImplementation(
      async () =>
        await new Promise<boolean>((resolve) => {
          settled.push(() => resolve(true))
        }),
    )
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    byKey('hide').click() // hide
    byKey('hide').click() // show
    byKey('hide').click() // hide
    settled[0]?.()
    await settle()

    // The first request's `false` matches the third's, so releasing intent by value would hand
    // ownership back to the store and the menu would flip to "Hide" while a hide is still pending.
    expect(harness.setLocalVisible.mock.calls[0]?.[1]).toBe(false)
    expect(byKey('hide').getAttribute('aria-label')).toBe('Show this overlay')
  })

  it('keeps a refused shape reported when a colour change succeeds', async () => {
    let call = 0
    harness.setAppearance.mockImplementation(async () => (++call === 1 ? false : true))
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    byText(menu(), 'Dot').click()
    byKey('swatch:1').click()
    await settle()

    // The colour landed and the shape did not. One shared `appearance` bucket would let the
    // colour's success clear the shape's banner, and the overlay ends up Full with nothing said.
    expect(errorText()).toContain('Could not change shape')
    expect(byKey('Shape:full').getAttribute('aria-checked')).toBe('true')
  })

  it('clears a refused write once the same property succeeds', async () => {
    let call = 0
    harness.setAppearance.mockImplementation(async () => (++call === 1 ? false : true))
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    byText(menu(), 'Dot').click()
    await settle()
    expect(errorText()).toContain('Could not change shape')
    byText(menu(), 'Corner').click()
    await settle()

    expect(errorText()).toBeNull()
  })

  it('puts a refused slider back where the store still is', async () => {
    harness.setAppearance.mockResolvedValue(false)
    harness.localTemplates.mockReturnValue([template({ appearance: { opacity: 0.4 } })])
    rerender()
    gear('a').click()
    rerender()
    const opacity = byKey('opacity') as HTMLInputElement

    // Focused, but the gesture is over: `change` has fired. Guarding the refresh on focus rather
    // than on an in-progress gesture leaves the refused value sitting on the thumb indefinitely.
    opacity.focus()
    opacity.dispatchEvent(new Event('pointerdown'))
    opacity.value = '0.9'
    opacity.dispatchEvent(new Event('change'))
    await settle()

    // The map reverted; a thumb left at the refused value says the change took. Re-queried
    // because the refusal is state, so the menu is rebuilt from it rather than patched.
    expect((byKey('opacity') as HTMLInputElement).value).toBe('0.4')
  })
})

describe('focus goes somewhere deliberate', () => {
  it('returns to the gear when the menu is closed', () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    byKey('close').click()
    rerender()

    expect(document.activeElement).toBe(gear('a'))
  })

  it('returns to Delete when the question is cancelled', () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    byKey('delete').click()

    byText(menu(), 'Cancel').click()
    rerender()

    expect((document.activeElement as HTMLElement | null)?.dataset.wtsControl).toBe('delete')
  })

  it('announces the destructive question rather than a bare Delete', () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    byKey('delete').click()

    const box = menu().querySelector('[data-wts-confirm]')
    expect(box?.getAttribute('role')).toBe('alertdialog')
    expect(box?.getAttribute('aria-label')).toContain('This cannot be undone')
  })
})

describe('an outcome is reported whatever else has happened since', () => {
  it('still reports a refused write after an unrelated later click', async () => {
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    harness.setLocalVisible.mockImplementation(async () => {
      await held
      return false
    })
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    byKey('hide').click()
    // Anything at all, while the hide is still in flight.
    byText(menu(), 'Dot').click()
    release()
    await settle()

    // Tying the report to "am I still the latest request" makes any second click silence the first
    // one's failure, which is the whole guarantee this menu exists to keep.
    expect(errorText()).toContain('Could not change visibility')
  })

  it('keeps a refused write reported while a different field succeeds', async () => {
    harness.setLocalVisible.mockResolvedValue(false)
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    byKey('hide').click()
    await settle()
    byText(menu(), 'Dot').click()
    await settle()

    // A successful colour or shape change says nothing about a refused hide.
    expect(errorText()).toContain('Could not change visibility')
  })

  it('clears a refused write once the same field succeeds', async () => {
    let call = 0
    harness.setLocalVisible.mockImplementation(async () => ++call !== 1)
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    byKey('hide').click()
    await settle()
    expect(errorText()).toContain('Could not change visibility')
    byKey('hide').click()
    await settle()

    expect(errorText()).toBeNull()
  })

  it('reports a write that threw rather than stranding the intent', async () => {
    harness.setAppearance.mockRejectedValue(new Error('IndexedDB is gone'))
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    byText(menu(), 'Dot').click()
    await settle()

    expect(errorText()).toContain('Could not change shape')
    // Intent released: the menu must not keep asserting a shape that was never saved.
    expect(byKey('Shape:full').getAttribute('aria-checked')).toBe('true')
  })

  it('reports a refusal that arrived while the template was off screen', async () => {
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    harness.setLocalVisible.mockImplementation(async () => {
      await held
      return false
    })
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    byKey('hide').click()

    // Pan the template out of view, let the refusal land, pan back.
    harness.localTemplates.mockReturnValue([template({ originX: 50_000, originY: 50_000 })])
    rerender()
    release()
    await settle()
    harness.localTemplates.mockReturnValue([template()])
    rerender()

    expect(errorText()).toContain('Could not change visibility')
  })
})

describe('a frame without a map is not a frame without templates', () => {
  it('keeps pending work when the map canvas is transiently detached', async () => {
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    harness.setLocalVisible.mockImplementation(async () => {
      await held
      return false
    })
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    byKey('hide').click()

    // MapLibre detaches and re-attaches its own canvas; `main.ts` has a test for exactly that.
    const host = mapCanvas.parentElement
    mapCanvas.remove()
    rerender()
    host?.appendChild(mapCanvas)
    rerender()
    release()
    await settle()

    // Treating a missing map as "every template ceased to exist" throws away write ordering and
    // every pending outcome for templates that are all still there.
    expect(errorText()).toContain('Could not change visibility')
  })

  it('forgets a template that has actually gone', async () => {
    harness.setLocalVisible.mockResolvedValue(false)
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    byKey('hide').click()
    await settle()
    expect(errorText()).toContain('Could not change visibility')

    harness.localTemplates.mockReturnValue([])
    rerender()
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    expect(errorText()).toBeNull()
  })
})

describe('a delete already under way cannot be re-asked', () => {
  it('will not raise a fresh question over a running delete', () => {
    harness.removeLocalTemplate.mockImplementation(() => new Promise<boolean>(() => {}))
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    byKey('delete').click()
    rerender()
    byKey('confirm-delete').click()
    rerender()

    // Disabling the question's own buttons is not enough while this one can raise a new question
    // with a fresh, live Cancel over a delete that is already running.
    expect((byKey('delete') as HTMLButtonElement).disabled).toBe(true)
    expect((byKey('cancel-delete') as HTMLButtonElement).disabled).toBe(true)
    expect(byKey('confirm-delete').textContent).toBe('Deleting…')
  })

  it('names the template as it is now, however the menu was rebuilt', () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    byKey('delete').click()
    rerender()

    harness.localTemplates.mockReturnValue([template({ name: 'renamed.png' })])
    rerender()

    // The question is rebuilt from state, so it cannot disagree with the heading above it.
    expect(menu().querySelector('[data-wts-confirm]')?.textContent).toContain('renamed.png')
  })
})

describe('the slider is only frozen while a gesture is actually in progress', () => {
  it('releases a press that never became a change', () => {
    harness.localTemplates.mockReturnValue([template({ appearance: { opacity: 0.4 } })])
    rerender()
    gear('a').click()
    rerender()
    const opacity = byKey('opacity') as HTMLInputElement

    // Click the thumb without moving it: no `change` fires, and a range input keeps focus.
    opacity.dispatchEvent(new Event('pointerdown'))
    opacity.dispatchEvent(new Event('pointerup'))
    harness.localTemplates.mockReturnValue([template({ appearance: { opacity: 0.9 } })])
    rerender()

    expect((byKey('opacity') as HTMLInputElement).value).toBe('0.9')
  })

  it('offers the whole 0..1 range the store accepts', () => {
    // `normaliseAppearance` runs on a conflict's remote winner, so another client's 0 arrives here.
    harness.localTemplates.mockReturnValue([template({ appearance: { opacity: 0 } })])
    rerender()
    gear('a').click()
    rerender()

    const opacity = byKey('opacity') as HTMLInputElement
    expect(opacity.min).toBe('0')
    expect(opacity.value).toBe('0')
  })

  it('represents the default size exactly rather than snapping off it', () => {
    harness.localTemplates.mockReturnValue([template({ appearance: { shape: 'circle' } })])
    rerender()
    gear('a').click()
    rerender()

    // A stepped grid of 0.05 from 0.1 excludes 1/3, so the browser snaps the thumb to 0.35 while
    // the readout still says 33% — and refreshSliders then rewrites it on every frame.
    expect(Number((byKey('size') as HTMLInputElement).value)).toBe(1 / 3)
  })
})

describe('the menu is ours and has a keyboard exit', () => {
  it('ignores an element the page planted under the menu id', () => {
    const impostor = document.createElement('div')
    impostor.id = 'wts-overlay-menu'
    document.body.appendChild(impostor)
    harness.localTemplates.mockReturnValue([template()])
    rerender()

    gear('a').click()
    rerender()

    // getElementById returns the first match in document order, so the page's node would win and
    // the real menu would be torn down and rebuilt on every frame.
    const built = [...document.querySelectorAll('#wts-overlay-menu')].filter(
      (el) => el !== impostor,
    )
    expect(built).toHaveLength(1)
    expect(built[0]?.getAttribute('role')).toBe('dialog')
  })

  it('closes on Escape and hands focus back to the gear', () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    byKey('hide').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    rerender()

    expect(document.getElementById('wts-overlay-menu')).toBeNull()
    expect(document.activeElement).toBe(gear('a'))
  })

  it('returns focus to the gear when Move takes over the canvas', () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    byKey('move').click()
    rerender()

    expect(harness.beginMove).toHaveBeenCalledWith('a', expect.any(Function))
    expect(document.activeElement).toBe(gear('a'))
  })
})

describe('a delete under way owns the template', () => {
  it('does not queue the delete behind this menu’s own writes', () => {
    // `removeLocalTemplate` sets the store's terminal guard synchronously; that is what stops an
    // in-flight save resurrecting the record. Queueing it behind a slow visibility write means the
    // guard is not set until the bitmaps finish.
    harness.setLocalVisible.mockImplementation(() => new Promise<boolean>(() => {}))
    harness.removeLocalTemplate.mockImplementation(() => new Promise<boolean>(() => {}))
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    byKey('hide').click()
    rerender()
    byKey('delete').click()
    rerender()
    byKey('confirm-delete').click()

    expect(harness.removeLocalTemplate).toHaveBeenCalledWith('a')
  })

  it('stops offering Move and Hide while the delete runs', () => {
    harness.removeLocalTemplate.mockImplementation(() => new Promise<boolean>(() => {}))
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    byKey('delete').click()
    rerender()
    byKey('confirm-delete').click()
    rerender()

    // Starting a placement for a record that is about to stop existing strands the placement bar.
    expect((byKey('move') as HTMLButtonElement).disabled).toBe(true)
    expect((byKey('hide') as HTMLButtonElement).disabled).toBe(true)
  })

  it('forgets a template deleted while it was off screen', async () => {
    harness.setLocalVisible.mockResolvedValue(false)
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    byKey('hide').click()
    await settle()

    // Panned out of view, so it no longer has a button — then deleted.
    harness.localTemplates.mockReturnValue([template({ originX: 50_000, originY: 50_000 })])
    rerender()
    harness.localTemplates.mockReturnValue([])
    rerender()
    // ...and a template with the same durable id comes back.
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    expect(errorText()).toBeNull()
  })
})

describe('interaction outranks a repaint', () => {
  it('does not replace the menu under an active slider drag', () => {
    harness.localTemplates.mockReturnValue([template({ appearance: { opacity: 0.4 } })])
    rerender()
    gear('a').click()
    rerender()
    const opacity = byKey('opacity') as HTMLInputElement
    opacity.dispatchEvent(new Event('pointerdown'))

    // Something rebuilds the menu mid-drag: a rename here, a refusal elsewhere.
    harness.localTemplates.mockReturnValue([
      template({ name: 'renamed.png', appearance: { opacity: 0.4 } }),
    ])
    rerender()

    // Replacing the range before it fires `change` loses the value the user was setting.
    expect(byKey('opacity')).toBe(opacity)
  })

  it('carries the tab stop with arrow-key focus', () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    byKey('Shape:full').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    )

    // Leaving the stop on the selected option makes Shift+Tab land back inside the group.
    expect((byKey('Shape:square') as HTMLButtonElement).tabIndex).toBe(0)
    expect((byKey('Shape:full') as HTMLButtonElement).tabIndex).toBe(-1)
  })

  it('keeps the keyboard across a transient map detach', () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    byKey('swatch:5').focus()

    const host = mapCanvas.parentElement
    mapCanvas.remove()
    rerender()
    host?.appendChild(mapCanvas)
    rerender()

    expect((document.activeElement as HTMLElement | null)?.dataset.wtsControl).toBe('swatch:5')
  })

  it('does not arm a focus jump when the question is already open', () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    byKey('delete').click()
    rerender()
    byKey('close').focus()

    byKey('delete').click()
    rerender()
    // An unrelated rebuild later on must not consume a leftover request and jump to Delete.
    harness.localTemplates.mockReturnValue([template({ name: 'renamed.png' })])
    rerender()

    expect((document.activeElement as HTMLElement | null)?.dataset.wtsControl).not.toBe(
      'confirm-delete',
    )
  })
})

describe('failure messages are resolved when they are shown', () => {
  it('names the template as it is at render time', async () => {
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    harness.setLocalVisible.mockImplementation(async () => {
      await held
      return false
    })
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    byKey('hide').click()

    harness.localTemplates.mockReturnValue([template({ name: 'renamed.png' })])
    rerender()
    release()
    await settle()

    expect(errorText()).toContain('renamed.png')
    expect(errorText()).not.toContain('alpha.png')
  })

  it('gives Move its own slot rather than the visibility one', async () => {
    harness.setLocalVisible.mockResolvedValue(false)
    harness.isMoving.mockReturnValue(true)
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    byKey('hide').click()
    await settle()
    byKey('move').click()
    rerender()

    const messages = [...menu().querySelectorAll('[data-wts-error]')].map((el) => el.textContent)
    expect(messages).toHaveLength(2)
    expect(messages.join(' ')).toContain('Could not change visibility')
    expect(messages.join(' ')).toContain('placement already in progress')
  })

  it('announces a failure once, not on every unrelated rebuild', async () => {
    harness.setLocalVisible.mockResolvedValue(false)
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    byKey('hide').click()
    await settle()
    expect(menu().querySelector('[data-wts-error]')?.getAttribute('role')).toBe('alert')

    byKey('swatch:1').click()
    await settle()

    // A rebuild reconstructs the node; a fresh role="alert" would read the old failure out again.
    expect(menu().querySelector('[data-wts-error]')?.hasAttribute('role')).toBe(false)
  })
})

describe('nothing is stranded by a held slider or a running delete', () => {
  it('draws a refusal that landed while the thumb was held', async () => {
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    harness.setLocalVisible.mockImplementation(async () => {
      await held
      return false
    })
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    byKey('hide').click()

    // Press and hold the thumb; the hold blocks rebuilds, so the refusal has nowhere to land.
    const opacity = byKey('opacity') as HTMLInputElement
    opacity.dispatchEvent(new Event('pointerdown'))
    release()
    await settle()
    expect(errorText()).toBeNull()

    // Letting go has to let it through: on a static map no other frame is coming.
    opacity.dispatchEvent(new Event('pointerup'))

    expect(errorText()).toContain('Could not change visibility')
  })

  it('clears the Move refusal once a placement actually starts', () => {
    harness.isMoving.mockReturnValue(true)
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    byKey('move').click()
    rerender()
    expect(errorText()).toContain('placement already in progress')

    harness.isMoving.mockReturnValue(false)
    harness.isDeletingLocal.mockReturnValue(false)
    byKey('move').click()
    rerender()
    gear('a').click()
    rerender()

    // Nothing else ever cleared this one, so it outlived the placement it was about.
    expect(errorText()).toBeNull()
  })

  it('re-announces a repeated Move refusal', () => {
    harness.isMoving.mockReturnValue(true)
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    byKey('move').click()
    rerender()
    expect(menu().querySelector('[data-wts-error]')?.getAttribute('role')).toBe('alert')
    byKey('move').click()
    rerender()

    // Announcing once is right for an unrelated rebuild. A deliberate repeat deserves an answer.
    expect(menu().querySelector('[data-wts-error]')?.getAttribute('role')).toBe('alert')
  })

  it('keeps focus on the confirm button once the delete starts', () => {
    harness.removeLocalTemplate.mockImplementation(() => new Promise<boolean>(() => {}))
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    byKey('delete').click()
    rerender()

    byKey('confirm-delete').click()
    rerender()

    // A `disabled` button cannot hold focus, so confirming from the keyboard would drop it to the
    // document at the exact moment a destructive action is running.
    expect((document.activeElement as HTMLElement | null)?.dataset.wtsControl).toBe(
      'confirm-delete',
    )
    expect(byKey('confirm-delete').getAttribute('aria-disabled')).toBe('true')
  })

  it('stops offering the appearance controls while the delete runs', () => {
    harness.removeLocalTemplate.mockImplementation(() => new Promise<boolean>(() => {}))
    harness.localTemplates.mockReturnValue([template({ appearance: { shape: 'circle' } })])
    rerender()
    gear('a').click()
    rerender()
    byKey('delete').click()
    rerender()
    byKey('confirm-delete').click()
    rerender()

    // The store refuses these anyway, leaving a meaningless banner beside "Deleting…".
    expect((byKey('Shape:full') as HTMLButtonElement).disabled).toBe(true)
    expect((byKey('opacity') as HTMLInputElement).disabled).toBe(true)
    expect((byKey('swatch:1') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('the delete question is retracted by the gestures that dismiss it', () => {
  it('does not come back armed after the menu is closed', () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    byKey('delete').click()
    rerender()

    byKey('close').click()
    rerender()
    gear('a').click()
    rerender()

    expect(menu().querySelector('[data-wts-confirm]')).toBeNull()
  })

  it('answers the question before the menu on Escape', () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    byKey('delete').click()
    rerender()

    byKey('confirm-delete').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
    rerender()

    // Escape answers the innermost dialog, not the one around it.
    expect(document.getElementById('wts-overlay-menu')).not.toBeNull()
    expect(menu().querySelector('[data-wts-confirm]')).toBeNull()
  })
})

describe('an edit carries the change, not a resolved snapshot', () => {
  it('applies a colour toggle to whatever the store holds at dispatch', async () => {
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let call = 0
    harness.setAppearance.mockImplementation(async () => {
      if (++call === 1) {
        await held
        // Reconciliation installs another client's colour filter.
        harness.localTemplates.mockReturnValue([template({ appearance: { hiddenColours: [5] } })])
        return false
      }
      return true
    })
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    byKey('swatch:1').click()
    byKey('swatch:2').click()
    release()
    await settle()

    // Carrying the resolved array would put colour 5 back on and apply colour 1 anyway, even though
    // its own write was refused.
    expect(appearanceWritten(1).hiddenColours).toEqual([5, 2])
  })

  it('releases a refused property without waiting for an unrelated queued write', async () => {
    harness.setAppearance.mockResolvedValue(false)
    harness.setLocalVisible.mockImplementation(() => new Promise<boolean>(() => {}))
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    byText(menu(), 'Dot').click()
    byKey('hide').click()
    await settle()

    // One shared intent, released only by its latest owner, keeps asserting the refused shape for
    // as long as the visibility write is outstanding — and that one never resolves.
    expect(byKey('Shape:full').getAttribute('aria-checked')).toBe('true')
    expect(errorText()).toContain('Could not change shape')
  })

  it('names the property a refusal is about', async () => {
    harness.setAppearance.mockResolvedValue(false)
    harness.localTemplates.mockReturnValue([template({ appearance: { shape: 'circle' } })])
    rerender()
    gear('a').click()
    rerender()

    byText(menu(), 'Full').click()
    await settle()
    const size = byKey('size') as HTMLInputElement
    size.value = '0.5'
    size.dispatchEvent(new Event('change'))
    await settle()

    const messages = [...menu().querySelectorAll('[data-wts-error]')].map((el) => el.textContent)
    expect(messages.join(' ')).toContain('shape')
    expect(messages.join(' ')).toContain('size')
  })
})

describe('a real gesture commits what the user chose', () => {
  it('writes the value the thumb ended on, not the one the repaint restored', async () => {
    harness.localTemplates.mockReturnValue([template({ appearance: { opacity: 0.4 } })])
    rerender()
    gear('a').click()
    rerender()

    const opacity = byKey('opacity') as HTMLInputElement
    opacity.dispatchEvent(new Event('pointerdown'))
    opacity.value = '0.9'
    opacity.dispatchEvent(new Event('change'))
    await settle()

    // Releasing the hold repaints, and the repaint puts the stored value back into this very input.
    // Reading after that commits the value the user just dragged away from.
    expect(appearanceWritten(0).opacity).toBe(0.9)
  })

  it('keeps one refused colour reported when a different colour succeeds', async () => {
    let call = 0
    harness.setAppearance.mockImplementation(async () => ++call !== 1)
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    byKey('swatch:1').click()
    byKey('swatch:2').click()
    await settle()

    // One shared `hiddenColours` key lets the second swatch's success clear the first's failure.
    expect(errorText()).toContain('Could not change')
  })
})

describe('a delete owns the template whichever surface started it', () => {
  it('refuses Move for a template the store has already condemned', () => {
    harness.isDeletingLocal.mockReturnValue(true)
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    // The panel's delete sets the store's terminal guard and then does its IndexedDB work with the
    // record still present. Reading only our own flag starts a placement for a doomed template.
    expect((byKey('move') as HTMLButtonElement).disabled).toBe(true)
    expect((byKey('delete') as HTMLButtonElement).disabled).toBe(true)
  })

  it('keeps the progress box when the menu is closed mid-delete', () => {
    harness.removeLocalTemplate.mockImplementation(() => new Promise<boolean>(() => {}))
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    byKey('delete').click()
    rerender()
    byKey('confirm-delete').click()
    rerender()

    byKey('close').click()
    rerender()
    gear('a').click()
    rerender()

    // Without it the controls are all disabled with nothing on screen explaining why.
    expect(menu().querySelector('[data-wts-confirm]')).not.toBeNull()
  })

  it('opens onto a control that can take focus while a delete runs', () => {
    harness.isDeletingLocal.mockReturnValue(true)
    harness.localTemplates.mockReturnValue([template()])
    rerender()

    gear('a').click()
    rerender()

    // Hide is disabled during a delete, and a disabled control cannot hold focus.
    expect((document.activeElement as HTMLElement | null)?.dataset.wtsControl).toBe('close')
  })

  it('forgets a template deleted while the map was detached', () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    byKey('delete').click()
    rerender()

    const host = mapCanvas.parentElement
    mapCanvas.remove()
    harness.localTemplates.mockReturnValue([])
    rerender()
    // A template with the same durable id comes back.
    harness.localTemplates.mockReturnValue([template()])
    host?.appendChild(mapCanvas)
    rerender()
    gear('a').click()
    rerender()

    // The old question must not be handed to the new lifetime.
    expect(menu().querySelector('[data-wts-confirm]')).toBeNull()
  })
})

describe('a transient detach costs nothing', () => {
  it('restores a value the drag had reached', () => {
    harness.localTemplates.mockReturnValue([template({ appearance: { opacity: 0.4 } })])
    rerender()
    gear('a').click()
    rerender()
    const opacity = byKey('opacity') as HTMLInputElement
    opacity.dispatchEvent(new Event('pointerdown'))
    opacity.value = '0.85'

    const host = mapCanvas.parentElement
    mapCanvas.remove()
    rerender()
    host?.appendChild(mapCanvas)
    rerender()

    expect((byKey('opacity') as HTMLInputElement).value).toBe('0.85')
  })

  it('keeps focus that was on a gear rather than in the menu', () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').focus()

    const host = mapCanvas.parentElement
    mapCanvas.remove()
    rerender()
    host?.appendChild(mapCanvas)
    rerender()

    expect(document.activeElement).toBe(gear('a'))
  })

  it('retires a Move refusal once the placement it was about ends', () => {
    harness.isMoving.mockReturnValue(true)
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    byKey('move').click()
    rerender()
    expect(errorText()).toContain('placement already in progress')

    // The other template's placement finishes; nobody pressed Move again.
    harness.isMoving.mockReturnValue(false)
    rerender()

    expect(errorText()).toBeNull()
  })
})
