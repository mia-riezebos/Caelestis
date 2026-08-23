import { describe, expect, it } from 'vitest'
import { launchersFor, mayReuseExistingBrowser } from './chromium.mjs'

describe('Chromium launcher policy', () => {
  it('uses a non-default persistent profile for the Google Chrome fallback', () => {
    const chrome = launchersFor('linux').find(([command]) => command === 'google-chrome')

    expect(chrome).toBeDefined()
    expect(chrome?.[1]).toContain('--remote-debugging-port=9222')
    expect(chrome?.[1].some((argument) => argument.startsWith('--user-data-dir='))).toBe(true)
  })

  it('reuses active CDP only when relaunch was not requested', () => {
    expect(mayReuseExistingBrowser('Chrome/140', false)).toBe(true)
    expect(mayReuseExistingBrowser('Chrome/140', true)).toBe(false)
    expect(mayReuseExistingBrowser(null, false)).toBe(false)
  })
})
