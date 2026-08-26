// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { type Appearance, DEFAULT_APPEARANCE } from '../templates/appearance.js'
import { icon } from './icons.js'
import { CLEAR_OF_RAIL, GAP, RAIL_BUTTON } from './metrics.js'
import { PANEL_ID } from './toast.js'

const harness = vi.hoisted(() => ({
  // Flips `isMoving`, as the real one does the instant it returns — without this every Move test
  // runs against a state production never produces, and the rule that the keyboard belongs to a
  // running placement cannot be observed at all.
  beginMove: vi.fn((id: string, _finished: () => void) => {
    harness.isMoving.mockReturnValue(true)
    harness.movingId.mockReturnValue(id)
    // Counted as production counts it: the same template placed twice is two placements.
    harness.placementSeq.mockReturnValue((harness.placementSeq() ?? 0) + 1)
  }),
  beginServerMove: vi.fn((id: string, _finished: () => void, _persist: unknown) => {
    harness.isMoving.mockReturnValue(true)
    harness.movingId.mockReturnValue(id)
    harness.placementSeq.mockReturnValue((harness.placementSeq() ?? 0) + 1)
    return true
  }),
  placementSeq: vi.fn(() => null as number | null),
  isMoving: vi.fn(() => false),
  isFinishing: vi.fn(() => false),
  alreadyAnswered: vi.fn((_event: KeyboardEvent) => false),
  movingId: vi.fn(() => null as string | null),
  abortMove: vi.fn(async () => {}),
  commitMove: vi.fn(async () => {}),
  localTemplates: vi.fn(() => [] as unknown[]),
  previewOriginFor: vi.fn(() => null as { x: number; y: number } | null),
  removeTreeStateKeys: vi.fn(),
  isDeletingLocal: vi.fn((_id: string) => false),
  isTemplateVisible: vi.fn((template: { visible: boolean }) => template.visible),
  removeLocalTemplate: vi.fn(async (_id: string) => true),
  forgetServerTemplate: vi.fn(async (_id: string) => {}),
  deleteServerTemplate: vi.fn(async () => ({ ok: true as const })),
  listServerContents: vi.fn(async () => null),
  uploadTemplateVersion: vi.fn(async () => ({ ok: true as const, versionId: 'version-2' })),
  templateAsPng: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
  servers: [] as Array<{
    url: string
    isAdmin: boolean
    token: string | null
    status: 'connected'
    season: number
    info: { id: string; name: string; auth: 'access_token' }
  }>,
  serverTemplates: [] as Array<{
    id: string
    published: boolean
    version: string
    updatedAt: number
  }>,
  // A projection, not a constant: the module derives the overlay's on-screen box from one
  // projected corner plus the scale, and a constant would make every template a zero-size point.
  screenPointFor: vi.fn((x: number, y: number) => ({ x, y }) as { x: number; y: number } | null),
  cssPixelsPerCanvasPixel: vi.fn(() => ({ x: 1, y: 1 })),
  setAppearance: vi.fn(async (_id: string, _appearance: Appearance) => true),
  setLocalVisible: vi.fn(async (_id: string, _visible: boolean) => true),
  setOwnsGroup: vi.fn(async () => true),
  ownsGroup: vi.fn(() => true),
  appearanceOf: vi.fn((template: { appearance: Appearance }) => template.appearance),
  setAppearancePreview: vi.fn(),
  clearAppearancePreview: vi.fn(),
}))

vi.mock('../debug.js', () => ({ log: vi.fn(), warn: vi.fn() }))
vi.mock('../main.js', () => ({
  cssPixelsPerCanvasPixel: harness.cssPixelsPerCanvasPixel,
  screenProjection: () => ({
    pointFor: (x: number, y: number) => harness.screenPointFor(x, y),
    pixelsPerCanvasPixel: harness.cssPixelsPerCanvasPixel(),
  }),
  screenPointFor: harness.screenPointFor,
}))
vi.mock('../state.js', () => ({
  admittedServerContentsFor: () => ({ nodes: [], templates: harness.serverTemplates }),
  deleteTemplate: harness.deleteServerTemplate,
  getState: () => ({
    hiddenColours: [],
    onlySelectedColour: false,
    servers: harness.servers,
  }),
  listServerContents: harness.listServerContents,
  removeTreeStateKeys: harness.removeTreeStateKeys,
  setState: vi.fn(),
  uploadTemplateVersion: harness.uploadTemplateVersion,
}))
vi.mock('../templates/local-store.js', () => ({
  appearanceOf: harness.appearanceOf,
  forgetServerTemplate: harness.forgetServerTemplate,
  isDeletingLocal: harness.isDeletingLocal,
  isServerTemplate: (template: { serverUrl?: string }) => template.serverUrl !== undefined,
  isTemplateVisible: harness.isTemplateVisible,
  localTemplates: harness.localTemplates,
  ownsGroup: harness.ownsGroup,
  previewOriginFor: harness.previewOriginFor,
  removeLocalTemplate: harness.removeLocalTemplate,
  setAppearance: harness.setAppearance,
  setLocalVisible: harness.setLocalVisible,
  setOwnsGroup: harness.setOwnsGroup,
  templateById: (id: string) =>
    (harness.localTemplates() as Array<{ id: string }>).find((template) => template.id === id),
  templateAsPng: harness.templateAsPng,
}))
vi.mock('../templates/appearance-preview.js', () => ({
  clearAppearancePreview: harness.clearAppearancePreview,
  setAppearancePreview: harness.setAppearancePreview,
}))
vi.mock('../templates/move.js', () => ({
  abort: harness.abortMove,
  beginMove: harness.beginMove,
  beginServerMove: harness.beginServerMove,
  commit: harness.commitMove,
  isFinishing: harness.isFinishing,
  placementSeq: harness.placementSeq,
  alreadyAnswered: harness.alreadyAnswered,
  isMoving: harness.isMoving,
  movingId: harness.movingId,
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
  serverUrl?: string
  serverTemplateId?: string
  serverVersion?: string
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
  ...(overrides.serverUrl === undefined
    ? {}
    : {
        serverUrl: overrides.serverUrl,
        serverTemplateId: overrides.serverTemplateId ?? 'remote-a',
        serverVersion: overrides.serverVersion ?? 'version-1',
      }),
})

const connectServerTemplate = (published: boolean, isAdmin = true): void => {
  harness.servers.push({
    url: 'https://example.test',
    isAdmin,
    token: 'token',
    status: 'connected',
    season: 1,
    info: { id: 'server-1', name: 'Example', auth: 'access_token' },
  })
  harness.serverTemplates.push({
    id: 'remote-a',
    published,
    version: 'version-1',
    updatedAt: 1,
  })
}

/** Flush the microtask queue, however many turns the store's continuation chain actually takes. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const gear = (id: string): HTMLButtonElement => {
  const button = document.getElementById(`caelestis-overlay-button-${id}`)
  if (button === null) throw new Error(`no gear button for ${id}`)
  return button as HTMLButtonElement
}

const floatingPosition = (element: HTMLElement): { x: number; y: number } => {
  return { x: Number.parseFloat(element.style.left), y: Number.parseFloat(element.style.top) }
}

const menu = (): HTMLElement => {
  const el = document.getElementById('caelestis-overlay-menu')
  if (el === null) throw new Error('no overlay menu')
  return el
}

const byKey = (key: string): HTMLElement => {
  const el = document.querySelector(`[data-caelestis-control="${key}"]`)
  if (el === null) throw new Error(`no control keyed ${key}`)
  return el as HTMLElement
}

const pixelPreset = (id: 'small' | 'full' | 'corner'): HTMLButtonElement => {
  const el = menu().querySelector(`[data-caelestis-pixel-preset="${id}"]`)
  if (!(el instanceof HTMLButtonElement)) throw new Error(`no ${id} pixel preset`)
  return el
}

const byText = (root: ParentNode, text: string): HTMLButtonElement => {
  const el = [...root.querySelectorAll('button')].find((node) => node.textContent === text)
  if (el === undefined) throw new Error(`no button reading ${text}`)
  return el as HTMLButtonElement
}

/** A pointer drag, in the order a browser fires it: press, input, release, then change. */
const drag = (input: HTMLInputElement, to: string): void => {
  input.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1 }))
  input.value = to
  input.dispatchEvent(new Event('input'))
  input.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }))
  input.dispatchEvent(new Event('change'))
}

