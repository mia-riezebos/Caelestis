// @vitest-environment happy-dom
import { registerCaelestisUi } from '@caelestis/ui/elements'
import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { ActiveAllianceSurface } from '../alliance-surface.js'
import { type Appearance, DEFAULT_APPEARANCE } from '../templates/appearance.js'
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

beforeAll(() => registerCaelestisUi())

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
    appearance: DEFAULT_APPEARANCE,
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
  surface?: { kind: 'alliance-headquarters'; allianceId: number }
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
  ...(overrides.surface === undefined ? {} : { surface: overrides.surface }),
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

const gear = (id: string): HTMLElement => {
  const button = document.getElementById(`caelestis-overlay-button-${id}`)
  if (button === null) throw new Error(`no gear button for ${id}`)
  return button
}

const railModel = (control: HTMLElement): { id: string; expanded?: boolean } =>
  (control as HTMLElement & { model: { id: string; expanded?: boolean } }).model

const floatingPosition = (element: HTMLElement): { x: number; y: number } => {
  const root = element.getRootNode()
  const positioned = root instanceof ShadowRoot ? (root.host as HTMLElement) : element
  return { x: Number.parseFloat(positioned.style.left), y: Number.parseFloat(positioned.style.top) }
}

const focusedControl = async (): Promise<string | undefined> => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  let active = document.activeElement
  while (active instanceof HTMLElement) {
    const nested = active.shadowRoot?.activeElement
    if (!(nested instanceof HTMLElement)) break
    active = nested
  }
  return active instanceof HTMLElement ? active.dataset.caelestisControl : undefined
}

const menu = (): HTMLElement => {
  const el = document.getElementById('caelestis-overlay-menu')
  if (el === null) throw new Error('no overlay menu')
  return el
}

const menuRoot = async (): Promise<ParentNode> => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  return menu().shadowRoot ?? menu()
}

const byKey = async (key: string): Promise<HTMLElement> => {
  const selector = `[data-caelestis-control="${key}"]`
  let candidate = document.querySelector(selector)
  if (candidate === null) candidate = (await menuRoot()).querySelector(selector)
  else await new Promise((resolve) => setTimeout(resolve, 0))
  const el =
    candidate?.tagName.toLowerCase() === 'caelestis-rail-control'
      ? (candidate.shadowRoot?.querySelector('button') ?? candidate)
      : candidate
  if (el === null) throw new Error(`no control keyed ${key}`)
  return el as HTMLElement
}

const pixelPreset = async (id: 'small' | 'full' | 'corner'): Promise<HTMLButtonElement> => {
  const el = (await menuRoot()).querySelector(`[data-caelestis-pixel-preset="${id}"]`)
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
  input.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }))
  input.value = to
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

/** Choose a corner-rounding value through #65's deformable-pixel control. */
const setRadius = async (to = '1'): Promise<void> =>
  drag((await byKey('radius')) as HTMLInputElement, to)

const errorText = async (): Promise<string | null> =>
  (await menuRoot()).querySelector('[data-caelestis-error]')?.textContent ?? null

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
  it('uses the same placement rail and follows an alliance artboard pan', async () => {
    const surface = { kind: 'alliance-headquarters', allianceId: 535_245 } as const
    harness.localTemplates.mockReturnValue([
      template({ surface, originX: -100, originY: -100, width: 20 }),
    ])
    harness.isMoving.mockReturnValue(true)
    harness.movingId.mockReturnValue('a')
    harness.placementSeq.mockReturnValue(1)
    const stage = document.createElement('div')
    const frame = document.createElement('div')
    const canvas = document.createElement('canvas')
    const dialog = document.createElement('dialog')
    dialog.setAttribute('open', '')
    frame.append(canvas)
    stage.append(frame)
    dialog.append(stage)
    document.body.append(dialog)
    let frameLeft = 200
    frame.getBoundingClientRect = () =>
      ({
        left: frameLeft,
        top: 100,
        right: frameLeft + 500,
        bottom: 600,
        width: 500,
        height: 500,
      }) as DOMRect
    const active: ActiveAllianceSurface = {
      surface,
      stage,
      frame,
      draftId: null,
      bounds: { minX: -125, minY: -125, maxX: 125, maxY: 125 },
    }
    const overlayMenu = await import('./overlay-menu.js')
    const allianceRender = overlayMenu.renderAllianceOverlayControls

    allianceRender(
      vi.fn(),
      active,
      { originX: -125, originY: -125, width: 250, height: 250 },
      canvas,
    )
    const apply = document.querySelector<HTMLElement>('[data-caelestis-control="apply-move"]')
    expect(apply).not.toBeNull()
    expect(apply?.parentElement).toBe(dialog)
    expect(floatingPosition(apply as HTMLElement).x).toBe(296)

    frameLeft = 260
    allianceRender(
      vi.fn(),
      active,
      { originX: -125, originY: -125, width: 250, height: 250 },
      canvas,
    )

    expect(floatingPosition(apply as HTMLElement).x).toBe(356)

    harness.isMoving.mockReturnValue(false)
    harness.movingId.mockReturnValue(null)
    harness.placementSeq.mockReturnValue(null)
    allianceRender(
      vi.fn(),
      active,
      { originX: -125, originY: -125, width: 250, height: 250 },
      canvas,
    )
    expect(gear('a').parentElement).toBe(dialog)
    overlayMenu.toggleOverlayMenu('a', () =>
      allianceRender(
        vi.fn(),
        active,
        { originX: -125, originY: -125, width: 250, height: 250 },
        canvas,
      ),
    )
    await settle()
    expect(menu().parentElement).toBe(dialog)
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

    await setRadius()
    rerender()
    ;(await byKey('swatch:1')).click()
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

    await setRadius()
    ;(await byKey('swatch:1')).click()
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

    ;(await byKey('swatch:1')).click()
    await settle()
    rerender()
    ;(await byKey('swatch:2')).click()
    await settle()

    expect(appearanceWritten(0).hiddenColours).toEqual([1])
    expect(appearanceWritten(1).hiddenColours).toEqual([1, 2])
  })

  it('removes the local controls when hidden and restores only the kebab when shown elsewhere', async () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    ;(await byKey('hide')).click()
    await settle()
    harness.localTemplates.mockReturnValue([template({ visible: false })])
    rerender()
    expect(document.getElementById('caelestis-overlay-button-a')).toBeNull()
    expect(document.getElementById('caelestis-overlay-menu')).toBeNull()
    expect(document.querySelector('[data-caelestis-rail-action]')).toBeNull()

    harness.localTemplates.mockReturnValue([template()])
    rerender()

    expect(gear('a').tagName).toBe('CAELESTIS-RAIL-CONTROL')
    expect(document.getElementById('caelestis-overlay-menu')).toBeNull()
    expect(harness.setLocalVisible).toHaveBeenCalledOnce()
    expect(harness.setLocalVisible).toHaveBeenCalledWith('a', false)
  })

  it('removes controls when a visible template is inside a hidden ancestor folder', async () => {
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

  it('rebuilds for the template whose gear was clicked', async () => {
    harness.localTemplates.mockReturnValue([template(), template({ id: 'b', name: 'beta.png' })])
    rerender()
    gear('a').click()
    rerender()
    expect((await menuRoot()).textContent).toContain('alpha.png')

    gear('b').click()
    rerender()

    expect((await menuRoot()).textContent).toContain('beta.png')
    expect((await menuRoot()).textContent).not.toContain('alpha.png')
  })

  it('follows a rename into the menu title and the gear tooltip', async () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    harness.localTemplates.mockReturnValue([template({ name: 'renamed.png' })])
    rerender()

    expect((await menuRoot()).textContent).toContain('renamed.png')
    expect(gear('a').title).toBe('renamed.png — display options (T)')
  })

  it('keeps a dragged slider alive across the repaint it causes', async () => {
    harness.localTemplates.mockReturnValue([template({ appearance: { opacity: 0.4 } })])
    rerender()
    gear('a').click()
    rerender()
    const before = (await byKey('opacity')) as HTMLInputElement
    before.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }))

    harness.localTemplates.mockReturnValue([template({ appearance: { opacity: 0.45 } })])
    rerender()

    // The element is not replaced under the pointer; the value it holds is in `drafts` either way.
    expect(await byKey('opacity')).toBe(before)
  })

  it('keeps the Mismatches Size track under the pointer on input', async () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    const before = (await menuRoot()).querySelector<HTMLInputElement>(
      'input[type="range"]:not([data-caelestis-control])',
    )
    if (before === null) throw new Error('no Mismatches Size track')

    before.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }))
    before.value = '17'
    before.dispatchEvent(new Event('input', { bubbles: true }))

    expect(
      (await menuRoot()).querySelector('input[type="range"]:not([data-caelestis-control])'),
    ).toBe(before)
  })

  it('moves an unfocused slider to a value changed elsewhere', async () => {
    harness.localTemplates.mockReturnValue([template({ appearance: { opacity: 0.4 } })])
    rerender()
    gear('a').click()
    rerender()
    expect(((await byKey('opacity')) as HTMLInputElement).value).toBe('0.4')

    harness.localTemplates.mockReturnValue([template({ appearance: { opacity: 0.9 } })])
    rerender()

    // Outside the signature must not mean frozen: another tab can move this.
    expect(((await byKey('opacity')) as HTMLInputElement).value).toBe('0.9')
  })

  it('writes once per slider drag, on release', async () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    const opacity = (await byKey('opacity')) as HTMLInputElement
    opacity.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }))

    for (const value of ['0.5', '0.55', '0.6']) {
      opacity.value = value
      opacity.dispatchEvent(new Event('input', { bubbles: true }))
    }
    await settle()
    // Each of those used to be a durable write that also cleared the stamped-tile cache.
    expect(harness.setAppearance).not.toHaveBeenCalled()

    opacity.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }))
    await settle()

    expect(harness.setAppearance).toHaveBeenCalledTimes(1)
    expect(appearanceWritten(0).opacity).toBe(0.6)
  })

  it('owns, toggles, and sizes the contrast outline locally', async () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    const toggle = (await byKey('contrastOutline')) as HTMLInputElement
    expect(toggle.checked).toBe(true)
    toggle.click()
    await settle()

    expect(harness.setOwnsGroup).toHaveBeenCalledWith('a', 'pixels', true)
    expect(appearanceWritten(0).contrastOutline).toBe(false)

    harness.localTemplates.mockReturnValue([
      template({ appearance: { contrastOutline: true, contrastOutlineSize: 0.85 } }),
    ])
    rerender()
    const thickness = (await byKey('contrastOutlineSize')) as HTMLInputElement
    drag(thickness, '1.25')
    await settle()

    expect(appearanceWritten(1).contrastOutlineSize).toBe(1.25)
  })

  it('makes local outline thickness inert while the outline is off', async () => {
    harness.localTemplates.mockReturnValue([
      template({ appearance: { contrastOutline: false, contrastOutlineSize: 0.85 } }),
    ])
    rerender()
    gear('a').click()
    rerender()

    expect(((await byKey('contrastOutlineSize')) as HTMLInputElement).disabled).toBe(true)
  })
})

