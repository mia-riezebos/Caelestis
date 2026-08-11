import { type Appearance, UNPAINTED_LIMIT_CONTROL } from '../templates/appearance.js'
import { colourSwatch } from './colour-picker.js'

/**
 * Everything under "Mismatches", as one block, in both places that show it.
 *
 * The settings pane and each overlay's own menu ask exactly the same questions and used to answer
 * them in two hand-written lists — different labels for the same switch, different label widths, and
 * the nesting only in one of them. One component, two densities.
 *
 * **The hierarchy is the layout.** These are not five peers: one switch turns marking on, and
 * everything else qualifies it. So each row sits at the indent of what it depends on and goes inert
 * with its parent, which is the whole explanation of what qualifies what — no sentence under each
 * row saying so. The explainers those sentences replaced mostly restated their own label.
 *
 * One grid throughout: label in a flexible column, control in a fixed one. Every track, switch and
 * swatch therefore shares a right edge, and a long label takes a second line instead of squeezing
 * the control it belongs to — which is what turned "Only once this much is left" into three lines of
 * text beside a stub of a slider.
 */

/** The control column. Wide enough for a usable track and its readout, and no wider. */
const CONTROL_WIDTH = '8.5rem'

/** One step of nesting. Deep enough to read as subordinate at a glance, shallow enough to stack. */
const INDENT = '1.25rem'

interface RowOptions {
  readonly depth: number
  readonly compact: boolean
  /** Said under the label, only where the label genuinely cannot say it. */
  readonly hint?: string
}

const row = (label: string, control: HTMLElement, options: RowOptions): HTMLElement => {
  const wrap = document.createElement('label')
  wrap.className = 'items-center'
  Object.assign(wrap.style, {
    display: 'grid',
    gridTemplateColumns: `minmax(0, 1fr) ${CONTROL_WIDTH}`,
    gap: '0.75rem',
    padding: options.compact ? '0.25rem 0' : '0.375rem 0',
    paddingInlineStart: `calc(${INDENT} * ${options.depth})`,
    // Labels are sentences, not codes: a two-line one should break where a reader would break it.
    textWrap: 'pretty',
    // These sit inside the per-overlay menu, whose headings are uppercase and letter-spaced.
    textTransform: 'none',
    letterSpacing: 'normal',
    fontWeight: 'normal',
  })

  const text = document.createElement('div')
  text.className = 'flex flex-col'
  const name = document.createElement('span')
  // Depth carries weight as well as position, so the top of a group reads first when you skim it.
  name.className = options.depth === 0 && !options.compact ? 'text-sm' : 'text-xs opacity-80'
  name.textContent = label
  text.appendChild(name)
  if (options.hint !== undefined) {
    const hint = document.createElement('span')
    hint.className = 'text-xs opacity-50'
    hint.textContent = options.hint
    text.appendChild(hint)
  }

  const cell = document.createElement('div')
  cell.className = 'flex items-center justify-end gap-2'
  cell.style.minWidth = '0'
  cell.appendChild(control)

  wrap.append(text, cell)
  return wrap
}

/** A range and its readout, sized to the control column rather than to the label beside it. */
const track = (
  spec: { min: number; max: number; step: number; format: (value: number) => string },
  value: number,
  onChange: (next: number) => void,
): HTMLElement => {
  const wrap = document.createElement('span')
  wrap.className = 'flex items-center gap-2'
  wrap.style.flex = '1'
  wrap.style.minWidth = '0'
  const input = document.createElement('input')
  input.type = 'range'
  input.className = 'range range-xs'
  input.min = String(spec.min)
  input.max = String(spec.max)
  input.step = String(spec.step)
  input.value = String(value)
  input.style.flex = '1'
  input.style.minWidth = '0'
  const readout = document.createElement('span')
  readout.className = 'text-xs opacity-60'
  readout.style.width = '2.5rem'
  readout.style.flex = '0 0 auto'
  readout.style.textAlign = 'right'
  // The value changes as you drag, so it must not reflow the row it sits in.
  readout.style.fontVariantNumeric = 'tabular-nums'
  readout.textContent = spec.format(value)
  input.addEventListener('input', () => {
    const next = Number(input.value)
    readout.textContent = spec.format(next)
    onChange(next)
  })
  wrap.append(input, readout)
  return wrap
}

const swatch = (label: string, value: string, onChange: (next: string) => void): HTMLElement =>
  colourSwatch(value, onChange, { label })

const tick = (value: boolean, onChange: (next: boolean) => void): HTMLInputElement => {
  const input = document.createElement('input')
  input.type = 'checkbox'
  // A switch, not a tick: each of these turns a behaviour on rather than picking one of a set.
  input.className = 'toggle toggle-sm'
  input.checked = value
  input.addEventListener('change', () => onChange(input.checked))
  return input
}