/** Choose a corner-rounding value through #65's deformable-pixel control. */
const setRadius = (to = '1'): void => drag(byKey('radius') as HTMLInputElement, to)

const errorText = (): string | null =>
  menu().querySelector('[data-caelestis-error]')?.textContent ?? null

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

const measuresAsZero = Element.prototype.getBoundingClientRect

afterEach(() => {
  // Whatever a test taught the DOM about its own size is that test's, not the next one's.
  Element.prototype.getBoundingClientRect = measuresAsZero
  // Close anything still open *before* discarding the module: an open menu holds a window-level
  // Escape listener, and a discarded instance's listener keeps firing against stale state.
  const open = document.getElementById('caelestis-overlay-menu')
  const close = open?.querySelector('[data-caelestis-control="close"]')
  if (close instanceof HTMLElement) close.click()
  vi.resetModules()
  vi.clearAllMocks()
  harness.localTemplates.mockReturnValue([])
  harness.servers.length = 0
  harness.serverTemplates.length = 0
  harness.previewOriginFor.mockReturnValue(null)
  harness.screenPointFor.mockImplementation((x: number, y: number) => ({ x, y }))
  harness.cssPixelsPerCanvasPixel.mockReturnValue({ x: 1, y: 1 })
  harness.isMoving.mockReturnValue(false)
  harness.isFinishing.mockReturnValue(false)
  harness.alreadyAnswered.mockReturnValue(false)
  harness.movingId.mockReturnValue(null)
  harness.placementSeq.mockReturnValue(null)
  harness.isDeletingLocal.mockReturnValue(false)
  harness.isTemplateVisible.mockImplementation((template: { visible: boolean }) => template.visible)
  harness.removeLocalTemplate.mockResolvedValue(true)
  harness.setAppearance.mockImplementation(async () => true)
  harness.setLocalVisible.mockResolvedValue(true)
})

describe('the open menu tracks intended state, not a snapshot and not a lagging store', () => {
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

    setRadius()
    rerender()
    byKey('swatch:1').click()
    release()
    await settle()

    // The second write must carry the first one's shape, not put it back to `full`.
    expect(appearanceWritten(1)).toMatchObject({ radius: 1, hiddenColours: [1] })
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

    setRadius()
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

  it('removes the local controls when hidden and restores only the kebab when shown elsewhere', async () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    byKey('hide').click()
    await settle()
    harness.localTemplates.mockReturnValue([template({ visible: false })])
    rerender()
    expect(document.getElementById('caelestis-overlay-button-a')).toBeNull()
    expect(document.getElementById('caelestis-overlay-menu')).toBeNull()
    expect(document.querySelector('[data-caelestis-rail-action]')).toBeNull()

    harness.localTemplates.mockReturnValue([template()])
    rerender()

    expect(gear('a')).toBeInstanceOf(HTMLButtonElement)
    expect(document.getElementById('caelestis-overlay-menu')).toBeNull()
    expect(harness.setLocalVisible).toHaveBeenCalledOnce()
    expect(harness.setLocalVisible).toHaveBeenCalledWith('a', false)
  })

  it('removes controls when a visible template is inside a hidden ancestor folder', () => {
    const child = template({
      serverUrl: 'https://example.test',
      serverTemplateId: 'remote-a',
    })
    harness.localTemplates.mockReturnValue([child])

    rerender()
    gear('a').click()
    rerender()
    expect(document.getElementById('caelestis-overlay-menu')).not.toBeNull()

    harness.isTemplateVisible.mockReturnValue(false)
    rerender()

    expect(child.visible).toBe(true)
    expect(document.getElementById('caelestis-overlay-button-a')).toBeNull()
    expect(document.getElementById('caelestis-overlay-menu')).toBeNull()
    expect(document.querySelector('[data-caelestis-rail-action]')).toBeNull()
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
    const before = byKey('opacity') as HTMLInputElement
    before.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1 }))

    harness.localTemplates.mockReturnValue([template({ appearance: { opacity: 0.45 } })])
    rerender()

    // The element is not replaced under the pointer; the value it holds is in `drafts` either way.
    expect(byKey('opacity')).toBe(before)
  })

  it('keeps the Mismatches Size track under the pointer on input', () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    const before = menu().querySelector<HTMLInputElement>(
      'input[type="range"]:not([data-caelestis-control])',
    )
    if (before === null) throw new Error('no Mismatches Size track')

    before.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1 }))
    before.value = '17'
    before.dispatchEvent(new Event('input'))

    expect(menu().querySelector('input[type="range"]:not([data-caelestis-control])')).toBe(before)
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
    opacity.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1 }))

    for (const value of ['0.5', '0.55', '0.6']) {
      opacity.value = value
      opacity.dispatchEvent(new Event('input'))
    }
    await settle()
    // Each of those used to be a durable write that also cleared the stamped-tile cache.
    expect(harness.setAppearance).not.toHaveBeenCalled()

    opacity.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }))
    await settle()

    expect(harness.setAppearance).toHaveBeenCalledTimes(1)
    expect(appearanceWritten(0).opacity).toBe(0.6)
  })
})

describe('controls are reconciled against the templates that exist', () => {
  it('closes the open menu of a template deleted elsewhere', () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    expect(document.getElementById('caelestis-overlay-menu')).not.toBeNull()

    harness.localTemplates.mockReturnValue([])
    rerender()

    expect(document.getElementById('caelestis-overlay-menu')).toBeNull()
  })

  it('strips every control when the map host is gone', () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    mapCanvas.remove()

    rerender()

    expect(document.getElementById('caelestis-overlay-button-a')).toBeNull()
    expect(document.getElementById('caelestis-overlay-menu')).toBeNull()
  })

  it('gives no control to a template that is entirely off screen', () => {
    // Projection succeeds for any coordinate, so nothing but an explicit box test stops every
    // template in the store from clamping a button onto the same viewport corner.
    harness.localTemplates.mockReturnValue([
      template(),
      template({ id: 'far', originX: 50_000, originY: 50_000 }),
    ])

    rerender()

    expect(document.getElementById('caelestis-overlay-button-a')).not.toBeNull()
    expect(document.getElementById('caelestis-overlay-button-far')).toBeNull()
  })

  it('drops the ordering key when the delete goes through', async () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    byKey('delete').click()
    byKey('confirm-delete').click()
    await settle()

    expect(harness.removeTreeStateKeys).toHaveBeenCalledWith(new Set(['local:a']))
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

    expect(document.getElementById('caelestis-overlay-menu')).not.toBeNull()
    expect(errorText()).toContain('Could not delete')
    expect(harness.removeTreeStateKeys).not.toHaveBeenCalled()
  })

  it('says so when Move is refused because a placement is already running', () => {
    harness.isMoving.mockReturnValue(true)
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    byKey('move').click()

    expect(harness.beginMove).not.toHaveBeenCalled()
    expect(document.getElementById('caelestis-overlay-menu')).not.toBeNull()
    expect(errorText()).toContain('placement already in progress')
  })
})

describe('a rebuild does not take the interaction with it', () => {
  it('keeps the keyboard where it was', () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    byKey('swatch:5').focus()

    harness.localTemplates.mockReturnValue([template({ name: 'renamed.png' })])
    rerender()

    expect((document.activeElement as HTMLElement | null)?.dataset.caelestisControl).toBe(
      'swatch:5',
    )
  })

  it('moves focus into the menu when it opens', () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()

    gear('a').click()
    rerender()

    expect((document.activeElement as HTMLElement | null)?.dataset.caelestisControl).toBe('hide')
  })
})

