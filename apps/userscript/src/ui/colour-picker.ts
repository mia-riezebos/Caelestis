/**
 * Picking a colour that is deliberately not one of wplace's.
 *
 * A marker must never be mistakable for a pixel, so the palette grid — the obvious place to reach
 * for — is exactly the wrong source here. What is wanted is the opposite: whatever is *least* like
 * the artwork underneath, which is a free choice over the whole space rather than a list.
 *
 * So this is a real picker rather than a native `<input type="color">`. The native one was two
 * things at once: a control that did not match anything else in the panel, and an operating-system
 * dialog that covers the map you are choosing the colour *against*. Choosing a marker colour is a
 * live comparison against what is on screen, and every part of that argues for staying on the page.
 *
 * The swatch is the palette grid's swatch, at the same size with the same border and ring, because a
 * colour you have chosen and a colour you have switched on should not read as two different kinds of
 * thing.
 */

import { EDGE, GAP, SURFACE_RADIUS } from './metrics.js'

/** HSV, which is what a saturation/brightness square and a hue strip are the two axes of. */
interface Hsv {
  /** Degrees, 0..360. */
  readonly h: number
  /** 0..1. */
  readonly s: number
  /** 0..1. */
  readonly v: number
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

export const hexToHsv = (hex: string): Hsv => {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (match?.[1] === undefined) return { h: 0, s: 0, v: 0 }
  const int = Number.parseInt(match[1], 16)
  const r = ((int >> 16) & 255) / 255
  const g = ((int >> 8) & 255) / 255
  const b = (int & 255) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const span = max - min
  let h = 0
  if (span > 0) {
    if (max === r) h = 60 * (((g - b) / span + 6) % 6)
    else if (max === g) h = 60 * ((b - r) / span + 2)
    else h = 60 * ((r - g) / span + 4)
  }
  return { h, s: max === 0 ? 0 : span / max, v: max }
}

export const hsvToHex = ({ h, s, v }: Hsv): string => {
  const f = (n: number): number => {
    const k = (n + h / 60) % 6
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1))
  }
  const byte = (value: number): string =>
    Math.round(clamp(value, 0, 1) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${byte(f(5))}${byte(f(3))}${byte(f(1))}`
}

/** The hue on its own, full strength — the colour the saturation square is built out of. */
const hueHex = (h: number): string => hsvToHex({ h, s: 1, v: 1 })

const POPOVER_ID = 'wts-colour-picker'

/** Shut whichever picker is open. Exported so anything closing its own surface can take this with it. */
export const closeColourPicker = (): void => {
  document.getElementById(POPOVER_ID)?.remove()
}

/**
 * Whether one is open, for anything that rebuilds the surface a picker is anchored to.
 *
 * Dragging in the square writes a colour on every pointer move, and every write is a state change —
 * so a panel that redraws on state changes would replace the swatch this is anchored to sixty times
 * a second, leaving the picker pointing at a detached element.
 */
export const isColourPickerOpen = (): boolean => document.getElementById(POPOVER_ID) !== null

interface SwatchOptions {
  /** Announced to a screen reader, since the swatch itself has nothing to read out. */
  readonly label: string
}

/**
 * A swatch that opens a picker.
 *
 * Returns the button; the popover lives on `document.body` for as long as it is open. It has to:
 * the per-overlay menu scrolls its own overflow, so a popover inside it would be clipped by the
 * surface it belongs to — and it would be clipped worst at the bottom of a long menu, which is
 * exactly where these rows are.
 */
export const colourSwatch = (
  value: string,
  onChange: (next: string) => void,
  { label }: SwatchOptions,
): HTMLButtonElement => {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'wts-swatch'
  button.style.width = '1.75rem'
  button.style.flex = '0 0 auto'
  button.style.backgroundColor = value
  button.setAttribute('aria-haspopup', 'dialog')
  button.setAttribute('aria-label', `${label}: ${value}`)
  button.title = value

  const show = (next: string): void => {
    button.style.backgroundColor = next
    button.setAttribute('aria-label', `${label}: ${next}`)
    button.title = next
    onChange(next)
  }

  button.addEventListener('click', (event) => {
    // These sit inside a `<label>`, which would otherwise re-dispatch the click to us.
    event.preventDefault()
    event.stopPropagation()
    if (document.getElementById(POPOVER_ID) !== null) {
      closeColourPicker()
      return
    }
    openPicker(button, button.style.backgroundColor === '' ? value : rgbToHex(button), show, label)
  })
  return button
}

/**
 * The swatch's own colour, read back as hex.
 *
 * The button is the source of truth between renders — it is what the last pick wrote to — and the
 * browser normalises whatever it is given to `rgb(r, g, b)`. Parsing it back is cheaper and more
 * honest than keeping a second copy in a closure that a rebuild would strand.
 */
const rgbToHex = (element: HTMLElement): string => {
  const parts = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(element.style.backgroundColor)
  if (parts === null) return '#000000'
  const byte = (at: number): string => Number(parts[at]).toString(16).padStart(2, '0')
  return `#${byte(1)}${byte(2)}${byte(3)}`
}