describe('controls are reconciled against the templates that exist', () => {
  it('closes the open menu of a template deleted elsewhere', async () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    expect(document.getElementById('caelestis-overlay-menu')).not.toBeNull()

    harness.localTemplates.mockReturnValue([])
    rerender()

    expect(document.getElementById('caelestis-overlay-menu')).toBeNull()
  })

  it('strips every control when the map host is gone', async () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    mapCanvas.remove()

    rerender()

    expect(document.getElementById('caelestis-overlay-button-a')).toBeNull()
    expect(document.getElementById('caelestis-overlay-menu')).toBeNull()
  })

  it('gives no control to a template that is entirely off screen', async () => {
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
    ;(await byKey('delete')).click()
    ;(await byKey('confirm-delete')).click()
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
    ;(await byKey('delete')).click()
    ;(await byKey('confirm-delete')).click()
    await settle()

    expect(document.getElementById('caelestis-overlay-menu')).not.toBeNull()
    expect(await errorText()).toContain('Could not delete')
    expect(harness.removeTreeStateKeys).not.toHaveBeenCalled()
  })

  it('says so when Move is refused because a placement is already running', async () => {
    harness.isMoving.mockReturnValue(true)
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    ;(await byKey('move')).click()

    expect(harness.beginMove).not.toHaveBeenCalled()
    expect(document.getElementById('caelestis-overlay-menu')).not.toBeNull()
    expect(await errorText()).toContain('placement already in progress')
  })
})

describe('a rebuild does not take the interaction with it', () => {
  it('keeps the keyboard where it was', async () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    ;(await byKey('swatch:5')).focus()

    harness.localTemplates.mockReturnValue([template({ name: 'renamed.png' })])
    rerender()

    expect(await focusedControl()).toBe('swatch:5')
  })

  it('moves focus into the menu when it opens', async () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()

    gear('a').click()
    rerender()

    expect(await focusedControl()).toBe('hide')
  })
})

describe('the menu controls announce their state', () => {
  it('uses the rail-sized kebab trigger', async () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()

    const button = gear('a')
    expect(button.tagName).toBe('CAELESTIS-RAIL-CONTROL')
    expect(button.style.width).toBe(`${RAIL_BUTTON}px`)
    expect(button.style.height).toBe(`${RAIL_BUTTON}px`)
    expect(button.style.transform).toBe('')
    expect(button.style.willChange).toBe('')
    expect(railModel(button).id).toBe('overlay-menu')
  })

  it('labels the hide action without announcing a contradictory toggle state', async () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    const hide = await byKey('hide')
    expect(hide.getAttribute('aria-label')).toBe('Hide this overlay')
    expect(hide.hasAttribute('aria-pressed')).toBe(false)
  })

  it('tells assistive technology the gear owns a dialog', async () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    expect(railModel(gear('a')).expanded).toBe(false)

    gear('a').click()
    rerender()

    expect(railModel(gear('a')).expanded).toBe(true)
    expect(gear('a').getAttribute('aria-haspopup')).toBe('dialog')
    expect(menu().getAttribute('role')).toBe('dialog')
  })

  it('expands hide, move, and delete as rail-sized buttons outside the menu', async () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    const actions = [...document.querySelectorAll('[data-caelestis-rail-action]')]
    expect(actions).toHaveLength(3)
    expect((await menuRoot()).querySelector('[data-caelestis-rail-action]')).toBeNull()
    for (const action of actions) {
      expect((action as HTMLElement).tagName).toBe('CAELESTIS-RAIL-CONTROL')
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

  it('replaces the local menu rail with apply and cancel during its move', async () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    const { x: left, y: top } = floatingPosition(gear('a'))
    gear('a').click()
    rerender()

    ;(await byKey('move')).click()
    rerender()

    expect(document.getElementById('caelestis-overlay-button-a')).toBeNull()
    expect(document.getElementById('caelestis-overlay-menu')).toBeNull()
    expect(document.querySelector('[data-caelestis-rail-action]')).toBeNull()
    const apply = await byKey('apply-move')
    const cancel = await byKey('cancel-move')
    expect(floatingPosition(apply)).toEqual({ x: left, y: top })
    expect(floatingPosition(cancel)).toEqual({ x: left, y: top + RAIL_BUTTON + GAP })

    apply.click()
    expect(harness.commitMove).toHaveBeenCalledOnce()
    expect(harness.abortMove).not.toHaveBeenCalled()
  })

  it('cancels from the placement rail and restores the kebab after the move ends', async () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    ;(await byKey('move')).click()
    rerender()

    ;(await byKey('cancel-move')).click()
    expect(harness.abortMove).toHaveBeenCalledOnce()

    harness.isMoving.mockReturnValue(false)
    harness.movingId.mockReturnValue(null)
    harness.placementSeq.mockReturnValue(null)
    rerender()
    expect(document.querySelector('[data-caelestis-placement-action]')).toBeNull()
    expect(gear('a').tagName).toBe('CAELESTIS-RAIL-CONTROL')
  })
})

