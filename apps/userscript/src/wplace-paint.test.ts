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
