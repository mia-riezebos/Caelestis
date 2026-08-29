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
    const heading = document.createElement('h2')
    const undo = document.createElement('button')
    undo.title = 'Undo'
    const redo = document.createElement('button')
    redo.title = 'Redo'
    header.append(heading, undo, redo)
    const paletteSection = document.createElement('div')
    const paletteGrid = document.createElement('div')
    const swatchWrapper = document.createElement('div')
    const swatch = document.createElement('button')
    swatch.id = 'color-1'
    swatchWrapper.appendChild(swatch)
    paletteGrid.appendChild(swatchWrapper)
    paletteSection.appendChild(paletteGrid)
    drawer.append(header, paletteSection)
    return { drawer, redo, undo }
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
    const { togglePaintMode } = await import('./wplace-paint.js')

    expect(togglePaintMode()).toBe(true)
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
    const { togglePaintMode } = await import('./wplace-paint.js')

    expect(togglePaintMode()).toBe(true)
    expect(paintClick).toHaveBeenCalledOnce()
    expect(unrelatedClick).not.toHaveBeenCalled()
  })

  it('uses the native unlabeled drawer close control while the paint drawer is mounted', async () => {
    const drawer = document.createElement('div')
    const header = document.createElement('div')
    const crosshair = document.createElement('button')
    const headingGroup = document.createElement('div')
    headingGroup.appendChild(document.createElement('h2'))
    const close = document.createElement('button')
    const closeClick = vi.fn()
    close.addEventListener('click', closeClick)
    header.append(crosshair, headingGroup, close)
    const paletteSection = document.createElement('div')
    const paletteGrid = document.createElement('div')
    const swatchWrapper = document.createElement('div')
    const swatch = document.createElement('button')
    swatch.id = 'color-1'
    swatchWrapper.appendChild(swatch)
    paletteGrid.appendChild(swatchWrapper)
    paletteSection.appendChild(paletteGrid)
    drawer.append(header, paletteSection)
    const paint = document.createElement('button')
    paint.title = 'Paint'
    const paintClick = vi.fn()
    paint.addEventListener('click', paintClick)
    document.body.append(drawer, paint)
    const { togglePaintMode } = await import('./wplace-paint.js')

    expect(togglePaintMode()).toBe(true)
    expect(closeClick).toHaveBeenCalledOnce()
    expect(paintClick).not.toHaveBeenCalled()
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
})