describe('placement and geometry', () => {
  it('anchors the gear to the move preview while one is running', async () => {
    harness.localTemplates.mockReturnValue([template({ originX: 0, originY: 0 })])
    harness.previewOriginFor.mockReturnValue({ x: 500, y: 600 })
    rerender()

    // The previewed origin, not the durable one. The far corner is derived from the scale rather
    // than projected again, so the two calls cannot resolve to different wrapped world copies.
    expect(harness.screenPointFor).toHaveBeenCalledWith(500, 600)
    expect(harness.screenPointFor).not.toHaveBeenCalledWith(0, 0)
  })

  it('keeps the menu clear of the left viewport edge', async () => {
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

  it('remeasures after a custom-element menu first connects at zero height', async () => {
    let menuMeasurements = 0
    Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
      const isMenu = this instanceof HTMLElement && this.dataset.caelestisSignature !== undefined
      const height = isMenu && ++menuMeasurements > 1 ? 200 : 0
      return {
        width: isMenu ? 240 : 0,
        height,
        top: 0,
        left: 0,
        right: isMenu ? 240 : 0,
        bottom: height,
        x: 0,
        y: 0,
      } as DOMRect
    }
    harness.localTemplates.mockReturnValue([template()])
    rerender()

    gear('a').click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(menu().style.maxHeight).toBe('200px')
  })

  it('keeps its trigger and menu clear of the right-hand button rail', async () => {
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

  it('clears the wider logged-out account controls', () => {
    const restore = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { value: 800, configurable: true })
    onTestFinished(() => {
      Object.defineProperty(window, 'innerWidth', { value: restore, configurable: true })
    })
    menuMeasures(200, 240)

    const accountControls = document.createElement('div')
    accountControls.getBoundingClientRect = () =>
      ({ left: 700, right: 792, top: 8, bottom: 156, width: 92, height: 148 }) as DOMRect
    const login = document.createElement('button')
    login.textContent = 'Log in'
    const nativeRail = document.createElement('div')
    const leaderboard = document.createElement('button')
    leaderboard.title = 'Leaderboard'
    const search = document.createElement('button')
    search.title = 'Search'
    nativeRail.append(leaderboard, search)
    accountControls.append(login, nativeRail)
    document.body.append(accountControls)

    harness.localTemplates.mockReturnValue([template({ originX: 795 })])
    rerender()

    const usableRight = 700 - GAP
    expect(floatingPosition(gear('a')).x + RAIL_BUTTON).toBeLessThanOrEqual(usableRight)
  })

  it('remeasures the menu when an appearance group expands', async () => {
    harness.ownsGroup.mockReturnValue(false)
    onTestFinished(() => {
      harness.ownsGroup.mockReturnValue(true)
    })
    menuMeasures(() =>
      menu().shadowRoot?.querySelector('.section-toggle')?.getAttribute('aria-expanded') === 'true'
        ? 300
        : 100,
    )
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    expect(menu().style.maxHeight).toBe('100px')

    byText(await menuRoot(), 'Pixels').click()

    expect(menu().style.maxHeight).toBe('300px')
  })

  it('keeps the local menu and both action rails clear of an open main panel', async () => {
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

    ;(await byKey('move')).click()
    rerender()
    for (const action of document.querySelectorAll<HTMLElement>(
      '[data-caelestis-placement-action]',
    )) {
      expect(floatingPosition(action).x + RAIL_BUTTON).toBeLessThanOrEqual(usableRight)
    }
  })

  it('samples an open panel boundary once before positioning multiple template controls', async () => {
    const panel = document.createElement('aside')
    panel.id = PANEL_ID
    const measure = vi.fn(
      () => ({ left: 500, right: 800, top: 8, bottom: 760, width: 300, height: 752 }) as DOMRect,
    )
    panel.getBoundingClientRect = measure
    document.body.appendChild(panel)
    harness.localTemplates.mockReturnValue([
      template(),
      template({ id: 'b', name: 'beta.png', originX: 100 }),
    ])

    rerender()

    expect(measure).toHaveBeenCalledOnce()
  })

  it('opens the menu to the right when that side has space', async () => {
    menuMeasures(200, 240)
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    expect(Number.parseFloat(menu().style.left)).toBeGreaterThan(
      floatingPosition(gear('a')).x + RAIL_BUTTON,
    )
  })

  it('keeps the expanded action rail inside the viewport', async () => {
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

  it('sits below the panel rather than over it', async () => {
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
    ;(await byKey('hide')).click()

    gear('b').click()
    rerender()
    release()
    await settle()

    // "Could not change visibility for alpha.png" under beta.png's heading is worse than silence.
    expect(await errorText()).toBeNull()
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
    ;(await byKey('delete')).click()
    ;(await byKey('confirm-delete')).click()

    gear('b').click()
    rerender()
    release()
    await settle()

    expect(document.getElementById('caelestis-overlay-menu')).not.toBeNull()
    expect(menu().dataset.caelestisTemplate).toBe('b')
  })

  it('keeps a carried delete question naming the template as it is now', async () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    ;(await byKey('delete')).click()

    harness.localTemplates.mockReturnValue([template({ name: 'renamed.png' })])
    rerender()

    expect((await menuRoot()).querySelector('[data-caelestis-confirm]')?.textContent).toContain(
      'renamed.png',
    )
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

    ;(await byKey('hide')).click() // hide
    ;(await byKey('hide')).click() // show
    ;(await byKey('hide')).click() // hide
    settled[0]?.()
    await settle()

    // The first request's `false` matches the third's, so releasing intent by value would hand
    // ownership back to the store and the menu would flip to "Hide" while a hide is still pending.
    expect(harness.setLocalVisible.mock.calls[0]?.[1]).toBe(false)
    expect((await byKey('hide')).getAttribute('aria-label')).toBe('Show this overlay')
  })

  it('keeps a refused shape reported when a colour change succeeds', async () => {
    let call = 0
    harness.setAppearance.mockImplementation(async () => ++call !== 1)
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    await setRadius()
    ;(await byKey('swatch:1')).click()
    await settle()

    // The colour landed and the shape did not. One shared `appearance` bucket would let the
    // colour's success clear the shape's banner, and the overlay ends up Full with nothing said.
    expect(await errorText()).toContain('Could not change rounding')
    expect(((await byKey('radius')) as HTMLInputElement).value).toBe('0')
  })

  it('clears a refused write once the same property succeeds', async () => {
    let call = 0
    harness.setAppearance.mockImplementation(async () => ++call !== 1)
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    await setRadius()
    await settle()
    expect(await errorText()).toContain('Could not change rounding')
    await setRadius('0.5')
    await settle()

    expect(await errorText()).toBeNull()
  })

  it('puts a refused slider back where the store still is', async () => {
    harness.setAppearance.mockResolvedValue(false)
    harness.localTemplates.mockReturnValue([template({ appearance: { opacity: 0.4 } })])
    rerender()
    gear('a').click()
    rerender()
    const opacity = (await byKey('opacity')) as HTMLInputElement

    // Focused, but the gesture is over: `change` has fired. Guarding the refresh on focus rather
    // than on an in-progress gesture leaves the refused value sitting on the thumb indefinitely.
    opacity.focus()
    opacity.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }))
    drag(opacity, '0.9')
    await settle()

    // The map reverted; a thumb left at the refused value says the change took. Re-queried
    // because the refusal is state, so the menu is rebuilt from it rather than patched.
    expect(((await byKey('opacity')) as HTMLInputElement).value).toBe('0.4')
  })
})

