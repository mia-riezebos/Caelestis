import type { Appearance } from '../templates/appearance.js'
import { slider } from './slider.js'

/**
 * What the crosshairs look like, and what they do while you are working one colour at a time.
 *
 * Shared by the settings pane and each overlay's own menu, because the two write to different places
 * and ask the same questions. "Fade the rest" earns its own control rather than being implied by
 * follow-the-selection: markers you cannot act on right now are still the map of what is left, and
 * how much you want them out of the way is a preference, not a consequence.
 */
export const markerAppearance = (
  values: Appearance,
  write: (patch: Partial<Appearance>) => void,
  rerender: () => void,
): HTMLElement => {
  const wrap = document.createElement('div')
  wrap.className = 'flex flex-col'

  const colourRow = (
    label: string,
    value: string | null,
    fallback: string,
    onChange: (next: string | null) => void,
    nullable: boolean,
  ): HTMLElement => {
    const row = document.createElement('label')
    row.className = 'flex items-center gap-2'
    row.style.padding = '0.125rem 0'
    const name = document.createElement('span')
    name.className = 'text-xs opacity-70'
    name.style.width = '4rem'
    name.style.flex = '0 0 auto'
    name.textContent = label
    const input = document.createElement('input')
    input.type = 'color'
    input.className = 'input input-xs'
    input.style.padding = '0'
    input.style.width = '2.5rem'
    input.value = value ?? fallback
    input.addEventListener('input', () => onChange(input.value))
    row.append(name, input)
    if (nullable) {
      // Null is a real answer here — "one colour throughout" — and it needs a way back, because a
      // colour input has no empty state to return to once it has been given a value.
      const same = document.createElement('button')
      same.type = 'button'
      same.className = value === null ? 'btn btn-xs btn-primary' : 'btn btn-xs'
      same.textContent = 'Same'
      same.title = 'Use one colour for every marker'
      same.addEventListener('click', () => {
        onChange(null)
        rerender()
      })
      row.appendChild(same)
    }
    return row
  }

  wrap.append(
    slider(
      { label: 'Size', min: 3, max: 33, step: 1, format: (v) => `${Math.round(v)}px` },
      values.markerSize,
      (next) => write({ markerSize: next }),
    ),
    colourRow(
      'Colour',
      values.markerColour,
      '#ff00ff',
      (next) => {
        if (next !== null) write({ markerColour: next })
      },
      false,
    ),
    slider(
      {
        label: 'Fade rest',
        min: 0,
        max: 1,
        step: 0.05,
        format: (v) => (v >= 1 ? 'off' : `${Math.round((1 - v) * 100)}%`),
      },
      values.otherOpacity,
      (next) => write({ otherOpacity: next }),
    ),
    colourRow(
      'Rest',
      values.otherColour,
      values.markerColour,
      (next) => write({ otherColour: next }),
      true,
    ),
  )
  return wrap
}
