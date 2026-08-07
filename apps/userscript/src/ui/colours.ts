import { PALETTE_SIZE, TRANSPARENT_INDEX, WPLACE_PALETTE } from '@wts/shared'
import { getState, setState } from '../state.js'
import { globalHiddenColours } from '../templates/colour-filter.js'
import { ownedColours, refreshAccount } from '../wplace-account.js'
import { isPaintOpen, selectedColour } from '../wplace-paint.js'
import { icon } from './icons.js'

/**
 * The colour filter: every palette entry individually, with presets above it.
 *
 * A preset is a shortcut that *sets* the switches, not a mode that replaces them — pick "Free" and
 * then turn one premium colour back on, and nothing fights you. That is why this is a grid rather
 * than the dropdown it started as: the dropdown could only express the four presets, and the useful
 * state is usually one of them minus a colour or two.
 *
 * Filtering is display-only. Progress figures ignore it, because hiding a colour is a choice about
 * what you look at, not about what the template contains.
 */

export type ColourPresetId = 'all' | 'free' | 'premium' | 'owned'

/** Exactly what a preset turns on. `owned` reads `extraColorsBitmap` from wplace's `/me`. */
const presetIndices = (preset: ColourPresetId, owned: ReadonlySet<number> | null): number[] => {
  const drawable = WPLACE_PALETTE.filter((colour) => colour.index !== TRANSPARENT_INDEX)
  switch (preset) {
    case 'all':
      return drawable.map((colour) => colour.index)
    case 'free':
      return drawable.filter((c) => c.kind === 'free').map((c) => c.index)
    case 'premium':
      return drawable.filter((c) => c.kind === 'premium').map((c) => c.index)
    case 'owned':
      return drawable
        .filter((c) => c.kind === 'free' || (owned?.has(c.index) ?? false))
        .map((c) => c.index)
  }
}

/** The hidden set a preset amounts to: everything it does not turn on. */
export const hiddenForPreset = (preset: ColourPresetId): number[] => {
  const on = new Set(presetIndices(preset, ownedColours()))
  const hidden: number[] = []
  for (let index = 0; index < PALETTE_SIZE; index++) {
    if (index !== TRANSPARENT_INDEX && !on.has(index)) hidden.push(index)
  }
  return hidden
}

/**
 * One palette swatch, with its state shown two ways.
 *
 * At rest the grid is the palette and nothing else: an on swatch is the plain colour with a ring, an
 * off one drops to 70% and loses the ring. Decorating the common case is what made this noisy —
 * sixty-three badges to say "normal".
 *
 * On hover the swatch says what it *is* rather than what a click would do. On shows a filled box
 * with the eye knocked out of it; off shows an empty box with a struck-through eye. Pointing at
 * something is the moment to be explicit, and 70% versus 100% is a judgement nobody should have to
 * make against a neighbour.
 */
export const paletteSwatch = (
  colour: (typeof WPLACE_PALETTE)[number],
  on: boolean,
  onToggle: () => void,
): HTMLButtonElement => {
  const swatch = document.createElement('button')
  swatch.type = 'button'
  swatch.className = 'wts-swatch'
  swatch.dataset.index = String(colour.index)
  swatch.dataset.on = String(on)
  swatch.style.backgroundColor = colour.hex
  swatch.title = `${colour.name} · ${colour.kind}`
  swatch.setAttribute('aria-label', `${colour.name}, ${colour.kind}`)
  swatch.setAttribute('aria-pressed', String(on))

  const badge = document.createElement('span')
  badge.className = 'wts-swatch-badge'
  const box = document.createElement('span')
  box.appendChild(icon(on ? 'eye' : 'eyeOff', ''))
  badge.appendChild(box)
  swatch.appendChild(badge)

  swatch.addEventListener('click', onToggle)
  return swatch
}

/**
 * Repoint an existing swatch at a new state, badge included.
 *
 * The overlay menu never rebuilds itself, so a swatch has to be able to change without being
 * replaced — and the eye has to flip with it, or hovering reports the state it had before.
 */
export const setSwatchState = (swatch: HTMLElement, on: boolean): void => {
  swatch.dataset.on = String(on)
  swatch.setAttribute('aria-pressed', String(on))
  const box = swatch.querySelector('.wts-swatch-badge > span')
  if (box === null) return
  box.replaceChildren(icon(on ? 'eye' : 'eyeOff', ''))
}

/** The settings pane indents its rows; the overlay menu does not. Only the wrapper differs. */
const withPadding = (element: HTMLElement): HTMLElement => {
  const wrap = document.createElement('div')
  wrap.className = 'px-3'
  wrap.appendChild(element)
  return wrap
}

