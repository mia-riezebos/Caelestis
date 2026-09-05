// @vitest-environment happy-dom

import { defaultTemplateSort } from '@caelestis/shared'
import { flushSync, mount, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SortMenu from '../src/tree/SortMenu.svelte'

// Happy DOM lacks the Popover API. Browser QA verifies native dismissal and top-layer layout.
beforeEach(() => {
  document.body.replaceChildren()
  for (const [method, newState] of [
    ['showPopover', 'open'],
    ['hidePopover', 'closed'],
  ]) {
    Object.defineProperty(HTMLElement.prototype, method, {
      configurable: true,
      value(this: HTMLElement) {
        const event = new Event('beforetoggle')
        Object.defineProperty(event, 'newState', { value: newState })
        this.dispatchEvent(event)
      },
    })
  }
})
afterEach(() => {
  Reflect.deleteProperty(HTMLElement.prototype, 'showPopover')
  Reflect.deleteProperty(HTMLElement.prototype, 'hidePopover')
})
const button = (selector: string) => {
  const element = document.querySelector<HTMLButtonElement>(selector)
  if (element === null) throw new Error(`Missing button: ${selector}`)
  return element
}
const trigger = () => button('[aria-haspopup="menu"]')
const choices = () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
const reverse = () => button('[role="menuitemcheckbox"]')
const key = (target: Element | null, value: string) => {
  if (target === null) throw new Error('Missing keyboard target')
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }),
  )
  flushSync()
}

describe('template sort menu', () => {
  it.each([
    ['custom', 0, 'asc'],
    ['recent', 1, 'desc'],
    ['name', 2, 'asc'],
    ['progress', 3, 'desc'],
    ['size', 4, 'desc'],
    ['mismatched', 5, 'desc'],
  ] as const)('selects %s with its default direction', async (field, index, direction) => {
    const onSort = vi.fn()
    const component = mount(SortMenu, {
      target: document.body,
      props: { sort: defaultTemplateSort('custom'), onSort },
    })
    flushSync()
    trigger().click()
    flushSync()
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    expect(choices()).toHaveLength(6)
    expect(choices()[0]?.getAttribute('aria-checked')).toBe('true')
    choices()[index]?.click()
    flushSync()
    expect(onSort).toHaveBeenCalledWith({ field, direction })
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger())
    await unmount(component)
  })

  it('exposes reversed state and emits the opposite direction', async () => {
    const onSort = vi.fn()
    const component = mount(SortMenu, {
      target: document.body,
      props: { sort: { field: 'size', direction: 'asc' }, onSort },
    })
    flushSync()
    trigger().click()
    flushSync()
    expect(trigger().getAttribute('aria-label')).toBe('Sort templates: Size, ascending')
    expect(reverse().getAttribute('aria-checked')).toBe('true')
    reverse().click()
    expect(onSort).toHaveBeenCalledWith({ field: 'size', direction: 'desc' })
    await unmount(component)
  })

  it('supports arrows, Home, End and Escape while skipping disabled reversal', async () => {
    const component = mount(SortMenu, {
      target: document.body,
      props: { sort: defaultTemplateSort('custom'), onSort: vi.fn() },
    })
    flushSync()
    trigger().focus()
    key(trigger(), 'ArrowDown')
    expect(document.activeElement).toBe(choices()[0])
    expect(reverse().disabled).toBe(true)
    key(document.activeElement, 'ArrowUp')
    expect(document.activeElement).toBe(choices()[5])
    key(document.activeElement, 'Home')
    expect(document.activeElement).toBe(choices()[0])
    key(document.activeElement, 'End')
    expect(document.activeElement).toBe(choices()[5])
    key(document.activeElement, 'Escape')
    expect(document.activeElement).toBe(trigger())
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    await unmount(component)
  })

  it('releases focus on Tab and reflects native light dismissal', async () => {
    const component = mount(SortMenu, {
      target: document.body,
      props: { sort: defaultTemplateSort('recent'), onSort: vi.fn() },
    })
    flushSync()
    key(trigger(), 'ArrowUp')
    expect(document.activeElement).toBe(reverse())
    key(reverse(), 'Tab')
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    trigger().click()
    flushSync()
    document.querySelector<HTMLElement>('[popover]')?.hidePopover()
    flushSync()
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    await unmount(component)
  })
})