/**
 * Make a subtree inert, and look it.
 *
 * Dimmed *and* disabled. Opacity alone leaves every control in the tab order, reachable and operable
 * by keyboard — and a control that works while claiming to be inert is worse than one that plainly
 * is.
 */
const setEnabled = (element: HTMLElement, enabled: boolean): void => {
  element.style.opacity = enabled ? '1' : '0.45'
  for (const control of element.querySelectorAll('input, button, select')) {
    if (enabled) control.removeAttribute('disabled')
    else control.setAttribute('disabled', '')
  }
}

export const mismatchSettings = (
  values: Appearance,
  write: (patch: Partial<Appearance>) => void,
  rerender: () => void,
  { compact = false }: { compact?: boolean } = {},
): HTMLElement => {
  const wrap = document.createElement('div')
  wrap.className = 'flex flex-col'

  const at = (depth: number, hint?: string): RowOptions =>
    hint === undefined ? { depth, compact } : { depth, compact, hint }

  wrap.appendChild(
    row(
      'Mark mismatched pixels',
      tick(values.markMismatch, (next) => {
        write({ markMismatch: next })
        rerender()
      }),
      at(0),
    ),
  )

  // Everything below answers to that switch, so it goes with it.
  const under = document.createElement('div')
  under.className = 'flex flex-col'
  wrap.appendChild(under)

  under.append(
    row(
      'Size',
      track(
        { min: 3, max: 33, step: 1, format: (v) => `${Math.round(v)}px` },
        values.markerSize,
        (next) => write({ markerSize: next }),
      ),
      at(1),
    ),
    row(
      'Colour',
      swatch('Marker colour', values.markerColour, (next) => write({ markerColour: next })),
      at(1),
    ),
    row(
      'Include unpainted pixels',
      tick(values.markUnpainted, (next) => {
        write({ markUnpainted: next })
        rerender()
      }),
      at(1),
    ),
  )

  /**
   * How little may be left before the switch above applies.
   *
   * Its own row under that switch rather than beside it: it is the one number that makes "include
   * unpainted" usable at all — over a template nobody has started, every pixel is unpainted, and
   * marking all of them is a wall of crosshairs that says nothing you could not already see.
   */
  const limit = row(
    'Only under',
    track(UNPAINTED_LIMIT_CONTROL, values.unpaintedLimit, (next) =>
      write({ unpaintedLimit: next }),
    ),
    at(2),
  )
  under.appendChild(limit)

  under.appendChild(
    row(
      'Dim other colours',
      tick(values.dimOthers, (next) => {
        write({ dimOthers: next })
        rerender()
      }),
      // The one row whose label cannot say what it means: the setting is inert unless the view is
      // following the selection, and nothing else on screen would tell you that.
      at(1, 'While following the selected colour'),
    ),
  )

  const dim = document.createElement('div')
  dim.className = 'flex flex-col'
  dim.append(
    row(
      'Faded to',
      track(
        { min: 0.05, max: 1, step: 0.05, format: (v) => `${Math.round(v * 100)}%` },
        values.otherOpacity,
        (next) => write({ otherOpacity: next }),
      ),
      at(2),
    ),
    markedInRow(values, write, rerender, compact),
  )
  under.appendChild(dim)

  /**
   * Inertness, outermost first, and only ever applied at one level.
   *
   * The dimming is not re-applied inside an already-dimmed subtree — two 0.45s multiply to 0.2 and
   * the deepest rows come out nearly invisible, which reads as broken rather than as unavailable.
   * With marking off the whole block dims once, evenly; with it on, each child answers for itself.
   */
  setEnabled(under, values.markMismatch)
  if (values.markMismatch) {
    setEnabled(limit, values.markUnpainted)
    setEnabled(dim, values.dimOthers)
  }
  return wrap
}

/**
 * The colour those dimmed markers take, with a way back to "the same one".
 *
 * Null is a real answer — one colour throughout — and a colour input has no empty state to return
 * to once it has been given a value, so the way back has to be a control of its own.
 */
const markedInRow = (
  values: Appearance,
  write: (patch: Partial<Appearance>) => void,
  rerender: () => void,
  compact: boolean,
): HTMLElement => {
  const cell = document.createElement('span')
  cell.className = 'flex items-center gap-2'
  cell.appendChild(
    swatch('Colour for other colours', values.otherColour ?? values.markerColour, (next) =>
      write({ otherColour: next }),
    ),
  )
  const same = document.createElement('button')
  same.type = 'button'
  same.className = values.otherColour === null ? 'btn btn-xs btn-primary' : 'btn btn-xs'
  same.textContent = 'Same'
  same.title = 'Use the marker colour for these too'
  same.addEventListener('click', (event) => {
    // Inside a `<label>`, so a click here would otherwise also reach the colour input beside it.
    event.preventDefault()
    write({ otherColour: null })
    rerender()
  })
  cell.appendChild(same)
  return row('Marked in', cell, { depth: 2, compact })
}
