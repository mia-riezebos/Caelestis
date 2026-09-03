// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createUserscriptUpdateCheck,
  installUserscriptUpdateCheck,
  USERSCRIPT_INSTALLER_URL,
} from './userscript-update.js'

const release = (
  tagName: string,
  fields: { readonly draft?: boolean; readonly prerelease?: boolean } = {},
): Response =>
  new Response(
    JSON.stringify({
      tag_name: tagName,
      draft: fields.draft ?? false,
      prerelease: fields.prerelease ?? false,
    }),
  )

const checker = (response: Response | Promise<Response>, runningVersion = '0.6.0') => {
  const notify = vi.fn()
  const fetchLatest = vi.fn(() => Promise.resolve(response))
  return {
    check: createUserscriptUpdateCheck({ runningVersion, fetchLatest, notify }),
    fetchLatest,
    notify,
  }
}

afterEach(() => vi.useRealTimers())

describe('userscript update check', () => {
  it('announces a newer stable release with the canonical installer', async () => {
    const { check, notify } = checker(release('userscript-v0.7.0'))

    await check()

    expect(notify).toHaveBeenCalledWith('Caelestis v0.7.0 is available.', 'info', {
      label: 'Update userscript',
      href: USERSCRIPT_INSTALLER_URL,
    })
  })

  it.each(['userscript-v0.6.0', 'userscript-v0.5.9'])(
    'ignores a current or older release: %s',
    async (tagName) => {
      const { check, notify } = checker(release(tagName))

      await check()

      expect(notify).not.toHaveBeenCalled()
    },
  )

  it('ignores prereleases even when their numeric core is newer', async () => {
    const { check, notify } = checker(release('userscript-v0.7.0-beta.1', { prerelease: true }))

    await check()

    expect(notify).not.toHaveBeenCalled()
  })

  it('announces the same published version once', async () => {
    const { check, notify } = checker(release('userscript-v0.7.0'))

    await check()
    await check()

    expect(notify).toHaveBeenCalledOnce()
  })

  it('keeps network failures silent', async () => {
    const notify = vi.fn()
    const check = createUserscriptUpdateCheck({
      runningVersion: '0.6.0',
      fetchLatest: vi.fn(() => Promise.reject(new Error('offline'))),
      notify,
    })

    await expect(check()).resolves.toBeUndefined()

    expect(notify).not.toHaveBeenCalled()
  })

  it.each([
    ['API failure', new Response(null, { status: 503 })],
    ['decoding failure', new Response('{', { status: 200 })],
  ])('keeps %s silent', async (_label, response) => {
    const { check, notify } = checker(response)

    await expect(check()).resolves.toBeUndefined()

    expect(notify).not.toHaveBeenCalled()
  })

  it('defers the network check until after startup', () => {
    vi.useFakeTimers()
    const check = vi.fn()

    installUserscriptUpdateCheck(check)
    expect(check).not.toHaveBeenCalled()

    vi.runAllTimers()
    expect(check).toHaveBeenCalledOnce()
  })
})
