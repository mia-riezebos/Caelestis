// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'

const startup = vi.hoisted(() => ({
  restore: vi.fn(async () => {}),
  connect: vi.fn(async () => {
    throw new Error('Native APIs unavailable')
  }),
}))
vi.mock('./local-store.js', () => ({
  restoreLocalTemplates: startup.restore,
  refreshPersonalTemplates: vi.fn(),
}))
vi.mock('./native-store.js', () => ({ connectNativeTemplates: startup.connect }))
vi.mock('./native-alliance.js', () => ({ installNativeAllianceTemplates: vi.fn() }))
vi.mock('./personal-store.js', () => ({
  connectPersonalStore: vi.fn(),
  synchronizePersonalTemplates: vi.fn(),
}))

it('establishes durable restoration synchronously before native discovery can yield', async () => {
  const { installPersonalTemplates } = await import('./personal-sync.js')
  const installing = installPersonalTemplates()
  expect(startup.restore).toHaveBeenCalledOnce()
  expect(startup.connect).not.toHaveBeenCalled()
  document.dispatchEvent(new Event('DOMContentLoaded'))
  await installing
})
