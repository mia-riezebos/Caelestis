// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sliderRow } from './slider.js'

const build = (overrides: Partial<Parameters<typeof sliderRow>[0]> = {}) => {
  const onInput = vi.fn()
  const onReset = vi.fn()
  const row = sliderRow({
    label: 'Rotation',
    value: 12,
    defaultValue: 0,
    min: 0,
    max: 360,
    step: 1,
    format: (value) => `${value}°`,
    onInput,
    onReset,
    ...overrides,
  })
  return { row, onInput, onReset }
}

beforeEach(() => {
  document.body.replaceChildren()
})

describe('slider row', () => {
  it('shows changed state and resets from its button', () => {
    const { row, onReset } = build()
    document.body.appendChild(row.element)

    expect(row.reset.hidden).toBe(false)
    row.reset.click()

    expect(row.input.value).toBe('0')
    expect(row.readout.textContent).toBe('0°')
    expect(row.reset.hidden).toBe(true)
    expect(onReset).toHaveBeenCalledWith(0)
  })

  it('keeps a row at rest quiet and reveals reset after input', () => {
    const { row, onInput } = build({ value: 0 })
    expect(row.reset.hidden).toBe(true)

    row.input.value = '25'
    row.input.dispatchEvent(new Event('input'))

    expect(row.reset.hidden).toBe(false)
    expect(onInput).toHaveBeenCalledWith(25)
  })

  it('resets when the range is double-clicked', () => {
    const { row, onReset } = build()
    row.input.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))

    expect(row.input.value).toBe('0')
    expect(onReset).toHaveBeenCalledWith(0)
  })

  it('does not reset a locked row', () => {
    const { row, onReset } = build({ locked: true })
    row.reset.click()
    row.input.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))

    expect(row.input.value).toBe('12')
    expect(onReset).not.toHaveBeenCalled()
  })
})