describe('the menu controls announce their state', () => {
  it('uses the rail-sized kebab trigger', () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()

    const button = gear('a')
    expect(button.classList.contains('btn-square')).toBe(true)
    expect(button.classList.contains('btn-xs')).toBe(false)
    expect(button.style.width).toBe(`${RAIL_BUTTON}px`)
    expect(button.style.height).toBe(`${RAIL_BUTTON}px`)
    expect(button.style.transform).toBe('')
    expect(button.style.willChange).toBe('')
    expect(button.querySelector('path')?.getAttribute('d')).toBe(
      icon('kebab').querySelector('path')?.getAttribute('d'),
    )
  })

  it('labels the hide action without announcing a contradictory toggle state', () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    const hide = byKey('hide')
    expect(hide.getAttribute('aria-label')).toBe('Hide this overlay')
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

  it('expands hide, move, and delete as rail-sized buttons outside the menu', () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    const actions = [...document.querySelectorAll('[data-caelestis-rail-action]')]
    expect(actions).toHaveLength(3)
    expect(menu().querySelector('[data-caelestis-rail-action]')).toBeNull()
    for (const action of actions) {
      expect(action).toBeInstanceOf(HTMLButtonElement)
      expect((action as HTMLElement).classList.contains('btn-square')).toBe(true)
      expect((action as HTMLElement).classList.contains('shadow-md')).toBe(true)
      expect((action as HTMLElement).classList.contains('relative')).toBe(true)
      expect((action as HTMLElement).classList.contains('btn-outline')).toBe(false)
      expect((action as HTMLElement).style.width).toBe(`${RAIL_BUTTON}px`)
      expect((action as HTMLElement).style.height).toBe(`${RAIL_BUTTON}px`)
      expect(floatingPosition(action as HTMLElement).x).toBe(floatingPosition(gear('a')).x)
    }
    expect(floatingPosition(actions[0] as HTMLElement).y).toBe(
      floatingPosition(gear('a')).y + RAIL_BUTTON + GAP,
    )

    gear('a').click()
    expect(document.querySelector('[data-caelestis-rail-action]')).toBeNull()
  })

  it('replaces the local menu rail with apply and cancel during its move', () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    const { x: left, y: top } = floatingPosition(gear('a'))
    gear('a').click()
    rerender()

    byKey('move').click()
    rerender()

    expect(document.getElementById('caelestis-overlay-button-a')).toBeNull()
    expect(document.getElementById('caelestis-overlay-menu')).toBeNull()
    expect(document.querySelector('[data-caelestis-rail-action]')).toBeNull()
    const apply = byKey('apply-move')
    const cancel = byKey('cancel-move')
    expect(floatingPosition(apply)).toEqual({ x: left, y: top })
    expect(floatingPosition(cancel)).toEqual({ x: left, y: top + RAIL_BUTTON + GAP })

    apply.click()
    expect(harness.commitMove).toHaveBeenCalledOnce()
    expect(harness.abortMove).not.toHaveBeenCalled()
  })

  it('cancels from the placement rail and restores the kebab after the move ends', () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    byKey('move').click()
    rerender()

    byKey('cancel-move').click()
    expect(harness.abortMove).toHaveBeenCalledOnce()

    harness.isMoving.mockReturnValue(false)
    harness.movingId.mockReturnValue(null)
    harness.placementSeq.mockReturnValue(null)
    rerender()
    expect(document.querySelector('[data-caelestis-placement-action]')).toBeNull()
    expect(gear('a')).toBeInstanceOf(HTMLButtonElement)
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

  /**
   * happy-dom measures everything as zero, so every clamp in this module is inert under test unless
   * the menu is given a size — which is why both placements below were wrong for the whole life of
   * this branch with a three-thousand-line suite over them. Patched on the prototype rather than on
   * the node, because the module measures during the build, before any test can reach the element.
   */
  const menuMeasures = (content: number | (() => number), width = 240): void => {
    Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
      const isMenu = this instanceof HTMLElement && this.dataset.caelestisSignature !== undefined
      // Honours whatever cap the module has just written, as a browser does. A stub returning a
      // fixed height makes measured and rendered identical by construction, which is the one thing
      // the placement arithmetic must not assume.
      const cap = isMenu ? this.style.maxHeight : ''
      const ceiling = cap.endsWith('vh')
        ? (window.innerHeight * Number.parseFloat(cap)) / 100
        : cap.endsWith('px')
          ? Number.parseFloat(cap)
          : Number.POSITIVE_INFINITY
      const styledWidth =
        isMenu && this.style.width.endsWith('px') ? Number.parseFloat(this.style.width) : width
      const naturalHeight = typeof content === 'function' ? content() : content
      const box = isMenu
        ? { width: styledWidth, height: Math.min(naturalHeight, ceiling) }
        : { width: 0, height: 0 }
      return {
        ...box,
        top: 0,
        left: 0,
        right: box.width,
        bottom: box.height,
        x: 0,
        y: 0,
      } as DOMRect
    }
  }

  it('keeps its trigger and menu clear of the right-hand button rail', () => {
    const restore = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { value: 800, configurable: true })
    onTestFinished(() => {
      Object.defineProperty(window, 'innerWidth', { value: restore, configurable: true })
    })
    menuMeasures(200, 240)
    harness.localTemplates.mockReturnValue([template({ originX: 795 })])
    rerender()
    gear('a').click()
    rerender()

    const railBoundary = window.innerWidth - CLEAR_OF_RAIL
    expect(floatingPosition(gear('a')).x + RAIL_BUTTON).toBeLessThanOrEqual(railBoundary)
    expect(Number.parseFloat(menu().style.left) + 240).toBeLessThanOrEqual(railBoundary)
    expect(Number.parseFloat(menu().style.left) + 240).toBeLessThan(floatingPosition(gear('a')).x)
  })

  it('remeasures the menu when an appearance group expands', () => {
    harness.ownsGroup.mockReturnValue(false)
    onTestFinished(() => {
      harness.ownsGroup.mockReturnValue(true)
    })
    menuMeasures(() =>
      byText(menu(), 'Pixels').getAttribute('aria-expanded') === 'true' ? 300 : 100,
    )
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    expect(menu().style.maxHeight).toBe('100px')

    byText(menu(), 'Pixels').click()

    expect(menu().style.maxHeight).toBe('300px')
  })

  it('keeps the local menu and both action rails clear of an open main panel', () => {
    const restore = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { value: 800, configurable: true })
    onTestFinished(() => {
      Object.defineProperty(window, 'innerWidth', { value: restore, configurable: true })
    })
    menuMeasures(200, 240)
    const panel = document.createElement('aside')
    panel.id = PANEL_ID
    panel.getBoundingClientRect = () =>
      ({ left: 500, right: 800, top: 8, bottom: 760, width: 300, height: 752 }) as DOMRect
    document.body.appendChild(panel)
    harness.localTemplates.mockReturnValue([template({ originX: 795 })])
    rerender()
    gear('a').click()
    rerender()

    const usableRight = 500 - GAP
    expect(floatingPosition(gear('a')).x + RAIL_BUTTON).toBeLessThanOrEqual(usableRight)
    expect(Number.parseFloat(menu().style.left) + 240).toBeLessThanOrEqual(usableRight)
    for (const action of document.querySelectorAll<HTMLElement>('[data-caelestis-rail-action]')) {
      expect(floatingPosition(action).x + RAIL_BUTTON).toBeLessThanOrEqual(usableRight)
    }

    byKey('move').click()
    rerender()
    for (const action of document.querySelectorAll<HTMLElement>(
      '[data-caelestis-placement-action]',
    )) {
      expect(floatingPosition(action).x + RAIL_BUTTON).toBeLessThanOrEqual(usableRight)
    }
  })

  it('opens the menu to the right when that side has space', () => {
    menuMeasures(200, 240)
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    expect(Number.parseFloat(menu().style.left)).toBeGreaterThan(
      floatingPosition(gear('a')).x + RAIL_BUTTON,
    )
  })

  it('keeps the expanded action rail inside the viewport', () => {
    const restore = window.innerHeight
    Object.defineProperty(window, 'innerHeight', { value: 300, configurable: true })
    onTestFinished(() => {
      Object.defineProperty(window, 'innerHeight', { value: restore, configurable: true })
    })
    harness.localTemplates.mockReturnValue([template({ originY: 290 })])
    rerender()
    gear('a').click()
    rerender()

    const actions = [...document.querySelectorAll<HTMLElement>('[data-caelestis-rail-action]')]
    const last = actions.at(-1)
    if (last === undefined) throw new Error('no rail action')
    expect(floatingPosition(last).y + RAIL_BUTTON).toBeLessThanOrEqual(window.innerHeight - 8)
  })

  it.each([
    ['no room below', 768, 668, 300],
    // Too little room on either side, which a menu that merely flips answers by covering the gear
    // from above instead of below.
    ['too little room on either side', 400, 180, 300],
    // Content taller than the `70vh` it is measured under, beside a gear with more room above it
    // than that — so the cap it is given and the height it was measured at disagree.
    ['content taller than the design cap', 320, 300, 320],
  ])('never covers its own rail — %s', (_case, viewport, originY, content) => {
    const restore = window.innerHeight
    Object.defineProperty(window, 'innerHeight', { value: viewport, configurable: true })
    onTestFinished(() => {
      Object.defineProperty(window, 'innerHeight', { value: restore, configurable: true })
    })
    menuMeasures(content)
    harness.localTemplates.mockReturnValue([template({ originY })])
    rerender()
    gear('a').click()
    rerender()

    const gearLeft = floatingPosition(gear('a')).x
    const left = Number.parseFloat(menu().style.left)
    const width = menu().getBoundingClientRect().width
    expect(left + width <= gearLeft || left >= gearLeft + RAIL_BUTTON).toBe(true)
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

    expect(document.getElementById('caelestis-overlay-menu')).not.toBeNull()
    expect(menu().dataset.caelestisTemplate).toBe('b')
  })

  it('keeps a carried delete question naming the template as it is now', () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    byKey('delete').click()

    harness.localTemplates.mockReturnValue([template({ name: 'renamed.png' })])
    rerender()

    expect(menu().querySelector('[data-caelestis-confirm]')?.textContent).toContain('renamed.png')
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
    harness.setAppearance.mockImplementation(async () => ++call !== 1)
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    setRadius()
    byKey('swatch:1').click()
    await settle()

    // The colour landed and the shape did not. One shared `appearance` bucket would let the
    // colour's success clear the shape's banner, and the overlay ends up Full with nothing said.
    expect(errorText()).toContain('Could not change rounding')
    expect((byKey('radius') as HTMLInputElement).value).toBe('0')
  })

  it('clears a refused write once the same property succeeds', async () => {
    let call = 0
    harness.setAppearance.mockImplementation(async () => ++call !== 1)
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    setRadius()
    await settle()
    expect(errorText()).toContain('Could not change rounding')
    setRadius('0.5')
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
    opacity.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1 }))
    drag(opacity, '0.9')
    await settle()

    // The map reverted; a thumb left at the refused value says the change took. Re-queried
    // because the refusal is state, so the menu is rebuilt from it rather than patched.
    expect((byKey('opacity') as HTMLInputElement).value).toBe('0.4')
  })
})

