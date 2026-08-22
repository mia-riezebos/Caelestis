/**
 * A labelled slider with its value beside it.
 *
 * Extracted because three surfaces draw the same control — the settings pane, an overlay's own menu,
 * and the marker settings shared by both — and two of them had grown their own copy, which is how a
 * row ends up 4rem wide in one place and 5rem in another.
 */
export interface SliderControl {
  readonly label: string
  readonly min: number
  readonly max: number
  readonly step: number
  /** How to read the value back. The number alone rarely says what it means. */
  readonly format: (value: number) => string
}

export const slider = (
  control: SliderControl,
  value: number,
  onChange: (next: number) => void,
): HTMLElement => {
  const wrap = document.createElement('label')
  wrap.className = 'flex items-center gap-2'
  wrap.style.padding = '0.125rem 0'
  const name = document.createElement('span')
  name.className = 'text-xs opacity-70'
  name.style.width = '4rem'
  name.style.flex = '0 0 auto'
  name.textContent = control.label
  const input = document.createElement('input')
  input.type = 'range'
  input.className = 'range range-xs'
  input.min = String(control.min)
  input.max = String(control.max)
  input.step = String(control.step)
  input.value = String(value)
  input.style.flex = '1'
  input.style.minWidth = '0'
  const readout = document.createElement('span')
  readout.className = 'text-xs opacity-50'
  readout.style.width = '2.5rem'
  readout.style.flex = '0 0 auto'
  readout.style.textAlign = 'right'
  readout.textContent = control.format(value)
  input.addEventListener('input', () => {
    const next = Number(input.value)
    readout.textContent = control.format(next)
    onChange(next)
  })
  wrap.append(name, input, readout)
  return wrap
}
