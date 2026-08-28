// @vitest-environment happy-dom

import { flushSync, mount, unmount } from 'svelte'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ColourProgress from '../src/progress/ColourProgress.svelte'

beforeEach(() => document.body.replaceChildren())

describe('colour progress', () => {
  it('sorts visible rows and reports sort changes through its typed callback', () => {
    const onSortChange = vi.fn()
    const component = mount(ColourProgress, {
      target: document.body,
      props: {
        colours: [
          { index: 1, correct: 8, total: 10 },
          { index: 2, correct: 1, total: 10 },
        ],
        sort: 'progress-asc',
        onSortChange,
      },
    })
    flushSync()

    const rows = [...document.querySelectorAll('li')]
    expect(rows[0]?.textContent).toContain('1/10')
    const select = document.querySelector<HTMLSelectElement>('select')
    if (select === null) throw new Error('missing sort')
    select.value = 'remaining'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onSortChange).toHaveBeenCalledWith('remaining')
    void unmount(component)
  })
})