describe('focus goes somewhere deliberate', () => {
  it('returns to Delete when the question is cancelled', () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    byKey('delete').click()

    byText(menu(), 'Cancel').click()
    rerender()

    expect((document.activeElement as HTMLElement | null)?.dataset.caelestisControl).toBe('delete')
  })

  it('announces the destructive question rather than a bare Delete', () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    byKey('delete').click()

    const box = menu().querySelector('[data-caelestis-confirm]')
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
    setRadius()
    release()
    await settle()

    // Tying the report to "am I still the latest request" makes any second click silence the first
    // one's failure, which is the whole guarantee this menu exists to keep.
    expect(errorText()).toContain('Could not change visibility')
  })

  it('reports a write that threw rather than stranding the intent', async () => {
    harness.setAppearance.mockRejectedValue(new Error('IndexedDB is gone'))
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    setRadius()
    await settle()

    expect(errorText()).toContain('Could not change rounding')
    // Intent released: the menu must not keep asserting a shape that was never saved.
    expect((byKey('radius') as HTMLInputElement).value).toBe('0')
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
    expect(byKey('delete').getAttribute('aria-disabled')).toBe('true')
    expect(byKey('cancel-delete').getAttribute('aria-disabled')).toBe('true')
    expect(byKey('confirm-delete').textContent).toBe('Deleting…')
  })
})

describe('the slider is only frozen while a gesture is actually in progress', () => {
  it('applies a pixel preset as one editable six-slider change', async () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    expect(pixelPreset('small').getAttribute('aria-pressed')).toBe('false')
    pixelPreset('corner').click()
    await settle()

    expect(harness.setOwnsGroup).toHaveBeenCalledWith('a', 'pixels', true)
    expect(appearanceWritten(0)).toMatchObject({
      size: 1.5,
      radius: 0,
      translateX: -0.75,
      translateY: 0,
      rotation: 45,
      opacity: 1,
      markMismatch: false,
      otherOpacity: 0.15,
    })
  })

  it('offers the whole 0..1 range the store accepts', () => {
    // `normaliseAppearance` runs on a conflict's remote winner, so another client's 0 arrives here.
    harness.localTemplates.mockReturnValue([template({ appearance: { opacity: 0 } })])
    rerender()
    gear('a').click()
    rerender()

    const opacity = byKey('opacity') as HTMLInputElement
    expect(opacity.min).toBe('0.05')
    expect(opacity.value).toBe('0.05')
  })

  it('represents the default size exactly rather than snapping off it', () => {
    harness.localTemplates.mockReturnValue([template({ appearance: { radius: 1 } })])
    rerender()
    gear('a').click()
    rerender()

    expect(Number((byKey('size') as HTMLInputElement).value)).toBe(DEFAULT_APPEARANCE.size)
  })
})

