// @vitest-environment happy-dom

import { flushSync, mount, unmount } from 'svelte'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Button from '../src/foundations/Button.svelte'
import SliderRow from '../src/foundations/SliderRow.svelte'
import Toggle from '../src/foundations/Toggle.svelte'

beforeEach(() => document.body.replaceChildren())

describe('UI foundations', () => {
  it('exposes pressed and disabled button state without changing click semantics', () => {
    const onclick = vi.fn()
    const component = mount(Button, {
      target: document.body,
      props: { label: 'Only selected colour', pressed: true, disabled: true, onclick },
    })
    flushSync()

    const button = document.querySelector('button')
    expect(button?.getAttribute('aria-pressed')).toBe('true')
    expect(button?.disabled).toBe(true)
    button?.click()
    expect(onclick).not.toHaveBeenCalled()
    void unmount(component)
  })

  it('updates a slider readout and restores its default through one intent', () => {
    const onInput = vi.fn()
    const onReset = vi.fn()
    const component = mount(SliderRow, {
      target: document.body,
      props: {
        label: 'Opacity',
        value: 0.5,
        defaultValue: 1,
        min: 0,
        max: 1,
        step: 0.1,
        format: (value: number) => `${Math.round(value * 100)}%`,
        onInput,
        onReset,
      },
    })
    flushSync()

    const input = document.querySelector<HTMLInputElement>('input[type="range"]')
    if (input === null) throw new Error('missing slider')
    input.value = '0.7'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    flushSync()
    expect(onInput).toHaveBeenCalledWith(0.7)
    expect(document.body.textContent).toContain('70%')

    document.querySelector<HTMLButtonElement>('[aria-label="Reset opacity"]')?.click()
    flushSync()
    expect(onReset).toHaveBeenCalledWith(1)
    expect(input.value).toBe('1')
    void unmount(component)
  })

  it('labels toggles and reports their next value', () => {
    const onChange = vi.fn()
    const component = mount(Toggle, {
      target: document.body,
      props: { label: 'Show markers', checked: false, onChange },
    })
    flushSync()

    const input = document.querySelector<HTMLInputElement>('input')
    input?.click()
    expect(input?.getAttribute('aria-label')).toBe('Show markers')
    expect(onChange).toHaveBeenCalledWith(true)
    void unmount(component)
  })
})
