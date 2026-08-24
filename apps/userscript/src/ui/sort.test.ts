// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { sortControl } from './sort.js'

describe('sort control', () => {
  it('opens above the panel body when its button is clicked', () => {
    const control = sortControl({ field: 'custom', direction: 'asc' }, vi.fn())
    document.body.appendChild(control)
    const trigger = control.querySelector<HTMLButtonElement>('[data-wts-sort]')
    const menu = control.querySelector<HTMLElement>('[role="menu"]')
    if (trigger === null || menu === null) throw new Error('sort control is incomplete')

    trigger.click()

    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(menu.style.display).toBe('')
    expect(control.style.position).toBe('relative')
    expect(Number(menu.style.zIndex)).toBeGreaterThan(30)
  })

  it('applies the selected sort instead of reopening the menu', () => {
    const onChange = vi.fn()
    const control = sortControl({ field: 'custom', direction: 'asc' }, onChange)
    document.body.appendChild(control)
    const trigger = control.querySelector<HTMLButtonElement>('[data-wts-sort]')
    const name = [...control.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(
      (button) => button.textContent?.includes('Name'),
    )
    if (trigger === null || name === undefined) throw new Error('sort control is incomplete')

    trigger.click()
    name.click()

    expect(onChange).toHaveBeenCalledWith({ field: 'name', direction: 'asc' })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })
})
