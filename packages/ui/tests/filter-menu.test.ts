// @vitest-environment happy-dom

import { EMPTY_TEMPLATE_FILTERS, type TemplateFilters } from '@caelestis/shared'
import { flushSync, mount, unmount } from 'svelte'
import { createSubscriber } from 'svelte/reactivity'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TemplateTree from '../src/tree/TemplateTree.svelte'

// Native popover dismissal and layout are covered by browser verification.
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

describe('template filter menu', () => {
  it('sits beside search, keeps selections open, clears all categories, and restores keyboard focus', async () => {
    let filters: TemplateFilters = EMPTY_TEMPLATE_FILTERS
    let update = () => {}
    const subscribe = createSubscriber((notify) => {
      update = notify
    })
    const onIntent = vi.fn((intent) => {
      if (intent.type === 'filter') {
        filters = intent.filters
        update()
      }
    })
    const component = mount(TemplateTree, {
      target: document.body,
      props: {
        get model() {
          subscribe()
          return {
            query: 'city',
            sort: { field: 'custom', direction: 'asc' } as const,
            entries: [],
            filters,
            serverFiltersAvailable: true,
          }
        },
        onIntent,
      },
    })
    flushSync()
    const trigger = document.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')
    if (trigger === null) throw new Error('Missing filter trigger')
    expect(trigger.previousElementSibling?.querySelector('input')?.getAttribute('aria-label')).toBe(
      'Search templates',
    )
    trigger.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
    )
    flushSync()
    const inputs = [...document.querySelectorAll<HTMLInputElement>('[popover] input')]
    expect(inputs).toHaveLength(10)
    expect(document.activeElement).toBe(inputs[0])
    for (const index of [0, 1, 3, 5, 7]) {
      inputs[index]?.click()
      flushSync()
    }
    expect(filters).toEqual({
      source: ['local', 'server'],
      visibility: ['hidden'],
      lifecycle: ['finished'],
      alarm: ['regression'],
    })
    expect(trigger.getAttribute('aria-label')).toBe('Filter templates: 5 selected')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    document.querySelector<HTMLButtonElement>('[role="dialog"] button')?.click()
    flushSync()
    expect(filters).toEqual(EMPTY_TEMPLATE_FILTERS)
    expect(document.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe('city')
    inputs[0]?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    )
    flushSync()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger)
    await unmount(component)
  })

  it('hides unavailable server categories but preserves saved choices for clearing', async () => {
    const component = mount(TemplateTree, {
      target: document.body,
      props: {
        model: {
          query: '',
          sort: { field: 'custom', direction: 'asc' },
          entries: [],
          filters: { ...EMPTY_TEMPLATE_FILTERS, alarm: ['regression'] },
        },
      },
    })
    flushSync()
    expect([...document.querySelectorAll('legend')].map((legend) => legend.textContent)).toEqual([
      'Source',
      'Visibility',
      'Alarms',
    ])
    expect(document.querySelector('input:checked')).not.toBeNull()
    await unmount(component)
  })
})
