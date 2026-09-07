// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getState, setState } from '../state.js'
import { setTemplateDisplayMode, templateDisplayMode } from './display-mode.js'

afterEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
})

describe('template display preference', () => {
  it.each(['manager', 'localStorage'])(
    'restores modes through %s without changing the catalog',
    (backend) => {
      if (backend === 'manager') {
        vi.stubGlobal('GM_getValue', (key: string) => localStorage.getItem(key))
        vi.stubGlobal('GM_setValue', (key: string, value: string) =>
          localStorage.setItem(key, value),
        )
      }
      const original = getState()
      expect(templateDisplayMode()).toBe('tree')
      expect(setTemplateDisplayMode('grid')).toBe(true)
      expect(templateDisplayMode()).toBe('grid')
      expect(getState()).toBe(original)
      // Another tab or an older build can replace the entire catalog settings record.
      setState({ ...original })
      expect(templateDisplayMode()).toBe('grid')
      expect(setTemplateDisplayMode('tree')).toBe(true)
      expect(templateDisplayMode()).toBe('tree')
    },
  )

  it('uses tree for invalid preferences and reports failed writes', () => {
    vi.stubGlobal('GM_getValue', () => 'unknown')
    vi.stubGlobal('GM_setValue', () => {
      throw new Error('storage blocked')
    })
    expect(templateDisplayMode()).toBe('tree')
    expect(setTemplateDisplayMode('grid')).toBe(false)
    expect(templateDisplayMode()).toBe('tree')
  })
})