describe('the menu is ours and has a keyboard exit', () => {
  it('offers move and delete for an unpublished server overlay an admin owns', () => {
    connectServerTemplate(false)
    harness.localTemplates.mockReturnValue([template({ serverUrl: 'https://example.test' })])
    rerender()
    gear('a').click()
    rerender()

    expect(byKey('move')).not.toBeNull()
    expect(byKey('delete')).not.toBeNull()
    expect(byKey('hide')).not.toBeNull()
  })

  it('keeps published server actions visible but requires unpublishing first', () => {
    connectServerTemplate(true)
    harness.localTemplates.mockReturnValue([template({ serverUrl: 'https://example.test' })])
    rerender()
    gear('a').click()
    rerender()

    expect(byKey('move').getAttribute('aria-disabled')).toBe('true')
    expect(byKey('delete').getAttribute('aria-disabled')).toBe('true')
    byKey('move').click()
    rerender()

    expect(errorText()).toContain('Unpublish this template before moving it')
    expect(harness.beginServerMove).not.toHaveBeenCalled()
  })

  it('does not offer server mutations without admin access', () => {
    connectServerTemplate(false, false)
    harness.localTemplates.mockReturnValue([template({ serverUrl: 'https://example.test' })])
    rerender()
    gear('a').click()
    rerender()

    expect(document.querySelector('[data-caelestis-control="move"]')).toBeNull()
    expect(document.querySelector('[data-caelestis-control="delete"]')).toBeNull()
  })

  it('uploads a new version when an unpublished server move is applied', async () => {
    connectServerTemplate(false)
    const remote = template({ serverUrl: 'https://example.test' })
    harness.localTemplates.mockReturnValue([remote])
    rerender()
    gear('a').click()
    rerender()

    byKey('move').click()
    const persist = harness.beginServerMove.mock.calls[0]?.[2]
    if (typeof persist !== 'function') throw new Error('server move did not receive persistence')
    await persist(12, 34)

    expect(harness.uploadTemplateVersion).toHaveBeenCalledWith(
      harness.servers[0],
      'remote-a',
      expect.objectContaining({ originX: 12, originY: 34, name: 'alpha.png' }),
    )
    expect(harness.listServerContents).toHaveBeenCalledWith(harness.servers[0])
  })

  it('deletes an unpublished server template through the server API', async () => {
    connectServerTemplate(false)
    harness.localTemplates.mockReturnValue([template({ serverUrl: 'https://example.test' })])
    rerender()
    gear('a').click()
    rerender()

    byKey('delete').click()
    rerender()
    byKey('confirm-delete').click()
    await settle()

    expect(harness.deleteServerTemplate).toHaveBeenCalledWith(harness.servers[0], 'remote-a', {
      version: 'version-1',
      updatedAt: 1,
    })
    expect(harness.removeLocalTemplate).not.toHaveBeenCalled()
    expect(harness.forgetServerTemplate).toHaveBeenCalledWith('a')
    expect(harness.listServerContents).toHaveBeenCalledWith(harness.servers[0])
  })

  it('closes on Escape and hands focus back to the gear', () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    byKey('hide').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    rerender()

    expect(document.getElementById('caelestis-overlay-menu')).toBeNull()
    expect(document.activeElement).toBe(gear('a'))
  })

  it('leaves the keyboard off the gear while the placement it started is running', () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    byKey('move').click()
    rerender()

    expect(harness.beginMove).toHaveBeenCalledWith('a', expect.any(Function))
    // `move.ts` ignores keys aimed at a page control, so a focused gear would take Escape and Enter
    // away from the placement — and Enter would reopen this menu instead of applying it.
    expect(document.getElementById('caelestis-overlay-button-a')).toBeNull()
    expect(document.activeElement).not.toBe(byKey('apply-move'))
    expect(document.activeElement).not.toBe(byKey('cancel-move'))
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
    expect(byKey('move').getAttribute('aria-disabled')).toBe('true')
    expect(byKey('hide').getAttribute('aria-disabled')).toBe('true')
  })
})

describe('interaction outranks a repaint', () => {
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

    expect((document.activeElement as HTMLElement | null)?.dataset.caelestisControl).not.toBe(
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

    const messages = [...menu().querySelectorAll('[data-caelestis-error]')].map(
      (el) => el.textContent,
    )
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
    expect(menu().querySelector('[data-caelestis-error]')?.getAttribute('role')).toBe('alert')

    byKey('swatch:1').click()
    await settle()

    // A rebuild reconstructs the node; a fresh role="alert" would read the old failure out again.
    expect(menu().querySelector('[data-caelestis-error]')?.hasAttribute('role')).toBe(false)
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
    opacity.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1 }))
    release()
    await settle()
    expect(errorText()).toBeNull()

    // Letting go has to let it through: on a static map no other frame is coming.
    opacity.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }))

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
    harness.isMoving.mockReturnValue(false)
    harness.movingId.mockReturnValue(null)
    harness.placementSeq.mockReturnValue(null)
    rerender()
    gear('a').click()
    rerender()

    // Nothing else ever cleared this one, so it outlived the placement it was about.
    expect(errorText()).toBeNull()
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
    expect((document.activeElement as HTMLElement | null)?.dataset.caelestisControl).toBe(
      'confirm-delete',
    )
    expect(byKey('confirm-delete').getAttribute('aria-disabled')).toBe('true')
  })

  it('stops offering the appearance controls while the delete runs', () => {
    harness.removeLocalTemplate.mockImplementation(() => new Promise<boolean>(() => {}))
    harness.localTemplates.mockReturnValue([template({ appearance: { radius: 1 } })])
    rerender()
    gear('a').click()
    rerender()
    byKey('delete').click()
    rerender()
    byKey('confirm-delete').click()
    rerender()

    // The store refuses these anyway, leaving a meaningless banner beside "Deleting…".
    // `readonly` does nothing to a range in any browser, so the lock has to refuse the gesture.
    const opacity = byKey('opacity') as HTMLInputElement
    expect(opacity.getAttribute('aria-disabled')).toBe('true')
    const press = new PointerEvent('pointerdown', { pointerId: 1, cancelable: true })
    opacity.dispatchEvent(press)
    expect(press.defaultPrevented).toBe(true)
    expect(byKey('swatch:1').getAttribute('aria-disabled')).toBe('true')
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

    expect(menu().querySelector('[data-caelestis-confirm]')).toBeNull()
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

    setRadius()
    byKey('hide').click()
    await settle()

    // One shared intent, released only by its latest owner, keeps asserting the refused shape for
    // as long as the visibility write is outstanding — and that one never resolves.
    expect((byKey('radius') as HTMLInputElement).value).toBe('0')
    expect(errorText()).toContain('Could not change rounding')
  })

  it('names the property a refusal is about', async () => {
    harness.setAppearance.mockResolvedValue(false)
    harness.localTemplates.mockReturnValue([template({ appearance: { radius: 1 } })])
    rerender()
    gear('a').click()
    rerender()

    setRadius('0')
    await settle()
    const size = byKey('size') as HTMLInputElement
    drag(size, '0.5')
    await settle()

    const messages = [...menu().querySelectorAll('[data-caelestis-error]')].map(
      (el) => el.textContent,
    )
    expect(messages.join(' ')).toContain('rounding')
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
    opacity.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1 }))
    drag(opacity, '0.9')
    await settle()

    // Releasing the hold repaints, and the repaint puts the stored value back into this very input.
    // Reading after that commits the value the user just dragged away from.
    expect(appearanceWritten(0).opacity).toBe(0.9)
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
    expect(byKey('move').getAttribute('aria-disabled')).toBe('true')
    expect(byKey('delete').getAttribute('aria-disabled')).toBe('true')
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
    expect(menu().querySelector('[data-caelestis-confirm]')).not.toBeNull()
  })

  it('opens onto a control that can take focus while a delete runs', () => {
    harness.isDeletingLocal.mockReturnValue(true)
    harness.localTemplates.mockReturnValue([template()])
    rerender()

    gear('a').click()
    rerender()

    // Hide is disabled during a delete, and a disabled control cannot hold focus.
    expect((document.activeElement as HTMLElement | null)?.dataset.caelestisControl).toBe('close')
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

describe('a delete that becomes terminal after the menu exists', () => {
  it('refuses the action even from a menu built before the delete', () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    const move = byKey('move')
    const hide = byKey('hide')

    // No repaint: the map is idle, so these are the elements the user still has in front of them.
    harness.isDeletingLocal.mockReturnValue(true)
    move.click()
    hide.click()

    expect(harness.beginMove).not.toHaveBeenCalled()
    expect(harness.setLocalVisible).not.toHaveBeenCalled()
  })
})

describe('repeating an action is never silently a no-op', () => {
  it('composes two clicks of the same swatch instead of replacing one with the other', async () => {
    harness.setAppearance.mockImplementation(() => new Promise<boolean>(() => {}))
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    byKey('swatch:1').click()
    rerender()
    expect(byKey('swatch:1').dataset.on).toBe('false')
    byKey('swatch:1').click()
    rerender()

    // The updater is a toggle. Latest-wins makes the second click read as no change at all, while
    // the queued writes compose back to visible — the menu and the map disagreeing.
    expect(byKey('swatch:1').dataset.on).toBe('true')
  })

  it('writes once for a held arrow key, not once per repeat', async () => {
    harness.localTemplates.mockReturnValue([template({ appearance: { radius: 1 } })])
    rerender()
    gear('a').click()
    rerender()
    const size = byKey('size') as HTMLInputElement

    size.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
    for (const value of ['0.4', '0.45', '0.5']) {
      size.value = value
      size.dispatchEvent(new Event('input'))
      size.dispatchEvent(new Event('change'))
    }
    await settle()
    // `size` is in the stamped-tile cache key, so one write per key repeat re-stamps at scale 3.
    expect(harness.setAppearance).not.toHaveBeenCalled()

    size.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight' }))
    await settle()

    expect(harness.setAppearance).toHaveBeenCalledTimes(1)
    expect(appearanceWritten(0).size).toBe(0.5)
  })
})

describe('a pointer drag in the order a browser actually fires it', () => {
  it('commits the dragged value when change follows pointerup', async () => {
    harness.localTemplates.mockReturnValue([template({ appearance: { opacity: 0.4 } })])
    rerender()
    gear('a').click()
    rerender()
    const opacity = byKey('opacity') as HTMLInputElement

    // Chromium dispatches a range's `change` from its stop-dragging work, *after* pointerup
    // handlers. Every earlier test fired `change` first, which is the one order that hides this.
    drag(opacity, '0.9')
    await settle()

    expect(appearanceWritten(0).opacity).toBe(0.9)
  })

  it('is not poisoned by tabbing away from the thumb', async () => {
    harness.localTemplates.mockReturnValue([template({ appearance: { opacity: 0.4 } })])
    rerender()
    gear('a').click()
    rerender()
    const opacity = byKey('opacity') as HTMLInputElement

    // Tab does not move the thumb, and its keyup lands on whatever it focused next.
    opacity.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }))
    drag(opacity, '0.7')
    await settle()

    expect(harness.setAppearance).toHaveBeenCalledTimes(1)
    expect(appearanceWritten(0).opacity).toBe(0.7)
  })
})

