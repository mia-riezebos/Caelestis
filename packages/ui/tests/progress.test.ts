// @vitest-environment happy-dom

import { flushSync, mount, unmount } from 'svelte'
import { beforeEach, describe, expect, it } from 'vitest'
import ProgressMeter from '../src/progress/ProgressMeter.svelte'

beforeEach(() => document.body.replaceChildren())

describe('progress meter', () => {
  it('exposes painted and scanned progress while preserving alarm semantics', () => {
    const component = mount(ProgressMeter, {
      target: document.body,
      props: {
        progress: { completed: 75, mismatched: 5, unpainted: 10, known: 90, total: 100 },
        griefWatch: true,
      },
    })
    flushSync()

    const meter = document.querySelector('[role="meter"]')
    expect(meter?.getAttribute('aria-valuenow')).toBe('75')
    expect(meter?.getAttribute('aria-label')).toBe('painted 75%, scanned 90%')
    expect(document.body.textContent).toContain('75.0%')
    expect(document.querySelector('.alarm-text')).not.toBeNull()

    void unmount(component)
  })
})
