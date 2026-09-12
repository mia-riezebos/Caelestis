// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { NativeAllianceApi } from './native-store.js'

const startup = vi.hoisted(() => ({
  restore: vi.fn(async () => {}),
  connect: vi.fn(
    async (): Promise<{ alliance?: NativeAllianceApi; subscribe: () => () => void }> => {
      throw new Error('Native APIs unavailable')
    },
  ),
  active: false,
  installAlliance: vi.fn(),
}))
beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  startup.active = false
})
afterEach(() => vi.unstubAllGlobals())
vi.mock('../alliance-surface.js', () => ({
  activeAllianceSurface: () => (startup.active ? {} : null),
  onActiveAllianceSurfaceChange: () => () => {},
}))
vi.mock('./local-store.js', () => ({
  restoreLocalTemplates: startup.restore,
  refreshPersonalTemplates: vi.fn(),
}))
vi.mock('./native-store.js', () => ({ connectNativeTemplates: startup.connect }))
vi.mock('./native-alliance.js', () => ({ installNativeAllianceTemplates: startup.installAlliance }))
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

it('retries an already-open editor and a later module load without a surface change', async () => {
  startup.active = true
  const missing = { subscribe: () => () => {} }
  const available = { ...missing, alliance: { getAllianceTemplates: vi.fn(async () => ({})) } }
  startup.connect.mockResolvedValue(missing)
  let notifyResource = () => {}
  const disconnect = vi.fn()
  vi.stubGlobal(
    'PerformanceObserver',
    class {
      constructor(callback: PerformanceObserverCallback) {
        const entries = [
          {
            entryType: 'resource',
            initiatorType: 'script',
            name: 'https://wplace.live/_app/immutable/chunks/alliance.js',
            startTime: 0,
            duration: 1,
            toJSON: () => ({}),
          },
        ]
        notifyResource = () =>
          callback(
            {
              getEntries: () => entries,
              getEntriesByType: () => entries,
              getEntriesByName: () => entries,
            },
            this,
          )
      }
      observe() {}
      disconnect = disconnect
      takeRecords() {
        return []
      }
    },
  )
  const { installPersonalTemplates } = await import('./personal-sync.js')
  await installPersonalTemplates()
  await vi.waitFor(() => expect(startup.connect).toHaveBeenCalledTimes(2))
  startup.connect.mockResolvedValue(available)
  notifyResource()
  await vi.waitFor(() => expect(startup.installAlliance).toHaveBeenCalledWith(available))
  expect(disconnect).toHaveBeenCalledOnce()
})