describe('a held slider holds its own menu, not the next one', () => {
  it('still switches templates while a slider is held', () => {
    harness.localTemplates.mockReturnValue([template(), template({ id: 'b', name: 'beta.png' })])
    rerender()
    gear('a').click()
    rerender()
    ;(byKey('opacity') as HTMLInputElement).dispatchEvent(
      new PointerEvent('pointerdown', { pointerId: 1 }),
    )

    gear('b').click()
    rerender()

    // Two touches: one holding A's thumb, one tapping B's gear. Keeping A's menu would park A's
    // handlers beside B — the wrong-template failure this relay opened with.
    expect(menu().dataset.caelestisTemplate).toBe('b')
    expect(menu().textContent).toContain('beta.png')
  })

  it('rebuilds a menu the page has torn off even while held, keeping the value', async () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    ;(byKey('opacity') as HTMLInputElement).dispatchEvent(
      new PointerEvent('pointerdown', { pointerId: 1 }),
    )

    // A hostile or careless host removes it; the detached control may never see another event.
    const opacity = byKey('opacity') as HTMLInputElement
    opacity.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1 }))
    opacity.value = '0.62'
    opacity.dispatchEvent(new Event('input'))
    menu().remove()
    rerender()
    await settle()

    expect(document.getElementById('caelestis-overlay-menu')).not.toBeNull()
    // And the value the user had reached is not simply thrown away with the node.
    expect(appearanceWritten(0).opacity).toBe(0.62)
  })

  it('commits a marker range when the menu is torn down mid-drag', async () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    const markerSize = menu().querySelector<HTMLInputElement>(
      'input[type="range"]:not([data-caelestis-control])',
    )
    if (markerSize === null) throw new Error('no Mismatches Size track')

    markerSize.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1 }))
    markerSize.value = '17'
    markerSize.dispatchEvent(new Event('input'))
    const host = mapCanvas.parentElement
    mapCanvas.remove()
    rerender()
    host?.appendChild(mapCanvas)
    rerender()
    await settle()

    expect(harness.setAppearance).toHaveBeenCalledTimes(1)
    expect(appearanceWritten(0).markerSize).toBe(17)
  })

  it('commits one colour for a picker drag rather than every movement', async () => {
    harness.localTemplates.mockReturnValue([template({ appearance: { markMismatch: true } })])
    rerender()
    gear('a').click()
    rerender()
    const swatch = menu().querySelector<HTMLButtonElement>('button[aria-label^="Marker colour:"]')
    if (swatch === null) throw new Error('no marker colour swatch')
    swatch.click()
    const square = document.querySelector<HTMLElement>('.caelestis-cp-sv')
    if (square === null) throw new Error('no colour picker square')
    square.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }) as DOMRect
    let captured: number | null = null
    square.setPointerCapture = (pointerId) => {
      captured = pointerId
    }
    square.hasPointerCapture = (pointerId) => captured === pointerId

    square.dispatchEvent(
      new PointerEvent('pointerdown', { pointerId: 7, clientX: 10, clientY: 90 }),
    )
    square.dispatchEvent(
      new PointerEvent('pointermove', { pointerId: 7, clientX: 50, clientY: 50 }),
    )
    rerender()
    square.dispatchEvent(
      new PointerEvent('pointermove', { pointerId: 7, clientX: 80, clientY: 20 }),
    )
    await settle()

    expect(harness.setAppearance).not.toHaveBeenCalled()
    square.dispatchEvent(new PointerEvent('pointerup', { pointerId: 7 }))
    await settle()

    expect(harness.setAppearance).toHaveBeenCalledTimes(1)
    expect(appearanceWritten(0).markerColour).toBe('#cc2929')
  })
})

describe('a refusal retires only when its own subject is satisfied', () => {
  it('retires it when the shape reaches what was asked, from anywhere', async () => {
    harness.setAppearance.mockResolvedValue(false)
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    setRadius()
    await settle()
    expect(errorText()).toContain('Could not change rounding')

    // Another tab sets the very shape this refusal was about. Revision is irrelevant — a pending
    // image never persists one at all.
    harness.localTemplates.mockReturnValue([template({ appearance: { radius: 1 } })])
    rerender()

    expect(errorText()).toBeNull()
  })
})

describe('a delete started elsewhere explains itself', () => {
  it('does not lock the controls natively, so a cleared guard is recoverable', () => {
    harness.isDeletingLocal.mockReturnValue(true)
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    expect(byKey('move').getAttribute('aria-disabled')).toBe('true')

    // A failed panel delete drops the store's guard and notifies nobody. On a static map no frame
    // arrives, so a native `disabled` would leave the menu dead until the map next moved.
    harness.isDeletingLocal.mockReturnValue(false)
    byKey('move').click()

    expect(harness.beginMove).toHaveBeenCalledWith('a', expect.any(Function))
  })
})

describe('a slider keeps tracking the store after every kind of gesture', () => {
  it('is not frozen by an arrow press that never produced a change', async () => {
    harness.localTemplates.mockReturnValue([template({ appearance: { opacity: 0.4 } })])
    rerender()
    gear('a').click()
    rerender()
    const opacity = byKey('opacity') as HTMLInputElement

    // A range fires input then change on each arrow press, and `change` under a held key parks the
    // value and returns *before* the dirty marker is cleared.
    opacity.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
    opacity.value = '0.45'
    opacity.dispatchEvent(new Event('input'))
    opacity.dispatchEvent(new Event('change'))
    opacity.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight' }))
    await settle()

    harness.localTemplates.mockReturnValue([template({ appearance: { opacity: 0.9 } })])
    rerender()

    expect((byKey('opacity') as HTMLInputElement).value).toBe('0.9')
  })
})