describe('focus goes somewhere deliberate', () => {
  it('returns to Delete when the question is cancelled', async () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    ;(await byKey('delete')).click()

    byText(await menuRoot(), 'Cancel').click()
    rerender()

    expect(await focusedControl()).toBe('delete')
  })

  it('announces the destructive question rather than a bare Delete', async () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    ;(await byKey('delete')).click()

    const box = (await menuRoot()).querySelector('[data-caelestis-confirm]')
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

    ;(await byKey('hide')).click()
    // Anything at all, while the hide is still in flight.
    await setRadius()
    release()
    await settle()

    // Tying the report to "am I still the latest request" makes any second click silence the first
    // one's failure, which is the whole guarantee this menu exists to keep.
    expect(await errorText()).toContain('Could not change visibility')
  })

  it('reports a write that threw rather than stranding the intent', async () => {
    harness.setAppearance.mockRejectedValue(new Error('IndexedDB is gone'))
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    await setRadius()
    await settle()

    expect(await errorText()).toContain('Could not change rounding')
    // Intent released: the menu must not keep asserting a shape that was never saved.
    expect(((await byKey('radius')) as HTMLInputElement).value).toBe('0')
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
    ;(await byKey('hide')).click()

    // Pan the template out of view, let the refusal land, pan back.
    harness.localTemplates.mockReturnValue([template({ originX: 50_000, originY: 50_000 })])
    rerender()
    release()
    await settle()
    harness.localTemplates.mockReturnValue([template()])
    rerender()

    expect(await errorText()).toContain('Could not change visibility')
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
    ;(await byKey('hide')).click()

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
    expect(await errorText()).toContain('Could not change visibility')
  })

  it('forgets a template that has actually gone', async () => {
    harness.setLocalVisible.mockResolvedValue(false)
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    ;(await byKey('hide')).click()
    await settle()
    expect(await errorText()).toContain('Could not change visibility')

    harness.localTemplates.mockReturnValue([])
    rerender()
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    expect(await errorText()).toBeNull()
  })
})

describe('a delete already under way cannot be re-asked', () => {
  it('will not raise a fresh question over a running delete', async () => {
    harness.removeLocalTemplate.mockImplementation(() => new Promise<boolean>(() => {}))
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    ;(await byKey('delete')).click()
    rerender()
    ;(await byKey('confirm-delete')).click()
    rerender()

    // Disabling the question's own buttons is not enough while this one can raise a new question
    // with a fresh, live Cancel over a delete that is already running.
    expect((await byKey('delete')).getAttribute('aria-disabled')).toBe('true')
    expect((await byKey('cancel-delete')).getAttribute('aria-disabled')).toBe('true')
    expect((await byKey('confirm-delete')).textContent).toBe('Deleting…')
  })
})

describe('the slider is only frozen while a gesture is actually in progress', () => {
  it('applies a pixel preset as one editable six-slider change', async () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    expect((await pixelPreset('small')).getAttribute('aria-pressed')).toBe('false')
    ;(await pixelPreset('corner')).click()
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

  it('offers the whole 0..1 range the store accepts', async () => {
    // `normaliseAppearance` runs on a conflict's remote winner, so another client's 0 arrives here.
    harness.localTemplates.mockReturnValue([template({ appearance: { opacity: 0 } })])
    rerender()
    gear('a').click()
    rerender()

    const opacity = (await byKey('opacity')) as HTMLInputElement
    expect(opacity.min).toBe('0.05')
    expect(opacity.value).toBe('0.05')
  })

  it('represents the default size exactly rather than snapping off it', async () => {
    harness.localTemplates.mockReturnValue([template({ appearance: { radius: 1 } })])
    rerender()
    gear('a').click()
    rerender()

    expect(Number(((await byKey('size')) as HTMLInputElement).value)).toBe(DEFAULT_APPEARANCE.size)
  })

  it('resets one owned slider to the value inherited from settings', async () => {
    harness.localTemplates.mockReturnValue([template({ appearance: { size: 0.8 } })])
    rerender()
    gear('a').click()
    rerender()

    const input = (await byKey('size')) as HTMLInputElement
    const reset = input
      .closest('label')
      ?.querySelector<HTMLButtonElement>('[aria-label="Reset size"]')
    expect(reset?.hidden).toBe(false)
    reset?.click()

    await vi.waitFor(() =>
      expect(harness.setAppearance).toHaveBeenCalledWith(
        'a',
        expect.objectContaining({ size: DEFAULT_APPEARANCE.size }),
      ),
    )
  })
})

describe('the menu is ours and has a keyboard exit', () => {
  it('offers move and delete for an unpublished server overlay an admin owns', async () => {
    connectServerTemplate(false)
    harness.localTemplates.mockReturnValue([template({ serverUrl: 'https://example.test' })])
    rerender()
    gear('a').click()
    rerender()

    expect(await byKey('move')).not.toBeNull()
    expect(await byKey('delete')).not.toBeNull()
    expect(await byKey('hide')).not.toBeNull()
  })

  it('keeps published server actions visible but requires unpublishing first', async () => {
    connectServerTemplate(true)
    harness.localTemplates.mockReturnValue([template({ serverUrl: 'https://example.test' })])
    rerender()
    gear('a').click()
    rerender()

    expect((await byKey('move')).getAttribute('aria-disabled')).toBe('true')
    expect((await byKey('delete')).getAttribute('aria-disabled')).toBe('true')
    ;(await byKey('move')).click()
    rerender()

    expect(await errorText()).toContain('Unpublish this template before moving it')
    expect(harness.beginServerMove).not.toHaveBeenCalled()
  })

  it('does not offer server mutations without admin access', async () => {
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

    ;(await byKey('move')).click()
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

    ;(await byKey('delete')).click()
    rerender()
    ;(await byKey('confirm-delete')).click()
    await settle()

    expect(harness.deleteServerTemplate).toHaveBeenCalledWith(harness.servers[0], 'remote-a', {
      version: 'version-1',
      updatedAt: 1,
    })
    expect(harness.removeLocalTemplate).not.toHaveBeenCalled()
    expect(harness.forgetServerTemplate).toHaveBeenCalledWith('a')
    expect(harness.listServerContents).toHaveBeenCalledWith(harness.servers[0])
  })

  it('closes on Escape and hands focus back to the gear', async () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    ;(await byKey('hide')).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }),
    )
    rerender()

    expect(document.getElementById('caelestis-overlay-menu')).toBeNull()
    expect(document.activeElement).toBe(gear('a'))
  })

  it('leaves the keyboard off the gear while the placement it started is running', async () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    ;(await byKey('move')).click()
    rerender()

    expect(harness.beginMove).toHaveBeenCalledWith('a', expect.any(Function))
    // `move.ts` ignores keys aimed at a page control, so a focused gear would take Escape and Enter
    // away from the placement — and Enter would reopen this menu instead of applying it.
    expect(document.getElementById('caelestis-overlay-button-a')).toBeNull()
    expect(document.activeElement).not.toBe(await byKey('apply-move'))
    expect(document.activeElement).not.toBe(await byKey('cancel-move'))
  })
})