const openPicker = (
  anchor: HTMLElement,
  initial: string,
  onChange: (next: string) => void,
  label: string,
): void => {
  let hsv = hexToHsv(initial)

  const pop = document.createElement('div')
  pop.id = POPOVER_ID
  pop.className = 'bg-base-100 shadow-2xl wts-cp'
  pop.setAttribute('role', 'dialog')
  pop.setAttribute('aria-label', label)
  Object.assign(pop.style, {
    position: 'fixed',
    // Above the panel (30) and the per-overlay menu (29), both of which can be under it.
    zIndex: '50',
    borderRadius: SURFACE_RADIUS,
    padding: '0.625rem',
    color: 'var(--color-base-content, inherit)',
  })
  // Nothing in here may reach the map, which is directly behind it.
  pop.addEventListener('pointerdown', (event) => event.stopPropagation())

  /**
   * Saturation left to right, brightness bottom to top, over the current hue.
   *
   * Two gradients rather than a canvas: white-to-hue across, and transparent-to-black down. That is
   * the definition of the square, so it needs no repainting when the hue moves — only the underlying
   * colour changes.
   */
  const square = document.createElement('div')
  square.className = 'wts-cp-sv'
  square.tabIndex = 0
  square.setAttribute('role', 'application')
  const handle = document.createElement('span')
  handle.className = 'wts-cp-handle'
  square.appendChild(handle)

  const hue = document.createElement('input')
  hue.type = 'range'
  hue.className = 'wts-cp-hue'
  hue.min = '0'
  hue.max = '360'
  hue.step = '1'
  hue.setAttribute('aria-label', 'Hue')

  const hex = document.createElement('input')
  hex.type = 'text'
  hex.className = 'input input-xs'
  hex.style.flex = '1'
  hex.style.minWidth = '0'
  hex.style.fontFamily = 'ui-monospace, monospace'
  hex.spellcheck = false
  hex.setAttribute('aria-label', 'Hex value')

  const preview = document.createElement('span')
  preview.className = 'wts-swatch'
  preview.style.width = '1.75rem'
  preview.style.flex = '0 0 auto'

  const bottom = document.createElement('div')
  bottom.className = 'flex items-center gap-2'
  bottom.style.marginTop = '0.5rem'
  bottom.append(preview, hex)

  const paint = (writeHex: boolean): void => {
    const colour = hsvToHex(hsv)
    square.style.background = `linear-gradient(to top, #000, rgba(0,0,0,0)), linear-gradient(to right, #fff, ${hueHex(hsv.h)})`
    handle.style.left = `${hsv.s * 100}%`
    handle.style.top = `${(1 - hsv.v) * 100}%`
    // The handle has to stay findable on both a white corner and a black one.
    handle.style.backgroundColor = colour
    hue.value = String(Math.round(hsv.h))
    preview.style.backgroundColor = colour
    square.setAttribute(
      'aria-valuetext',
      `saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`,
    )
    if (writeHex) hex.value = colour
    onChange(colour)
  }

  const fromPoint = (event: PointerEvent): void => {
    const box = square.getBoundingClientRect()
    hsv = {
      ...hsv,
      s: clamp((event.clientX - box.left) / box.width, 0, 1),
      v: clamp(1 - (event.clientY - box.top) / box.height, 0, 1),
    }
    paint(true)
  }

  square.addEventListener('pointerdown', (event) => {
    square.setPointerCapture(event.pointerId)
    square.focus()
    fromPoint(event)
  })
  square.addEventListener('pointermove', (event) => {
    if (!square.hasPointerCapture(event.pointerId)) return
    fromPoint(event)
  })
  // Arrow keys, because a square you can only reach with a pointer is a square half the people here
  // cannot use. A step of 2% crosses it in fifty presses; Shift makes that ten.
  square.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 0.1 : 0.02
    const move: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    }
    const delta = move[event.key]
    if (delta === undefined) return
    event.preventDefault()
    hsv = { ...hsv, s: clamp(hsv.s + delta[0], 0, 1), v: clamp(hsv.v + delta[1], 0, 1) }
    paint(true)
  })

  hue.addEventListener('input', () => {
    hsv = { ...hsv, h: Number(hue.value) }
    paint(true)
  })

  hex.addEventListener('input', () => {
    const typed = /^#?[0-9a-f]{6}$/i.test(hex.value)
    // Invalid as you type is normal — three characters into six is not an error worth shouting
    // about — so it simply does nothing until the value is a colour.
    hex.style.opacity = typed || hex.value.trim() === '' ? '1' : '0.6'
    if (!typed) return
    hsv = hexToHsv(hex.value)
    paint(false)
  })

  pop.append(square, hue, bottom)
  document.body.appendChild(pop)
  paint(true)
  place(pop, anchor)

  /**
   * Close on Escape or on a pointer outside, and give the focus back.
   *
   * Focus return is the part that is easy to skip and the part that a keyboard user notices: without
   * it, dismissing the picker drops focus on `<body>` and the next Tab starts again from the top of
   * the page rather than from the row that was being edited.
   */
  const close = (restoreFocus: boolean): void => {
    pop.remove()
    window.removeEventListener('pointerdown', outside, true)
    window.removeEventListener('keydown', onKey, true)
    window.removeEventListener('resize', reposition)
    if (restoreFocus) anchor.focus()
  }
  const outside = (event: PointerEvent): void => {
    if (
      event.target instanceof Node &&
      (pop.contains(event.target) || anchor.contains(event.target))
    )
      return
    close(false)
  }
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    event.stopPropagation()
    close(true)
  }
  const reposition = (): void => place(pop, anchor)
  // On the capture phase: wplace's own map handlers sit on the window too, and a click meant to
  // dismiss this must not also be a click on the canvas behind it.
  window.addEventListener('pointerdown', outside, true)
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('resize', reposition)
  square.focus()
}

/**
 * Under the swatch, flipped above it when there is no room, and never off the screen.
 *
 * Aligned to the swatch's right edge rather than its left, because these controls sit in a column on
 * the right of a panel that is itself against the right of the window — so opening leftwards is the
 * direction with somewhere to go.
 */
const place = (pop: HTMLElement, anchor: HTMLElement): void => {
  const at = anchor.getBoundingClientRect()
  const size = pop.getBoundingClientRect()
  // Half the gap our surfaces keep from each other. This one belongs to the swatch that opened it,
  // and a full gap reads as two separate things rather than as one opening out of the other.
  const gap = GAP / 2
  const below = at.bottom + gap
  const top = below + size.height > window.innerHeight - EDGE ? at.top - size.height - gap : below
  const left = clamp(at.right - size.width, EDGE, window.innerWidth - size.width - EDGE)
  pop.style.top = `${clamp(top, EDGE, Math.max(EDGE, window.innerHeight - size.height - EDGE))}px`
  pop.style.left = `${left}px`
}
