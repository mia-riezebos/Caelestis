import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  launchersFor,
  launchFirstReady,
  mayReuseExistingBrowser,
  processPatternFor,
} from './chromium.mjs'

describe('Chromium launcher policy', () => {
  it('lets a captured launcher exit while retaining the browser and its diagnostics', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'caelestis-launch-test-'))
    const pidFile = join(directory, 'browser.pid')
    const browser = `
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      console.error('browser startup diagnostic');
      setInterval(() => console.error('browser still running'), 100);
    `
    const script = `
      import { existsSync } from 'node:fs';
      import { launchFirstReady } from ${JSON.stringify(new URL('./chromium.mjs', import.meta.url).href)};
      await launchFirstReady(
        [[process.execPath, ['-e', ${JSON.stringify(browser)}]]],
        undefined,
        async () => existsSync(${JSON.stringify(pidFile)}) ? 'test browser' : null,
      );
    `
    try {
      const { stderr } = await promisify(execFile)(
        process.execPath,
        ['--input-type=module', '-e', script],
        { timeout: 2000, env: { ...process.env, TMPDIR: directory } },
      )
      expect(stderr).toMatch(/^Chromium output: /)
      const logPath = stderr.trim().replace('Chromium output: ', '')
      expect(readFileSync(logPath, 'utf8')).toContain('browser startup diagnostic')
      const pid = Number(readFileSync(pidFile, 'utf8'))
      expect(() => process.kill(pid, 0)).not.toThrow()
    } finally {
      if (existsSync(pidFile)) process.kill(Number(readFileSync(pidFile, 'utf8')))
      rmSync(directory, { recursive: true, force: true })
    }
  })

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