describe('a delete under way owns the template', () => {
  it('does not queue the delete behind this menu’s own writes', async () => {
    // `removeLocalTemplate` sets the store's terminal guard synchronously; that is what stops an
    // in-flight save resurrecting the record. Queueing it behind a slow visibility write means the
    // guard is not set until the bitmaps finish.
    harness.setLocalVisible.mockImplementation(() => new Promise<boolean>(() => {}))
    harness.removeLocalTemplate.mockImplementation(() => new Promise<boolean>(() => {}))
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    ;(await byKey('hide')).click()
    rerender()
    ;(await byKey('delete')).click()
    rerender()
    ;(await byKey('confirm-delete')).click()

    expect(harness.removeLocalTemplate).toHaveBeenCalledWith('a')
  })

  it('stops offering Move and Hide while the delete runs', async () => {
    harness.removeLocalTemplate.mockImplementation(() => new Promise<boolean>(() => {}))
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    ;(await byKey('delete')).click()
    rerender()
    ;(await byKey('confirm-delete')).click()
    rerender()

    // Starting a placement for a record that is about to stop existing strands the placement bar.
    expect((await byKey('move')).getAttribute('aria-disabled')).toBe('true')
    expect((await byKey('hide')).getAttribute('aria-disabled')).toBe('true')
  })
})

describe('interaction outranks a repaint', () => {
  it('does not arm a focus jump when the question is already open', async () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    ;(await byKey('delete')).click()
    rerender()
    ;(await byKey('close')).focus()

    ;(await byKey('delete')).click()
    rerender()
    // An unrelated rebuild later on must not consume a leftover request and jump to Delete.
    harness.localTemplates.mockReturnValue([template({ name: 'renamed.png' })])
    rerender()

    expect(await focusedControl()).not.toBe('confirm-delete')
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
    ;(await byKey('hide')).click()

    harness.localTemplates.mockReturnValue([template({ name: 'renamed.png' })])
    rerender()
    release()
    await settle()

    expect(await errorText()).toContain('renamed.png')
    expect(await errorText()).not.toContain('alpha.png')
  })

  it('gives Move its own slot rather than the visibility one', async () => {
    harness.setLocalVisible.mockResolvedValue(false)
    harness.isMoving.mockReturnValue(true)
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    ;(await byKey('hide')).click()
    await settle()
    ;(await byKey('move')).click()
    rerender()

    const messages = [...(await menuRoot()).querySelectorAll('[data-caelestis-error]')].map(
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

    ;(await byKey('hide')).click()
    await settle()
    expect((await menuRoot()).querySelector('[data-caelestis-error]')?.getAttribute('role')).toBe(
      'alert',
    )

    ;(await byKey('swatch:1')).click()
    await settle()

    // A rebuild reconstructs the node; a fresh role="alert" would read the old failure out again.
    expect((await menuRoot()).querySelector('[data-caelestis-error]')?.hasAttribute('role')).toBe(
      false,
    )
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
    ;(await byKey('hide')).click()

    // Press and hold the thumb; the hold blocks rebuilds, so the refusal has nowhere to land.
    const opacity = (await byKey('opacity')) as HTMLInputElement
    opacity.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }))
    release()
    await settle()
    expect(await errorText()).toBeNull()

    // Letting go has to let it through: on a static map no other frame is coming.
    opacity.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }))

    expect(await errorText()).toContain('Could not change visibility')
  })

  it('clears the Move refusal once a placement actually starts', async () => {
    harness.isMoving.mockReturnValue(true)
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    ;(await byKey('move')).click()
    rerender()
    expect(await errorText()).toContain('placement already in progress')

    harness.isMoving.mockReturnValue(false)
    harness.isDeletingLocal.mockReturnValue(false)
    ;(await byKey('move')).click()
    rerender()
    harness.isMoving.mockReturnValue(false)
    harness.movingId.mockReturnValue(null)
    harness.placementSeq.mockReturnValue(null)
    rerender()
    gear('a').click()
    rerender()

    // Nothing else ever cleared this one, so it outlived the placement it was about.
    expect(await errorText()).toBeNull()
  })

  it('keeps focus on the confirm button once the delete starts', async () => {
    harness.removeLocalTemplate.mockImplementation(() => new Promise<boolean>(() => {}))
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    ;(await byKey('delete')).click()
    rerender()

    ;(await byKey('confirm-delete')).click()
    rerender()

    // A `disabled` button cannot hold focus, so confirming from the keyboard would drop it to the
    // document at the exact moment a destructive action is running.
    expect(await focusedControl()).toBe('confirm-delete')
    expect((await byKey('confirm-delete')).getAttribute('aria-disabled')).toBe('true')
  })

  it('stops offering the appearance controls while the delete runs', async () => {
    harness.removeLocalTemplate.mockImplementation(() => new Promise<boolean>(() => {}))
    harness.localTemplates.mockReturnValue([template({ appearance: { radius: 1 } })])
    rerender()
    gear('a').click()
    rerender()
    ;(await byKey('delete')).click()
    rerender()
    ;(await byKey('confirm-delete')).click()
    rerender()

    // The store refuses these anyway, leaving a meaningless banner beside "Deleting…".
    // `readonly` does nothing to a range in any browser, so the lock has to refuse the gesture.
    const opacity = (await byKey('opacity')) as HTMLInputElement
    expect(opacity.getAttribute('aria-disabled')).toBe('true')
    const press = new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, cancelable: true })
    opacity.dispatchEvent(press)
    expect(press.defaultPrevented).toBe(true)
    expect((await byKey('swatch:1')).getAttribute('aria-disabled')).toBe('true')
  })
})

