// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./debug.js', () => ({ log: vi.fn() }))

beforeEach(() => {
  document.body.replaceChildren()
  vi.resetModules()
})

describe('Wplace paint controls', () => {
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
})
