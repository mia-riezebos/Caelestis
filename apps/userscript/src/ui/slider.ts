import { icon } from './icons.js'

export interface SliderRowOptions {
  readonly label: string
  readonly value: number
  readonly defaultValue: number
  readonly min: number
  readonly max: number
  readonly step: number
  readonly format: (value: number) => string
  readonly compact?: boolean
  readonly locked?: boolean
  readonly control?: string
  readonly onInput: (value: number) => void
  readonly onReset: (value: number) => void
}

export interface SliderRow {
  readonly element: HTMLElement
  readonly input: HTMLInputElement
  readonly readout: HTMLElement
  readonly reset: HTMLButtonElement
  readonly setValue: (value: number) => void
}

/** One range row, including the shared changed-state and reset interaction. */
export const sliderRow = (options: SliderRowOptions): SliderRow => {
  const wrap = document.createElement('label')
  wrap.className = `caelestis-slider-row flex items-center ${options.compact === true ? 'gap-2' : 'gap-3'}`
  wrap.style.padding = options.compact === true ? '0.25rem 0' : '0.25rem 0'

  const name = document.createElement('span')
  name.className = options.compact === true ? 'text-xs opacity-70' : 'text-sm'
  name.style.minWidth = options.compact === true ? '3.5rem' : '5rem'
  name.style.flex = '0 1 auto'
  name.textContent = options.label

  const input = document.createElement('input')
  input.type = 'range'
  input.className = 'range range-xs'
  input.min = String(options.min)
  input.max = String(options.max)
  input.step = String(options.step)
  input.style.flex = '1'
  input.style.minWidth = '0'
  input.setAttribute('aria-label', options.label)
  input.setAttribute('aria-disabled', String(options.locked === true))
  if (options.control !== undefined) input.dataset.caelestisControl = options.control

  const readout = document.createElement('span')
  readout.className = 'caelestis-slider-readout text-xs opacity-60'
  readout.style.width = options.compact === true ? '2.5rem' : '2.75rem'
  readout.style.flex = '0 0 auto'
  readout.style.textAlign = 'right'
  readout.style.fontVariantNumeric = 'tabular-nums'

  const reset = document.createElement('button')
  reset.type = 'button'
  reset.className = 'btn btn-ghost btn-xs btn-circle caelestis-slider-reset'
  reset.title = `Reset ${options.label.toLowerCase()}`
  reset.setAttribute('aria-label', reset.title)
  reset.appendChild(icon('reset', 'size-3'))
  reset.setAttribute('aria-disabled', String(options.locked === true))

  const setValue = (value: number): void => {
    input.value = String(value)
    readout.textContent = options.format(value)
    reset.hidden = Object.is(value, options.defaultValue)
  }
  setValue(options.value)

  const restore = (): void => {
    if (options.locked === true || Object.is(Number(input.value), options.defaultValue)) return
    setValue(options.defaultValue)
    options.onReset(options.defaultValue)
  }
  reset.addEventListener('click', restore)
  input.addEventListener('dblclick', (event) => {
    event.preventDefault()
    restore()
  })
  input.addEventListener('input', () => {
    if (options.locked === true) return
    const value = Number(input.value)
    readout.textContent = options.format(value)
    reset.hidden = Object.is(value, options.defaultValue)
    options.onInput(value)
  })
  if (options.locked === true) {
    for (const gesture of ['pointerdown', 'keydown']) {
      input.addEventListener(gesture, (event) => event.preventDefault())
    }
  }

  wrap.append(name, input, readout, reset)
  return { element: wrap, input, readout, reset, setValue }
}
