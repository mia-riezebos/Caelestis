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

const applyPreset = (preset: ColourPresetId): void => {
  const on = new Set(presetIndices(preset, ownedColours()))
  const hidden: number[] = []
  for (let index = 0; index < PALETTE_SIZE; index++) {
    if (index !== TRANSPARENT_INDEX && !on.has(index)) hidden.push(index)
  }
  setState({ hiddenColours: hidden })
}

/**
 * "Only the colour I am placing" — a mode, not a preset.
 *
 * The four presets set the switches and then stop mattering. This one keeps mattering: it follows
 * wplace's selection for as long as it is on, and does nothing at all until their paint drawer is
 * open, because before that there is no colour being placed. Turning it off gives back whatever was
 * switched off by hand, since it never wrote to that set.
 */
export const onlySelectedToggle = (rerender: () => void): HTMLButtonElement => {
  const on = getState().onlySelectedColour
  const button = document.createElement('button')
  button.type = 'button'
  button.className = on ? 'btn btn-xs btn-active' : 'btn btn-xs'
  button.appendChild(icon('brush', 'size-4'))
  const selected = selectedColour()
  button.title = !on
    ? 'Show only the colour selected in wplace'
    : isPaintOpen() && selected !== null
      ? `Showing only ${WPLACE_PALETTE[selected]?.name ?? 'the selected colour'}`
      : 'Showing only the selected colour — open wplace’s paint drawer to pick one'
  button.setAttribute('aria-label', 'Show only the selected colour')
  button.setAttribute('aria-pressed', String(on))
  button.addEventListener('click', () => {
    setState({ onlySelectedColour: !on })
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

  const presets = document.createElement('div')
  // Wraps: the panel is user-resizable and a fifth preset was already enough to push the last one
  // off the edge at the default width.
  presets.className = 'flex flex-wrap gap-1 px-3 pb-2'
  // The labels are the labels. Nothing here needs a sentence.
  for (const [id, label] of [
    ['all', 'All'],
    ['free', 'Free'],
    ['premium', 'Premium'],
    ['owned', 'Owned'],
  ] as ReadonlyArray<readonly [ColourPresetId, string]>) {
    const button = document.createElement('button')
    button.className = 'btn btn-xs'
    button.textContent = label
    if (id === 'owned' && ownedColours() === null) {
      // Only disabled when we genuinely could not ask — signed out, or wplace refused.
      button.classList.add('btn-disabled')
      button.title = 'Sign in to wplace so it can tell us which colours you own'
    }
    button.addEventListener('click', () => {
      // Picking a preset is an explicit statement about which colours to show, so it takes the
      // wheel back from the follow-the-selection mode rather than being silently overridden by it.
      applyPreset(id)
      setState({ onlySelectedColour: false })
      rerender()
    })
    presets.appendChild(button)
  }
  presets.appendChild(onlySelectedToggle(rerender))
  wrap.appendChild(presets)

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
    const swatch = document.createElement('button')
    const on = !hidden.has(colour.index)
    swatch.type = 'button'
    swatch.className = 'wts-swatch'
    swatch.dataset.on = String(on)
    swatch.style.backgroundColor = colour.hex
    swatch.title = `${colour.name} · ${colour.kind}`
    swatch.setAttribute('aria-label', `${colour.name}, ${colour.kind}`)
    swatch.setAttribute('aria-pressed', String(on))
    swatch.addEventListener('click', () => {
      // Touching a swatch while the mode is driving would fight it — the next selection change
      // would undo the click. Take the wheel back first, keeping what is currently shown.
      const base = driven ? globalHiddenColours() : getState().hiddenColours
      const next = new Set(base)
      if (next.has(colour.index)) next.delete(colour.index)
      else next.add(colour.index)
      setState({ hiddenColours: [...next], onlySelectedColour: false })
      rerender()
    })
    grid.appendChild(swatch)
  }
  gridWrap.appendChild(grid)
  wrap.appendChild(gridWrap)
  return wrap
}