describe('the delete question is retracted by the gestures that dismiss it', () => {
  it('does not come back armed after the menu is closed', async () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    ;(await byKey('delete')).click()
    rerender()

    ;(await byKey('close')).click()
    rerender()
    gear('a').click()
    rerender()

    expect((await menuRoot()).querySelector('[data-caelestis-confirm]')).toBeNull()
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

    ;(await byKey('swatch:1')).click()
    ;(await byKey('swatch:2')).click()
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

    await setRadius()
    ;(await byKey('hide')).click()
    await settle()

    // One shared intent, released only by its latest owner, keeps asserting the refused shape for
    // as long as the visibility write is outstanding — and that one never resolves.
    expect(((await byKey('radius')) as HTMLInputElement).value).toBe('0')
    expect(await errorText()).toContain('Could not change rounding')
  })

  it('names the property a refusal is about', async () => {
    harness.setAppearance.mockResolvedValue(false)
    harness.localTemplates.mockReturnValue([template({ appearance: { radius: 1 } })])
    rerender()
    gear('a').click()
    rerender()

    await setRadius('0')
    await settle()
    const size = (await byKey('size')) as HTMLInputElement
    drag(size, '0.5')
    await settle()

    const messages = [...(await menuRoot()).querySelectorAll('[data-caelestis-error]')].map(
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

    const opacity = (await byKey('opacity')) as HTMLInputElement
    opacity.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }))
    drag(opacity, '0.9')
    await settle()

    // Releasing the hold repaints, and the repaint puts the stored value back into this very input.
    // Reading after that commits the value the user just dragged away from.
    expect(appearanceWritten(0).opacity).toBe(0.9)
  })
})

describe('a delete owns the template whichever surface started it', () => {
  it('refuses Move for a template the store has already condemned', async () => {
    harness.isDeletingLocal.mockReturnValue(true)
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    // The panel's delete sets the store's terminal guard and then does its IndexedDB work with the
    // record still present. Reading only our own flag starts a placement for a doomed template.
    expect((await byKey('move')).getAttribute('aria-disabled')).toBe('true')
    expect((await byKey('delete')).getAttribute('aria-disabled')).toBe('true')
  })

  it('keeps the progress box when the menu is closed mid-delete', async () => {
    harness.removeLocalTemplate.mockImplementation(() => new Promise<boolean>(() => {}))
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    ;(await byKey('delete')).click()
    rerender()
    ;(await byKey('confirm-delete')).click()
    rerender()

    ;(await byKey('close')).click()
    rerender()
    gear('a').click()
    rerender()

    // Without it the controls are all disabled with nothing on screen explaining why.
    expect((await menuRoot()).querySelector('[data-caelestis-confirm]')).not.toBeNull()
  })

  it('opens onto a control that can take focus while a delete runs', async () => {
    harness.isDeletingLocal.mockReturnValue(true)
    harness.localTemplates.mockReturnValue([template()])
    rerender()

    gear('a').click()
    rerender()

    // Hide is disabled during a delete, and a disabled control cannot hold focus.
    expect(await focusedControl()).toBe('close')
  })

  it('forgets a template deleted while the map was detached', async () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    ;(await byKey('delete')).click()
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
    expect((await menuRoot()).querySelector('[data-wts-confirm]')).toBeNull()
  })
})

describe('a delete that becomes terminal after the menu exists', () => {
  it('refuses the action even from a menu built before the delete', async () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    const move = await byKey('move')
    const hide = await byKey('hide')

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

    ;(await byKey('swatch:1')).click()
    rerender()
    expect((await byKey('swatch:1')).getAttribute('aria-pressed')).toBe('false')
    ;(await byKey('swatch:1')).click()
    rerender()

    // The updater is a toggle. Latest-wins makes the second click read as no change at all, while
    // the queued writes compose back to visible — the menu and the map disagreeing.
    expect((await byKey('swatch:1')).getAttribute('aria-pressed')).toBe('true')
  })

  it('writes once for a held arrow key, not once per repeat', async () => {
    harness.localTemplates.mockReturnValue([template({ appearance: { radius: 1 } })])
    rerender()
    gear('a').click()
    rerender()
    const size = (await byKey('size')) as HTMLInputElement

    size.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' }))
    for (const value of ['0.4', '0.45', '0.5']) {
      size.value = value
      size.dispatchEvent(new Event('input', { bubbles: true }))
      size.dispatchEvent(new Event('change', { bubbles: true }))
    }
    await settle()
    // `size` is in the stamped-tile cache key, so one write per key repeat re-stamps at scale 3.
    expect(harness.setAppearance).not.toHaveBeenCalled()

    size.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'ArrowRight' }))
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
    const opacity = (await byKey('opacity')) as HTMLInputElement

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
    const opacity = (await byKey('opacity')) as HTMLInputElement

    // Tab does not move the thumb, and its keyup lands on whatever it focused next.
    opacity.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Tab' }))
    drag(opacity, '0.7')
    await settle()

    expect(harness.setAppearance).toHaveBeenCalledTimes(1)
    expect(appearanceWritten(0).opacity).toBe(0.7)
  })
})

describe('a held slider holds its own menu, not the next one', () => {
  it('still switches templates while a slider is held', async () => {
    harness.localTemplates.mockReturnValue([template(), template({ id: 'b', name: 'beta.png' })])
    rerender()
    gear('a').click()
    rerender()
    ;((await byKey('opacity')) as HTMLInputElement).dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }),
    )

    gear('b').click()
    rerender()

    // Two touches: one holding A's thumb, one tapping B's gear. Keeping A's menu would park A's
    // handlers beside B — the wrong-template failure this relay opened with.
    expect(menu().dataset.caelestisTemplate).toBe('b')
    expect((await menuRoot()).textContent).toContain('beta.png')
  })

  it('rebuilds a menu the page has torn off even while held, keeping the value', async () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    ;((await byKey('opacity')) as HTMLInputElement).dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }),
    )

    // A hostile or careless host removes it; the detached control may never see another event.
    const opacity = (await byKey('opacity')) as HTMLInputElement
    opacity.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }))
    opacity.value = '0.62'
    opacity.dispatchEvent(new Event('input', { bubbles: true }))
    menu().remove()
    rerender()
    await settle()

    expect(document.getElementById('caelestis-overlay-menu')).not.toBeNull()
    // And the value the user had reached is not simply thrown away with the node.
    expect(appearanceWritten(0).opacity).toBe(0.62)
  })

  it('commits a marker range when the menu is torn down mid-drag', async () => {
    harness.localTemplates.mockReturnValue([template({ appearance: { markMismatch: true } })])
    rerender()
    gear('a').click()
    rerender()
    const markerSize = (await menuRoot()).querySelector<HTMLInputElement>(
      'input[type="range"]:not([data-caelestis-control])',
    )
    if (markerSize === null) throw new Error('no Mismatches Size track')

    markerSize.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }))
    markerSize.value = '17'
    markerSize.dispatchEvent(new Event('input', { bubbles: true }))
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
    const swatch = (await menuRoot()).querySelector<HTMLElement>(
      'button[aria-label^="Marker colour:"], input[aria-label="Marker colour"]',
    )
    if (swatch === null) throw new Error('no marker colour swatch')
    swatch.click()
    await settle()
    const square = (await menuRoot()).querySelector<HTMLElement>('.caelestis-cp-sv')
    if (square === null) throw new Error('no colour picker square')
    square.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }) as DOMRect
    let captured: number | null = null
    square.setPointerCapture = (pointerId) => {
      captured = pointerId
    }
    square.hasPointerCapture = (pointerId) => captured === pointerId

    square.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, pointerId: 7, clientX: 10, clientY: 90 }),
    )
    square.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, pointerId: 7, clientX: 50, clientY: 50 }),
    )
    rerender()
    square.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, pointerId: 7, clientX: 80, clientY: 20 }),
    )
    await settle()

    expect(harness.setAppearance).not.toHaveBeenCalled()
    square.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7 }))
    await settle()

    expect(harness.setAppearance).toHaveBeenCalledTimes(1)
    expect(appearanceWritten(0).markerColour).toBe('#cc29cc')
  })
})