/** The follow-the-selection toggle's slot in the preset row, so it lights up by the same rule. */
const ONLY_SELECTED = 'only-selected'

const PRESETS: ReadonlyArray<readonly [ColourPresetId, string]> = [
  ['all', 'All'],
  ['free', 'Free'],
  ['premium', 'Premium'],
  ['owned', 'Owned'],
]

/**
 * The preset buttons, plus the follow-the-selection toggle.
 *
 * Shared by the settings pane and each overlay's own menu. They differ only in where the answer is
 * written — one sets the global filter, the other one overlay's — so the buttons themselves have no
 * business knowing which is which.
 */
/** Whether two hidden-colour sets say the same thing, order and duplicates aside. */
const sameSet = (a: readonly number[], b: readonly number[]): boolean => {
  const left = new Set(a)
  const right = new Set(b)
  if (left.size !== right.size) return false
  for (const index of left) if (!right.has(index)) return false
  return true
}

/**
 * Which preset the current filter *is*, or null when it is some subset of its own.
 *
 * Derived rather than stored. A preset is a shortcut for a set of switches, not a mode the filter
 * stays in, so remembering which button was pressed would go stale the moment a single swatch was
 * clicked — and the button would then claim a state the palette no longer had.
 */
const activePreset = (hidden: readonly number[]): ColourPresetId | null => {
  for (const [id] of PRESETS) {
    if (id === 'owned' && ownedColours() === null) continue
    if (sameSet(hidden, hiddenForPreset(id))) return id
  }
  return null
}

/**
 * The preset buttons, plus the follow-the-selection toggle.
 *
 * Shared by the settings pane and each overlay's own menu. They differ only in where the answer is
 * written and read — one the global filter, the other one overlay's — so the buttons themselves have
 * no business knowing which is which.
 */
export const colourPresets = (
  apply: (hidden: number[]) => void,
  rerender: () => void,
  scope: {
    /** The filter as it stands, so the matching button can show itself as the one in effect. */
    readonly hidden: readonly number[]
    readonly onlySelected: boolean
    readonly setOnlySelected: (next: boolean) => void
  },
): HTMLElement => {
  const presets = document.createElement('div')
  // Wraps: the panel is user-resizable and a fifth control was already enough to push the last one
  // off the edge at the default width.
  presets.className = 'flex flex-wrap gap-1'
  // The row owns the space beneath it, so it stands off the swatches wherever it is used. The
  // settings pane had this from its own wrapper; the overlay menu has no wrapper, and the grid sat
  // flush against the buttons.
  presets.style.marginBottom = '0.5rem'
  // While the mode is driving, no preset is in effect — it is the thing in effect.
  const active = scope.onlySelected ? null : activePreset(scope.hidden)
  // The labels are the labels. Nothing here needs a sentence.
  for (const [id, label] of PRESETS) {
    const button = document.createElement('button')
    button.type = 'button'
    // btn-primary, the same blue the rail button wears while the panel is open. btn-active is only a
    // slightly darker grey in wplace's theme, which reads as a hover state rather than as a setting
    // that is switched on — and a row where one grey button is "on" is a row that has to be studied.
    button.className = id === active ? 'btn btn-xs btn-primary' : 'btn btn-xs'
    button.dataset.wtsPreset = id
    button.setAttribute('aria-pressed', String(id === active))
    button.textContent = label
    if (id === 'owned' && ownedColours() === null) {
      // Only disabled when we genuinely could not ask — signed out, or wplace refused.
      button.classList.add('btn-disabled')
      button.title = 'Sign in to wplace so it can tell us which colours you own'
    }
    button.addEventListener('click', () => {
      apply(hiddenForPreset(id))
      rerender()
    })
    presets.appendChild(button)
  }
  presets.appendChild(onlySelectedToggle(scope.onlySelected, scope.setOnlySelected, rerender))

  // A set of its own gets no label. "Custom" said what the row already says by having nothing lit,
  // and it said it on a line of its own that pushed the swatches down whenever it appeared.
  return presets
}

/**
 * Restate which preset is in effect, without rebuilding the row.
 *
 * The settings pane never needs this because it rebuilds itself wholesale. The per-overlay menu
 * deliberately does not — a rebuild mid-drag takes a slider out from under the pointer — so its
 * preset buttons stayed exactly as they were drawn: clicking "Free" filtered the overlay and lit
 * nothing, and the row went on claiming the filter from whenever the menu was opened.
 */
