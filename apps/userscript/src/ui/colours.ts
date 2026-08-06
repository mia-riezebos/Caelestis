import { PALETTE_SIZE, TRANSPARENT_INDEX, WPLACE_PALETTE } from '@wts/shared'
import { getState, setState } from '../state.js'
import { ownedColours } from '../wplace-account.js'

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

/** Exactly what a preset turns on. `owned` needs `/me`, which is not wired yet. */
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

export const coloursSection = (rerender: () => void): HTMLElement => {
  const wrap = document.createElement('div')
  const hidden = new Set(getState().hiddenColours)

  const presets = document.createElement('div')
  presets.className = 'flex gap-1 px-3 pb-2'
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
      applyPreset(id)
      rerender()
    })
    presets.appendChild(button)
  }
  wrap.appendChild(presets)

  const grid = document.createElement('div')
  grid.className = 'px-3 pb-2'
  Object.assign(grid.style, {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(1.5rem, 1fr))',
    gap: '0.25rem',
  })

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
      const next = new Set(getState().hiddenColours)
      if (next.has(colour.index)) next.delete(colour.index)
      else next.add(colour.index)
      setState({ hiddenColours: [...next] })
      rerender()
    })
    grid.appendChild(swatch)
  }
  wrap.appendChild(grid)
  return wrap
}