describe('a refusal retires only when its own subject is satisfied', () => {
  it('retires it when the shape reaches what was asked, from anywhere', async () => {
    harness.setAppearance.mockResolvedValue(false)
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    await setRadius()
    await settle()
    expect(await errorText()).toContain('Could not change rounding')

    // Another tab sets the very shape this refusal was about. Revision is irrelevant — a pending
    // image never persists one at all.
    harness.localTemplates.mockReturnValue([template({ appearance: { radius: 1 } })])
    rerender()

    expect(await errorText()).toBeNull()
  })
})

describe('a delete started elsewhere explains itself', () => {
  it('does not lock the controls natively, so a cleared guard is recoverable', async () => {
    harness.isDeletingLocal.mockReturnValue(true)
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    expect((await byKey('move')).getAttribute('aria-disabled')).toBe('true')

    // A failed panel delete drops the store's guard and notifies nobody. On a static map no frame
    // arrives, so a native `disabled` would leave the menu dead until the map next moved.
    harness.isDeletingLocal.mockReturnValue(false)
    ;(await byKey('move')).click()

    expect(harness.beginMove).toHaveBeenCalledWith('a', expect.any(Function))
  })
})

describe('a slider keeps tracking the store after every kind of gesture', () => {
  it('is not frozen by an arrow press that never produced a change', async () => {
    harness.localTemplates.mockReturnValue([template({ appearance: { opacity: 0.4 } })])
    rerender()
    gear('a').click()
    rerender()
    const opacity = (await byKey('opacity')) as HTMLInputElement

    // A range fires input then change on each arrow press, and `change` under a held key parks the
    // value and returns *before* the dirty marker is cleared.
    opacity.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' }))
    opacity.value = '0.45'
    opacity.dispatchEvent(new Event('input', { bubbles: true }))
    opacity.dispatchEvent(new Event('change', { bubbles: true }))
    opacity.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'ArrowRight' }))
    await settle()

    harness.localTemplates.mockReturnValue([template({ appearance: { opacity: 0.9 } })])
    rerender()

    expect(((await byKey('opacity')) as HTMLInputElement).value).toBe('0.9')
  })
})

describe('the menu belongs to us, and to one template at a time', () => {
  it('retracts a delete question when another template is opened', async () => {
    harness.localTemplates.mockReturnValue([template(), template({ id: 'b', name: 'beta.png' })])
    rerender()
    gear('a').click()
    rerender()
    ;(await byKey('delete')).click()
    rerender()

    gear('b').click()
    rerender()
    gear('a').click()
    rerender()

    // ✕ and Escape both retract it; walking away via another gear must not be the one that leaves
    // a live destructive button waiting.
    expect((await menuRoot()).querySelector('[data-caelestis-confirm]')).toBeNull()
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

    ;(await byKey('swatch:1')).click()
    await settle()
    rerender()

    expect((await byKey('swatch:1')).getAttribute('aria-pressed')).toBe('false')
  })
})

describe('a condemned template is condemned everywhere', () => {
  it('renders the progress box as soon as the store says so', async () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    expect((await menuRoot()).querySelector('[data-caelestis-confirm]')).toBeNull()

    // A delete started from the panel, with the record still present for its IndexedDB round trip.
    harness.isDeletingLocal.mockReturnValue(true)
    rerender()

    expect((await byKey('confirm-delete')).textContent).toBe('Deleting…')
  })

  it('does not resurrect a dismissed question when an external delete fails', async () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    ;(await byKey('delete')).click()
    rerender()

    harness.isDeletingLocal.mockReturnValue(true)
    rerender()
    ;(await byKey('close')).click()
    rerender()
    // The panel's delete fails and drops the guard.
    harness.isDeletingLocal.mockReturnValue(false)
    gear('a').click()
    rerender()

    expect((await menuRoot()).querySelector('[data-caelestis-confirm]')).toBeNull()
  })
})

describe('a locked slider arms nothing', () => {
  it('does not block rebuilds after a refused press', async () => {
    harness.isDeletingLocal.mockReturnValue(true)
    harness.localTemplates.mockReturnValue([template({ appearance: { radius: 1 } })])
    rerender()
    gear('a').click()
    rerender()

    // A prevented native range gesture takes no pointer capture, so releasing outside the input
    // never delivers a `pointerup` here.
    ;(await byKey('opacity')).dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, cancelable: true }),
    )
    harness.localTemplates.mockReturnValue([
      template({ name: 'renamed.png', appearance: { radius: 1 } }),
    ])
    rerender()

    expect((await menuRoot()).textContent).toContain('renamed.png')
  })

  it('commits a drag that returned to its origin rather than losing it', async () => {
    harness.localTemplates.mockReturnValue([template({ appearance: { opacity: 0.4 } })])
    rerender()
    gear('a').click()
    rerender()
    const opacity = (await byKey('opacity')) as HTMLInputElement

    opacity.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }))
    // Another tab moves the store mid-drag; the user still ends where they began.
    harness.localTemplates.mockReturnValue([template({ appearance: { opacity: 0.9 } })])
    opacity.value = '0.7'
    opacity.dispatchEvent(new Event('input', { bubbles: true }))
    opacity.value = '0.4'
    opacity.dispatchEvent(new Event('input', { bubbles: true }))
    opacity.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }))
    await settle()

    // The gesture is what the user asked for, whatever the store did underneath it.
    expect(appearanceWritten(0).opacity).toBe(0.4)
  })
})