export const setPresetState = (
  root: ParentNode,
  hidden: readonly number[],
  onlySelected: boolean,
): void => {
  const active = onlySelected ? null : activePreset(hidden)
  for (const element of root.querySelectorAll<HTMLElement>('[data-wts-preset]')) {
    const on = element.dataset.wtsPreset === (onlySelected ? ONLY_SELECTED : active)
    element.classList.toggle('btn-primary', on)
    element.setAttribute('aria-pressed', String(on))
  }
}

/**
 * "Only the colour I am placing" — a mode, not a preset.
 *
 * The four presets set the switches and then stop mattering. This one keeps mattering: it follows
 * wplace's selection for as long as it is on, and does nothing at all until their paint drawer is
 * open, because before that there is no colour being placed. Turning it off gives back whatever was
 * switched off by hand, since it never wrote to that set.
 */
export const onlySelectedToggle = (
  on: boolean,
  setOn: (next: boolean) => void,
  rerender: () => void,
): HTMLButtonElement => {
  const button = document.createElement('button')
  button.type = 'button'
  // The same blue as the presets it sits beside: it is one more way of answering "which colours",
  // so it has to look switched on the same way they do.
  button.className = on ? 'btn btn-xs btn-primary' : 'btn btn-xs'
  button.dataset.wtsPreset = ONLY_SELECTED
  // A palette, because that is what wplace puts on the same idea — their own control for this reads
  // "Highlight selected color" behind a palette icon. Borrowing the symbol means someone who has
  // used theirs recognises ours without reading anything.
  button.appendChild(icon('palette', 'size-4'))
  const selected = selectedColour()
  button.title = !on
    ? 'Highlight the selected colour'
    : isPaintOpen() && selected !== null
      ? `Highlighting ${WPLACE_PALETTE[selected]?.name ?? 'the selected colour'}`
      : 'Highlighting the selected colour — open wplace’s paint drawer to pick one'
  button.setAttribute('aria-label', 'Highlight the selected colour')
  button.setAttribute('aria-pressed', String(on))
  button.addEventListener('click', () => {
    setOn(!on)
    rerender()
  })
  return button
}

export const coloursSection = (rerender: () => void): HTMLElement => {
  const wrap = document.createElement('div')
  // Colours get bought mid-session. Showing this pane is exactly the moment a stale "Owned" is
  // visible, so ask again — rate-limited, and it only redraws if the answer moved.
  refreshAccount()
  // What is actually hidden right now, so the grid agrees with the canvas while a mode is driving
  // it rather than showing the switches the mode is overriding.
  const hidden = new Set(globalHiddenColours())
  const driven = getState().onlySelectedColour && isPaintOpen()

  wrap.appendChild(
    withPadding(
      colourPresets(
        (next) => {
          // Picking a preset is an explicit statement about which colours to show, so it takes the
          // wheel back from the follow-the-selection mode rather than being silently overridden by it.
          setState({ hiddenColours: next, onlySelectedColour: false })
        },
        rerender,
        {
          hidden: getState().hiddenColours,
          onlySelected: getState().onlySelectedColour,
          setOnlySelected: (next) => setState({ onlySelectedColour: next }),
        },
      ),
    ),
  )

  const gridWrap = document.createElement('div')
  gridWrap.className = 'wts-swatches px-3 pb-2'
  const grid = document.createElement('div')
  grid.className = 'wts-swatch-grid'

  // Index 63 is left out on purpose. wplace lets you *paint* it, but inside a template it means
  // "this pixel can be anything" rather than "this pixel must be transparent" — it is a wildcard,
  // not a colour. There is nothing to show or hide, so a switch for it would be a switch for
  // nothing. Progress will have to read it the same way when it is built: a wildcard matches
  // whatever is already on the canvas.
  for (const colour of WPLACE_PALETTE) {
    if (colour.index === TRANSPARENT_INDEX) continue
    grid.appendChild(
      paletteSwatch(colour, !hidden.has(colour.index), () => {
        // Touching a swatch while the mode is driving would fight it — the next selection change
        // would undo the click. Take the wheel back first, keeping what is currently shown.
        const base = driven ? globalHiddenColours() : getState().hiddenColours
        const next = new Set(base)
        if (next.has(colour.index)) next.delete(colour.index)
        else next.add(colour.index)
        setState({ hiddenColours: [...next], onlySelectedColour: false })
        rerender()
      }),
    )
  }
  gridWrap.appendChild(grid)
  wrap.appendChild(gridWrap)
  return wrap
}
