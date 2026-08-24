import { describe, expect, it } from 'vitest'
import {
  launchersFor,
  launchFirstReady,
  mayReuseExistingBrowser,
  processPatternFor,
} from './chromium.mjs'

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

  it('tries the next installed browser when a spawned candidate never opens CDP', async () => {
    const started = []
    let active = ''
    const result = await launchFirstReady(
      [
        ['chromium', ['--flag']],
        ['google-chrome', ['--flag']],
      ],
      async (command) => {
        started.push(command)
        active = command
        return true
      },
      async () => (active === 'google-chrome' ? 'Chrome/140' : null),
      async () => undefined,
      2,
    )

    expect(result).toEqual({ version: 'Chrome/140', launched: true })
    expect(started).toEqual(['chromium', 'google-chrome'])
  })

  it('matches Linux chromium-browser despite the kernel process-name limit', () => {
    expect(processPatternFor('linux')).toContain('chromium-browse')
  })
})