describe('the menu belongs to us, and to one template at a time', () => {
  it('retracts a delete question when another template is opened', () => {
    harness.localTemplates.mockReturnValue([template(), template({ id: 'b', name: 'beta.png' })])
    rerender()
    gear('a').click()
    rerender()
    byKey('delete').click()
    rerender()

    gear('b').click()
    rerender()
    gear('a').click()
    rerender()

    // ✕ and Escape both retract it; walking away via another gear must not be the one that leaves
    // a live destructive button waiting.
    expect(menu().querySelector('[data-caelestis-confirm]')).toBeNull()
  })

  it('does not flip a swatch back while its own write is landing', async () => {
    // `setAppearance` publishes and repaints from inside its transaction, before the promise
    // resolves and the intent is released.
    harness.setAppearance.mockImplementation(async (_id, appearance) => {
      harness.localTemplates.mockReturnValue([template({ appearance })])
      rerender()
      return true
    })
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    byKey('swatch:1').click()
    await settle()
    rerender()

    expect(byKey('swatch:1').dataset.on).toBe('false')
  })
})

describe('a condemned template is condemned everywhere', () => {
  it('renders the progress box as soon as the store says so', () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    expect(menu().querySelector('[data-caelestis-confirm]')).toBeNull()

    // A delete started from the panel, with the record still present for its IndexedDB round trip.
    harness.isDeletingLocal.mockReturnValue(true)
    rerender()

    expect(byKey('confirm-delete').textContent).toBe('Deleting…')
  })

  it('does not resurrect a dismissed question when an external delete fails', () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    byKey('delete').click()
    rerender()

    harness.isDeletingLocal.mockReturnValue(true)
    rerender()
    byKey('close').click()
    rerender()
    // The panel's delete fails and drops the guard.
    harness.isDeletingLocal.mockReturnValue(false)
    gear('a').click()
    rerender()

    expect(menu().querySelector('[data-caelestis-confirm]')).toBeNull()
  })
})

describe('a locked slider arms nothing', () => {
  it('does not block rebuilds after a refused press', () => {
    harness.isDeletingLocal.mockReturnValue(true)
    harness.localTemplates.mockReturnValue([template({ appearance: { radius: 1 } })])
    rerender()
    gear('a').click()
    rerender()

    // A prevented native range gesture takes no pointer capture, so releasing outside the input
    // never delivers a `pointerup` here.
    byKey('opacity').dispatchEvent(
      new PointerEvent('pointerdown', { pointerId: 1, cancelable: true }),
    )
    harness.localTemplates.mockReturnValue([
      template({ name: 'renamed.png', appearance: { radius: 1 } }),
    ])
    rerender()

    expect(menu().textContent).toContain('renamed.png')
  })

  it('commits a drag that returned to its origin rather than losing it', async () => {
    harness.localTemplates.mockReturnValue([template({ appearance: { opacity: 0.4 } })])
    rerender()
    gear('a').click()
    rerender()
    const opacity = byKey('opacity') as HTMLInputElement

    opacity.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1 }))
    // Another tab moves the store mid-drag; the user still ends where they began.
    harness.localTemplates.mockReturnValue([template({ appearance: { opacity: 0.9 } })])
    opacity.value = '0.7'
    opacity.dispatchEvent(new Event('input'))
    opacity.value = '0.4'
    opacity.dispatchEvent(new Event('input'))
    opacity.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }))
    await settle()

    // The gesture is what the user asked for, whatever the store did underneath it.
    expect(appearanceWritten(0).opacity).toBe(0.4)
  })
})

describe('focus saved across a teardown is not focus demanded', () => {
  it('leaves the keyboard where the user has since put it', () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    byKey('swatch:5').focus()

    const host = mapCanvas.parentElement
    mapCanvas.remove()
    rerender()
    // The user clicks into something else while the map is away.
    const elsewhere = document.createElement('input')
    document.body.appendChild(elsewhere)
    elsewhere.focus()
    host?.appendChild(mapCanvas)
    rerender()

    expect(document.activeElement).toBe(elsewhere)
  })
})

describe('a gesture is what the user did, not what the element held', () => {
  it('previews every pixel slider input before the gesture ends', async () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    const size = byKey('size') as HTMLInputElement

    size.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1 }))
    size.value = '0.7'
    size.dispatchEvent(new Event('input'))

    expect(harness.setAppearancePreview).toHaveBeenCalledWith('a', 'size', 0.7)
    expect(harness.setAppearance).not.toHaveBeenCalled()

    size.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }))
    await settle()

    expect(harness.clearAppearancePreview).toHaveBeenCalledWith('a', 'size', 0.7)
  })

  it('does not write a stale value for a press that moved nothing', async () => {
    harness.localTemplates.mockReturnValue([template({ appearance: { opacity: 0.4 } })])
    rerender()
    gear('a').click()
    rerender()

    // Press the thumb and never move it, while another tab changes the store.
    byKey('opacity').dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1 }))
    harness.localTemplates.mockReturnValue([template({ appearance: { opacity: 0.9 } })])
    const host = mapCanvas.parentElement
    mapCanvas.remove()
    rerender()
    host?.appendChild(mapCanvas)
    rerender()
    await settle()

    // Committing the element's value here would put 0.4 over the remote 0.9.
    expect(harness.setAppearance).not.toHaveBeenCalled()
  })

  it('commits the first template’s edit when a second touch opens another menu', async () => {
    harness.localTemplates.mockReturnValue([template(), template({ id: 'b', name: 'beta.png' })])
    rerender()
    gear('a').click()
    rerender()
    const opacity = byKey('opacity') as HTMLInputElement
    opacity.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1 }))
    opacity.value = '0.55'
    opacity.dispatchEvent(new Event('input'))

    gear('b').click()
    rerender()
    await settle()

    expect(harness.setAppearance).toHaveBeenCalledWith(
      'a',
      expect.objectContaining({ opacity: 0.55 }),
    )
  })
})

describe('refusals track the world, not our own render schedule', () => {
  it('does not keep a hidden overlay’s gear alive for a refusal', async () => {
    harness.setAppearance.mockResolvedValue(false)
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    setRadius()
    await settle()
    byKey('close').click()
    harness.localTemplates.mockReturnValue([template({ visible: false })])
    rerender()
    expect(document.getElementById('caelestis-overlay-button-a')).toBeNull()

    harness.localTemplates.mockReturnValue([
      template({ visible: false, appearance: { radius: 1 } }),
    ])
    rerender()

    expect(document.getElementById('caelestis-overlay-button-a')).toBeNull()
  })
})

describe('more than one thing can be happening at once', () => {
  it('does not take a second pointer’s slider away when the first releases', async () => {
    harness.localTemplates.mockReturnValue([template({ appearance: { radius: 1 } })])
    rerender()
    gear('a').click()
    rerender()
    const size = byKey('size') as HTMLInputElement
    const opacity = byKey('opacity') as HTMLInputElement

    size.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1 }))
    size.value = '0.6'
    size.dispatchEvent(new Event('input'))
    opacity.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 2 }))
    opacity.value = '0.3'
    opacity.dispatchEvent(new Event('input'))
    // Two touches; the second one lifts first.
    opacity.dispatchEvent(new PointerEvent('pointerup', { pointerId: 2 }))
    await settle()

    // Rebuilding here would remove the size input mid-gesture, and its release would never come.
    expect(byKey('size')).toBe(size)
    size.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }))
    await settle()
    expect(harness.setAppearance).toHaveBeenCalledWith('a', expect.objectContaining({ size: 0.6 }))
  })

  it('writes an interrupted pair of drafts once each', async () => {
    harness.localTemplates.mockReturnValue([template({ appearance: { radius: 1 } })])
    rerender()
    gear('a').click()
    rerender()
    const size = byKey('size') as HTMLInputElement
    const opacity = byKey('opacity') as HTMLInputElement
    size.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1 }))
    size.value = '0.6'
    size.dispatchEvent(new Event('input'))
    opacity.value = '0.3'
    opacity.dispatchEvent(new Event('input'))

    const host = mapCanvas.parentElement
    mapCanvas.remove()
    rerender()
    host?.appendChild(mapCanvas)
    rerender()
    await settle()

    // `settle` repaints synchronously and that repaint re-enters the teardown; iterating a live map
    // meant the re-entrant call and the outer loop each committed the same draft.
    expect(harness.setAppearance).toHaveBeenCalledTimes(2)
  })

  it('shows the delete that started while a slider was being dragged', async () => {
    harness.localTemplates.mockReturnValue([template({ appearance: { opacity: 0.4 } })])
    rerender()
    gear('a').click()
    rerender()
    const opacity = byKey('opacity') as HTMLInputElement

    opacity.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1 }))
    opacity.value = '0.7'
    opacity.dispatchEvent(new Event('input'))
    // The panel starts a delete; the drag guard has been suppressing rebuilds throughout.
    harness.isDeletingLocal.mockReturnValue(true)
    rerender()
    opacity.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }))
    await settle()

    expect(byKey('confirm-delete').textContent).toBe('Deleting…')
  })

  it('announces a second refusal of the same control', async () => {
    harness.setLocalVisible.mockResolvedValue(false)
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    byKey('hide').click()
    await settle()
    const first = menu().querySelector('[data-caelestis-error]')
    byKey('hide').click()
    await settle()

    // Only Move used to get a second announcement; a deliberate retry of anything deserves one.
    expect(menu().querySelector('[data-caelestis-error]')).not.toBe(first)
    expect(menu().querySelector('[data-caelestis-error]')?.getAttribute('role')).toBe('alert')
  })
})