describe('focus saved across a teardown is not focus demanded', () => {
  it('leaves the keyboard where the user has since put it', async () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    ;(await byKey('swatch:5')).focus()

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
    const size = (await byKey('size')) as HTMLInputElement

    size.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }))
    size.value = '0.7'
    size.dispatchEvent(new Event('input', { bubbles: true }))

    expect(harness.setAppearancePreview).toHaveBeenCalledWith('a', 'size', 0.7)
    expect(harness.setAppearance).not.toHaveBeenCalled()

    size.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }))
    await settle()

    expect(harness.clearAppearancePreview).toHaveBeenCalledWith('a', 'size', 0.7)
  })

  it('does not write a stale value for a press that moved nothing', async () => {
    harness.localTemplates.mockReturnValue([template({ appearance: { opacity: 0.4 } })])
    rerender()
    gear('a').click()
    rerender()

    // Press the thumb and never move it, while another tab changes the store.
    ;(await byKey('opacity')).dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }),
    )
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
    const opacity = (await byKey('opacity')) as HTMLInputElement
    opacity.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }))
    opacity.value = '0.55'
    opacity.dispatchEvent(new Event('input', { bubbles: true }))

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
    await setRadius()
    await settle()
    ;(await byKey('close')).click()
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
    const size = (await byKey('size')) as HTMLInputElement
    const opacity = (await byKey('opacity')) as HTMLInputElement

    size.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }))
    size.value = '0.6'
    size.dispatchEvent(new Event('input', { bubbles: true }))
    opacity.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 2 }))
    opacity.value = '0.3'
    opacity.dispatchEvent(new Event('input', { bubbles: true }))
    // Two touches; the second one lifts first.
    opacity.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 2 }))
    await settle()

    // Rebuilding here would remove the size input mid-gesture, and its release would never come.
    expect(await byKey('size')).toBe(size)
    size.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }))
    await settle()
    expect(harness.setAppearance).toHaveBeenCalledWith('a', expect.objectContaining({ size: 0.6 }))
  })

  it('writes an interrupted pair of drafts once each', async () => {
    harness.localTemplates.mockReturnValue([template({ appearance: { radius: 1 } })])
    rerender()
    gear('a').click()
    rerender()
    const size = (await byKey('size')) as HTMLInputElement
    const opacity = (await byKey('opacity')) as HTMLInputElement
    size.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }))
    size.value = '0.6'
    size.dispatchEvent(new Event('input', { bubbles: true }))
    opacity.value = '0.3'
    opacity.dispatchEvent(new Event('input', { bubbles: true }))

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
    const opacity = (await byKey('opacity')) as HTMLInputElement

    opacity.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }))
    opacity.value = '0.7'
    opacity.dispatchEvent(new Event('input', { bubbles: true }))
    // The panel starts a delete; the drag guard has been suppressing rebuilds throughout.
    harness.isDeletingLocal.mockReturnValue(true)
    rerender()
    opacity.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }))
    await settle()

    expect((await byKey('confirm-delete')).textContent).toBe('Deleting…')
  })

  it('announces a second refusal of the same control', async () => {
    harness.setLocalVisible.mockResolvedValue(false)
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    ;(await byKey('hide')).click()
    await settle()
    const first = (await menuRoot()).querySelector('[data-caelestis-error]')
    ;(await byKey('hide')).click()
    await settle()

    // Only Move used to get a second announcement; a deliberate retry of anything deserves one.
    expect((await menuRoot()).querySelector('[data-caelestis-error]')).not.toBe(first)
    expect((await menuRoot()).querySelector('[data-caelestis-error]')?.getAttribute('role')).toBe(
      'alert',
    )
  })
})

describe('a pointer gesture ends wherever the pointer does', () => {
  it('ends a drag released outside the control', async () => {
    harness.localTemplates.mockReturnValue([template({ appearance: { opacity: 0.4 } })])
    rerender()
    gear('a').click()
    rerender()
    const opacity = (await byKey('opacity')) as HTMLInputElement

    opacity.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }))
    opacity.value = '0.65'
    opacity.dispatchEvent(new Event('input', { bubbles: true }))
    // A mouse drag that leaves the range: without pointer capture the release never comes back
    // here, and the gesture — with the rebuild suppression it holds — never ends.
    opacity.dispatchEvent(new PointerEvent('lostpointercapture', { bubbles: true, pointerId: 1 }))
    await settle()

    expect(appearanceWritten(0).opacity).toBe(0.65)
    harness.localTemplates.mockReturnValue([template({ appearance: { opacity: 0.65 } })])
    harness.localTemplates.mockReturnValue([template({ name: 'renamed.png' })])
    rerender()
    expect((await menuRoot()).textContent).toContain('renamed.png')
  })

  it('waits for every pointer on one slider before ending the gesture', async () => {
    harness.localTemplates.mockReturnValue([template({ appearance: { opacity: 0.4 } })])
    rerender()
    gear('a').click()
    rerender()
    const opacity = (await byKey('opacity')) as HTMLInputElement

    // Two pointers on the *same* range. Tracking holds per element makes the first release look
    // like the end of both.
    opacity.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }))
    opacity.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 2 }))
    opacity.value = '0.55'
    opacity.dispatchEvent(new Event('input', { bubbles: true }))
    opacity.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }))
    await settle()
    expect(harness.setAppearance).not.toHaveBeenCalled()

    opacity.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 2 }))
    await settle()

    expect(appearanceWritten(0).opacity).toBe(0.55)
  })

  it('commits a keyboard edit through the blur a real Close click causes', async () => {
    harness.localTemplates.mockReturnValue([template({ appearance: { opacity: 0.4 } })])
    rerender()
    gear('a').click()
    rerender()
    const opacity = (await byKey('opacity')) as HTMLInputElement

    opacity.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' }))
    opacity.value = '0.5'
    opacity.dispatchEvent(new Event('input', { bubbles: true }))
    // The browser blurs the range before the destination button's click runs.
    opacity.dispatchEvent(new Event('blur'))
    ;(await byKey('close')).click()
    rerender()
    await settle()

    expect(appearanceWritten(0).opacity).toBe(0.5)
  })
})

describe('identity cannot be forged by data or by the host', () => {
  it('tells apart two templates whose fields collide on a separator', async () => {
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
    const opacity = (await byKey('opacity')) as HTMLInputElement

    opacity.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }))
    opacity.value = '0.72'
    opacity.dispatchEvent(new Event('input', { bubbles: true }))
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
    const opacity = (await byKey('opacity')) as HTMLInputElement

    opacity.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' }))
    opacity.value = '0.6'
    opacity.dispatchEvent(new Event('input', { bubbles: true }))
    // The browser blurs the range on pointerdown, before the click lands.
    const close = await byKey('close')
    opacity.dispatchEvent(new Event('blur'))
    close.click()
    rerender()
    await settle()

    // Committing synchronously on blur rebuilds the menu and removes the button mid-click.
    expect(document.getElementById('caelestis-overlay-menu')).toBeNull()
    expect(appearanceWritten(0).opacity).toBe(0.6)
  })

  it('closes on Escape after a click on the map', async () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    // The menu deliberately survives this, per the acceptance criteria.
    mapCanvas.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }))
    rerender()

    expect(document.getElementById('caelestis-overlay-menu')).toBeNull()
  })
})

describe('an action waits for the state it depends on', () => {
  it('answers the delete question first on Escape from outside the menu', async () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()
    ;(await byKey('delete')).click()
    rerender()

    window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }))
    rerender()

    expect(document.getElementById('caelestis-overlay-menu')).not.toBeNull()
    expect((await menuRoot()).querySelector('[data-caelestis-confirm]')).toBeNull()
  })

  it('still exits when another page listener prevented the Escape', async () => {
    harness.localTemplates.mockReturnValue([template()])
    rerender()
    gear('a').click()
    rerender()

    const event = new KeyboardEvent('keydown', { bubbles: true, key: 'Escape', cancelable: true })
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
    const size = (await byKey('size')) as HTMLInputElement
    const opacity = (await byKey('opacity')) as HTMLInputElement
    // Capture unavailable, so both fall back to window-level releases.
    for (const input of [size, opacity]) {
      Object.defineProperty(input, 'setPointerCapture', {
        value: () => {
          throw new Error('unsupported')
        },
      })
    }
    size.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }))
    opacity.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 2 }))
    opacity.value = '0.33'
    opacity.dispatchEvent(new Event('input', { bubbles: true }))
    size.remove()
    rerender()

    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 2 }))
    await settle()

    // Dropping every fallback when one slider detaches takes the still-live slider's with it.
    expect(appearanceWritten(0).opacity).toBe(0.33)
  })
})
