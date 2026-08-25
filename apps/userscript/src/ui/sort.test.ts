// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { progressChangesCanReorder, sortControl } from './sort.js'

describe('sort control', () => {
  it('marks progress sorting as structurally sensitive to progress changes', () => {
    expect(progressChangesCanReorder({ field: 'progress', direction: 'asc' })).toBe(true)
    expect(progressChangesCanReorder({ field: 'custom', direction: 'asc' })).toBe(false)
  })

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

  it('offers progress with the most-complete direction first', () => {
    const onChange = vi.fn()
    const control = sortControl({ field: 'custom', direction: 'asc' }, onChange)
    document.body.appendChild(control)
    const progress = [
      ...control.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
    ].find((button) => button.textContent?.includes('Progress'))
    if (progress === undefined) throw new Error('progress sort is missing')

    progress.click()

    expect(onChange).toHaveBeenCalledWith({ field: 'progress', direction: 'desc' })
  })
})