describe('a pointer gesture ends wherever the pointer does', () => {
  it('ends a drag released outside the control', async () => {
    harness.localTemplates.mockReturnValue([template({ appearance: { opacity: 0.4 } })])
    rerender()
    gear('a').click()
    rerender()
    const opacity = byKey('opacity') as HTMLInputElement

    opacity.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1 }))
    opacity.value = '0.65'
    opacity.dispatchEvent(new Event('input'))
    // A mouse drag that leaves the range: without pointer capture the release never comes back
    // here, and the gesture — with the rebuild suppression it holds — never ends.
    opacity.dispatchEvent(new PointerEvent('lostpointercapture', { pointerId: 1 }))
    await settle()

    expect(appearanceWritten(0).opacity).toBe(0.65)
    harness.localTemplates.mockReturnValue([template({ appearance: { opacity: 0.65 } })])
    harness.localTemplates.mockReturnValue([template({ name: 'renamed.png' })])
    rerender()
    expect(menu().textContent).toContain('renamed.png')
  })

  it('waits for every pointer on one slider before ending the gesture', async () => {
    harness.localTemplates.mockReturnValue([template({ appearance: { opacity: 0.4 } })])
    rerender()
    gear('a').click()
    rerender()
    const opacity = byKey('opacity') as HTMLInputElement

    // Two pointers on the *same* range. Tracking holds per element makes the first release look
    // like the end of both.
    opacity.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1 }))
    opacity.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 2 }))
    opacity.value = '0.55'
    opacity.dispatchEvent(new Event('input'))
    opacity.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }))
    await settle()
    expect(harness.setAppearance).not.toHaveBeenCalled()

    opacity.dispatchEvent(new PointerEvent('pointerup', { pointerId: 2 }))
    await settle()

    expect(appearanceWritten(0).opacity).toBe(0.55)
  })

  it('commits a keyboard edit through the blur a real Close click causes', async () => {
    harness.localTemplates.mockReturnValue([template({ appearance: { opacity: 0.4 } })])
    rerender()
    gear('a').click()
    rerender()
    const opacity = byKey('opacity') as HTMLInputElement

    opacity.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
    opacity.value = '0.5'
    opacity.dispatchEvent(new Event('input'))
    // The browser blurs the range before the destination button's click runs.
    opacity.dispatchEvent(new Event('blur'))
    byKey('close').click()
    rerender()
    await settle()

    expect(appearanceWritten(0).opacity).toBe(0.5)
  })
})

describe('identity cannot be forged by data or by the host', () => {
  it('tells apart two templates whose fields collide on a separator', () => {
    // Both are legal: ids and names are arbitrary strings.
    const first = { ...template({ id: 'a|b', name: 'c' }) }
    const second = { ...template({ id: 'a', name: 'b|c' }) }
    harness.localTemplates.mockReturnValue([first, second])
    rerender()
    gear('a|b').click()
    rerender()
    expect(menu().dataset.caelestisTemplate).toBe('a|b')

    gear('a').click()
    rerender()

    // A joined signature makes these one string, so the old menu is reused — with its Delete still
    // pointed at the first template.
    expect(menu().dataset.caelestisTemplate).toBe('a')
  })

  it('ends a gesture whose control the host removed on its own', async () => {
    harness.localTemplates.mockReturnValue([template({ appearance: { opacity: 0.4 } })])
    rerender()
    gear('a').click()
    rerender()
    const opacity = byKey('opacity') as HTMLInputElement

    opacity.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1 }))
    opacity.value = '0.72'
    opacity.dispatchEvent(new Event('input'))
    // Only the range is taken, so the menu is untouched and neither teardown path notices.
    opacity.remove()
    rerender()
    await settle()

    expect(appearanceWritten(0).opacity).toBe(0.72)
  })
})

describe('an interaction is not swallowed by the edit it interrupts', () => {
  it('lets the click that blurred a slider still reach its button', async () => {
    harness.localTemplates.mockReturnValue([template({ appearance: { opacity: 0.4 } })])
    rerender()
    gear('a').click()
    rerender()
    const opacity = byKey('opacity') as HTMLInputElement

    opacity.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
    opacity.value = '0.6'
    opacity.dispatchEvent(new Event('input'))
    // The browser blurs the range on pointerdown, before the click lands.
    const close = byKey('close')
    opacity.dispatchEvent(new Event('blur'))
    close.click()
    rerender()
    await settle()

    // Committing synchronously on blur rebuilds the menu and removes the button mid-click.
    expect(document.getElementById('caelestis-overlay-menu')).toBeNull()
    expect(appearanceWritten(0).opacity).toBe(0.6)
  })

  it('closes on Escape after a click on the map', () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    // The menu deliberately survives this, per the acceptance criteria.
    mapCanvas.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    rerender()

    expect(document.getElementById('caelestis-overlay-menu')).toBeNull()
  })
})

describe('an action waits for the state it depends on', () => {
  it('answers the delete question first on Escape from outside the menu', () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    byKey('delete').click()
    rerender()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    rerender()

    expect(document.getElementById('caelestis-overlay-menu')).not.toBeNull()
    expect(menu().querySelector('[data-caelestis-confirm]')).toBeNull()
  })

  it('still exits when another page listener prevented the Escape', () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    // Something else on the page prevents it first; that is not our marker.
    window.addEventListener('keydown', (e) => e.preventDefault(), { once: true })
    window.dispatchEvent(event)
    rerender()

    expect(document.getElementById('caelestis-overlay-menu')).toBeNull()
  })
})

describe('gestures settle when their control stops being reachable', () => {
  it('does not drop another slider’s fallback when one is detached', async () => {
    harness.localTemplates.mockReturnValue([template({ appearance: { radius: 1 } })])
    rerender()
    gear('a').click()
    rerender()
    const size = byKey('size') as HTMLInputElement
    const opacity = byKey('opacity') as HTMLInputElement
    // Capture unavailable, so both fall back to window-level releases.
    for (const input of [size, opacity]) {
      Object.defineProperty(input, 'setPointerCapture', {
        value: () => {
          throw new Error('unsupported')
        },
      })
    }
    size.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1 }))
    opacity.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 2 }))
    opacity.value = '0.33'
    opacity.dispatchEvent(new Event('input'))
    size.remove()
    rerender()

    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 2 }))
    await settle()

    // Dropping every fallback when one slider detaches takes the still-live slider's with it.
    expect(appearanceWritten(0).opacity).toBe(0.33)
  })
})
