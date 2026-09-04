// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./debug.js', () => ({ log: vi.fn() }))

beforeEach(() => {
  document.body.replaceChildren()
  vi.resetModules()
})

describe('Wplace paint controls', () => {
  const paintDrawer = () => {
    const drawer = document.createElement('div')
    const header = document.createElement('div')
    const cancel = document.createElement('button')
    const heading = document.createElement('h2')
    const undo = document.createElement('button')
    undo.title = 'Undo'
    const redo = document.createElement('button')
    redo.title = 'Redo'
    header.append(heading, undo, redo, cancel)
    const paletteSection = document.createElement('div')
    const paletteGrid = document.createElement('div')
    const swatchWrapper = document.createElement('div')
    const swatch = document.createElement('button')
    swatch.id = 'color-1'
    swatchWrapper.appendChild(swatch)
    paletteGrid.appendChild(swatchWrapper)
    paletteSection.appendChild(paletteGrid)
    const footer = document.createElement('div')
    const commitWrapper = document.createElement('div')
    commitWrapper.className = 'absolute bottom-0 left-1/2 -translate-x-1/2'
    const commit = document.createElement('button')
    commit.className = 'btn btn-primary'
    commit.textContent = 'Paint (0:04)'
    commitWrapper.appendChild(commit)
    footer.appendChild(commitWrapper)
    drawer.append(header, paletteSection, footer)
    return { cancel, commit, drawer, redo, undo }
  }

  it('selects only an exact native palette swatch', async () => {
    const swatch = document.createElement('button')
    swatch.id = 'color-3'
    const clicked = vi.fn()
    swatch.addEventListener('click', clicked)
    document.body.appendChild(swatch)
    const { selectPaintColour } = await import('./wplace-paint.js')

    expect(selectPaintColour(2)).toBe(true)
    expect(clicked).toHaveBeenCalledOnce()
    expect(selectPaintColour(-1)).toBe(false)
    expect(selectPaintColour(63)).toBe(false)
  })

  it('reads and selects Wplace alliance palette buttons after progress decorates their labels', async () => {
    const world = document.createElement('button')
    world.id = 'color-2'
    world.className = 'ring-primary'
    const worldClick = vi.fn()
    world.addEventListener('click', worldClick)
    const dialog = document.createElement('dialog')
    dialog.setAttribute('open', '')
    const stage = document.createElement('div')
    stage.setAttribute('role', 'application')
    stage.setAttribute('aria-label', 'Alliance asset canvas')
    const grid = document.createElement('div')
    const blackWrapper = document.createElement('div')
    const black = document.createElement('button')
    black.setAttribute('aria-label', 'Black. Checking progress for the focused template.')
    black.setAttribute('aria-pressed', 'true')
    const redWrapper = document.createElement('div')
    const red = document.createElement('button')
    red.setAttribute('aria-label', 'Red')
    red.setAttribute('aria-pressed', 'false')
    const redClick = vi.fn()
    red.addEventListener('click', redClick)
    blackWrapper.appendChild(black)
    redWrapper.appendChild(red)
    grid.append(blackWrapper, redWrapper)
    stage.appendChild(grid)
    dialog.appendChild(stage)
    document.body.append(world, dialog)
    const {
      isPaintOpen,
      paintPaletteIndexOf,
      selectPaintColour,
      selectedColour,
      watchPaintSelection,
    } = await import('./wplace-paint.js')

    watchPaintSelection()

    expect(isPaintOpen()).toBe(true)
    expect(paintPaletteIndexOf(black)).toBe(0)
    expect(selectedColour()).toBe(0)
    expect(selectPaintColour(6)).toBe(true)
    expect(redClick).toHaveBeenCalledOnce()
    expect(worldClick).not.toHaveBeenCalled()
  })

  it('clicks only an exact accessible paint-mode label', async () => {
    const unrelated = document.createElement('button')
    unrelated.setAttribute('aria-label', 'Paint template settings')
    const unrelatedClick = vi.fn()
    unrelated.addEventListener('click', unrelatedClick)
    const paint = document.createElement('button')
    paint.title = 'Paint'
    const paintClick = vi.fn()
    paint.addEventListener('click', paintClick)
    document.body.append(unrelated, paint)
    const { performPaintAction } = await import('./wplace-paint.js')

    expect(performPaintAction()).toBe(true)
    expect(paintClick).toHaveBeenCalledOnce()
    expect(unrelatedClick).not.toHaveBeenCalled()
  })

  it('clicks the current bottom-centre Wplace Paint control with dynamic timer text', async () => {
    const unrelated = document.createElement('button')
    unrelated.className = 'btn btn-primary'
    unrelated.textContent = 'Paint template settings'
    const unrelatedClick = vi.fn()
    unrelated.addEventListener('click', unrelatedClick)

    const dock = document.createElement('div')
    dock.className = 'absolute bottom-3 left-1/2 z-30 -translate-x-1/2'
    const paint = document.createElement('button')
    paint.className = 'btn btn-lg sm:btn-xl relative btn-primary z-30'
    paint.textContent = 'Paint (0:08)'
    const paintClick = vi.fn()
    paint.addEventListener('click', paintClick)
    dock.appendChild(paint)
    document.body.append(unrelated, dock)
    const { performPaintAction } = await import('./wplace-paint.js')

    expect(performPaintAction()).toBe(true)
    expect(paintClick).toHaveBeenCalledOnce()
    expect(unrelatedClick).not.toHaveBeenCalled()
  })

  it('clicks the alliance artboard Paint control', async () => {
    const dialog = document.createElement('dialog')
    const dock = document.createElement('div')
    dock.className = 'absolute bottom-14 left-1/2 z-20 -translate-x-1/2 sm:bottom-3'
    const paint = document.createElement('button')
    paint.className = 'btn btn-lg sm:btn-xl relative btn-primary'
    paint.textContent = 'Paint'
    const paintClick = vi.fn()
    paint.addEventListener('click', paintClick)
    dock.appendChild(paint)
    dialog.appendChild(dock)
    document.body.appendChild(dialog)
    const { performPaintAction } = await import('./wplace-paint.js')

    expect(performPaintAction(dialog)).toBe(true)
    expect(paintClick).toHaveBeenCalledOnce()
  })

  it('clicks the visible alliance Paint control after Wplace removes its dock classes', async () => {
    const dialog = document.createElement('dialog')
    const wrapper = document.createElement('div')
    const paint = document.createElement('button')
    paint.className = 'btn btn-lg sm:btn-xl relative btn-primary'
    paint.textContent = 'Paint'
    paint.getBoundingClientRect = () => ({ width: 200, height: 56 }) as DOMRect
    const paintClick = vi.fn()
    paint.addEventListener('click', paintClick)
    wrapper.appendChild(paint)
    dialog.appendChild(wrapper)
    document.body.appendChild(dialog)
    const { performPaintAction } = await import('./wplace-paint.js')

    expect(performPaintAction(dialog)).toBe(true)
    expect(paintClick).toHaveBeenCalledOnce()
  })

  it('uses the alliance palette section for commit, cancel, and history', async () => {
    const section = document.createElement('div')
    const tools = document.createElement('div')
    const undo = document.createElement('button')
    undo.setAttribute('aria-label', 'Undo')
    const redo = document.createElement('button')
    redo.setAttribute('aria-label', 'Redo')
    const close = document.createElement('button')
    close.setAttribute('aria-label', 'Close')
    tools.append(undo, redo, close)
    const grid = document.createElement('div')
    const wrapper = document.createElement('div')
    const swatch = document.createElement('button')
    swatch.setAttribute('aria-label', 'Black')
    swatch.setAttribute('aria-pressed', 'true')
    wrapper.appendChild(swatch)
    grid.appendChild(wrapper)
    const commitWrapper = document.createElement('div')
    const commit = document.createElement('button')
    commit.className = 'btn btn-lg btn-primary'
    commit.textContent = 'Paint'
    commit.getBoundingClientRect = () => ({ width: 200, height: 56 }) as DOMRect
    commitWrapper.appendChild(commit)
    section.append(tools, grid, commitWrapper)
    document.body.appendChild(section)
    const undoClick = vi.fn()
    const redoClick = vi.fn()
    const closeClick = vi.fn()
    const commitClick = vi.fn()
    undo.addEventListener('click', undoClick)
    redo.addEventListener('click', redoClick)
    close.addEventListener('click', closeClick)
    commit.addEventListener('click', commitClick)
    const { cancelPaintDraft, performPaintAction, redoPaintDraft, undoPaintDraft } = await import(
      './wplace-paint.js'
    )

    expect(undoPaintDraft(section)).toBe(true)
    expect(redoPaintDraft(section)).toBe(true)
    expect(cancelPaintDraft(section)).toBe(true)
    expect(performPaintAction(section)).toBe(true)
    expect(undoClick).toHaveBeenCalledOnce()
    expect(redoClick).toHaveBeenCalledOnce()
    expect(closeClick).toHaveBeenCalledOnce()
    expect(commitClick).toHaveBeenCalledOnce()
  })

  it('commits through the native bottom-centre Paint control while the drawer is mounted', async () => {
    const { commit, drawer } = paintDrawer()
    const commitClick = vi.fn()
    commit.addEventListener('click', commitClick)
    const paint = document.createElement('button')
    paint.title = 'Paint'
    const paintClick = vi.fn()
    paint.addEventListener('click', paintClick)
    document.body.append(drawer, paint)
    const { performPaintAction } = await import('./wplace-paint.js')

    expect(performPaintAction()).toBe(true)
    expect(commitClick).toHaveBeenCalledOnce()
    expect(paintClick).not.toHaveBeenCalled()
  })

  it('cancels through the native unlabeled drawer close control', async () => {
    const { cancel, drawer } = paintDrawer()
    const cancelClick = vi.fn()
    cancel.addEventListener('click', cancelClick)
    document.body.appendChild(drawer)
    const { cancelPaintDraft } = await import('./wplace-paint.js')

    expect(cancelPaintDraft()).toBe(true)
    expect(cancelClick).toHaveBeenCalledOnce()
  })

  it('publishes drawer closure after native cancellation removes the palette', async () => {
    const { cancel, drawer } = paintDrawer()
    document.body.appendChild(drawer)
    cancel.addEventListener('click', () => drawer.remove())
    const { cancelPaintDraft, isPaintOpen, onPaintSelectionChange, watchPaintSelection } =
      await import('./wplace-paint.js')
    watchPaintSelection()
    expect(isPaintOpen()).toBe(true)
    const closed = vi.fn(isPaintOpen)
    onPaintSelectionChange(closed)

    expect(cancelPaintDraft()).toBe(true)

    await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce())
    expect(closed).toHaveReturnedWith(false)
  })

  it('toggles Wplace theme through its native light or dark mode control', async () => {
    const theme = document.createElement('button')
    theme.setAttribute('aria-label', 'Dark mode')
    const clicked = vi.fn()
    theme.addEventListener('click', clicked)
    document.body.appendChild(theme)
    const { toggleWplaceTheme } = await import('./wplace-paint.js')

    expect(toggleWplaceTheme()).toBe(true)
    expect(clicked).toHaveBeenCalledOnce()
  })

  it('moves through Wplace authoritative draft history only while its controls are enabled', async () => {
    const { drawer, redo, undo } = paintDrawer()
    const unrelated = document.createElement('button')
    unrelated.title = 'Undo'
    const undoClick = vi.fn()
    const redoClick = vi.fn()
    const unrelatedClick = vi.fn()
    undo.addEventListener('click', undoClick)
    redo.addEventListener('click', redoClick)
    unrelated.addEventListener('click', unrelatedClick)
    redo.disabled = true
    document.body.append(unrelated, drawer)
    const { redoPaintDraft, undoPaintDraft } = await import('./wplace-paint.js')

    expect(undoPaintDraft()).toBe(true)
    expect(undoClick).toHaveBeenCalledOnce()
    expect(redoPaintDraft()).toBe(false)
    expect(redoClick).not.toHaveBeenCalled()
    expect(unrelatedClick).not.toHaveBeenCalled()

    redo.disabled = false
    expect(redoPaintDraft()).toBe(true)
    expect(redoClick).toHaveBeenCalledOnce()
  })

  it('scopes paint actions and history to the active alliance dialog', async () => {
    const world = paintDrawer()
    const alliance = paintDrawer()
    const dialog = document.createElement('dialog')
    dialog.setAttribute('open', '')
    dialog.append(alliance.drawer)
    document.body.append(world.drawer, dialog)
    const worldUndo = vi.fn()
    const allianceUndo = vi.fn()
    const worldCommit = vi.fn()
    const allianceCommit = vi.fn()
    world.undo.addEventListener('click', worldUndo)
    alliance.undo.addEventListener('click', allianceUndo)
    world.commit.addEventListener('click', worldCommit)
    alliance.commit.addEventListener('click', allianceCommit)
    const { performPaintAction, undoPaintDraft } = await import('./wplace-paint.js')

    expect(undoPaintDraft(dialog)).toBe(true)
    expect(performPaintAction(dialog)).toBe(true)
    expect(allianceUndo).toHaveBeenCalledOnce()
    expect(allianceCommit).toHaveBeenCalledOnce()
    expect(worldUndo).not.toHaveBeenCalled()
    expect(worldCommit).not.toHaveBeenCalled()
  })
})
