import { onActiveAllianceSurfaceChange } from '../alliance-surface.js'
import { warn } from '../debug.js'
import { refreshPersonalTemplates, restoreLocalTemplates } from './local-store.js'
import { installNativeAllianceTemplates } from './native-alliance.js'
import { connectNativeTemplates } from './native-store.js'
import { connectPersonalStore, synchronizePersonalTemplates } from './personal-store.js'

let installed = false

/** Start the native personal owner before restoring its derived Caelestis records. */
export const installPersonalTemplates = async (): Promise<void> => {
  if (installed) return
  installed = true
  // Establish the durable-row admission barrier synchronously, before server sync can claim its budget.
  const restored = restoreLocalTemplates()
  try {
    await restored
    if (document.readyState === 'loading')
      await new Promise<void>((resolve) =>
        document.addEventListener('DOMContentLoaded', () => resolve(), { once: true }),
      )
    const native = await connectNativeTemplates()
    installNativeAllianceTemplates(native)
    if (native.alliance === undefined) {
      let discovering = false
      const stop = onActiveAllianceSurfaceChange((active) => {
        if (active === null || discovering) return
        discovering = true
        void connectNativeTemplates()
          .then((available) => {
            if (available.alliance === undefined) return
            installNativeAllianceTemplates(available)
            stop()
          })
          .catch((error) => warn('install', 'native alliance discovery failed', String(error)))
          .finally(() => {
            discovering = false
          })
      })
    }
    let queued: ReturnType<typeof setTimeout> | undefined
    let syncing = false
    let changed = false
    const refresh = async (): Promise<void> => {
      queued = undefined
      if (syncing) {
        changed = true
        return
      }
      syncing = true
      try {
        do {
          changed = false
          await synchronizePersonalTemplates()
          await refreshPersonalTemplates()
        } while (changed)
      } catch (error) {
        warn('install', 'personal template synchronization failed', String(error))
      } finally {
        syncing = false
      }
    }
    const schedule = (): void => {
      if (queued !== undefined) clearTimeout(queued)
      // Wplace writes metadata after 120 ms and artwork separately. Coalesce those events.
      queued = setTimeout(() => {
        void refresh()
      }, 150)
    }
    connectPersonalStore(native, schedule)
    native.subscribe(schedule)
    window.addEventListener('focus', schedule)
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) schedule()
    })
    await synchronizePersonalTemplates()
    await refreshPersonalTemplates()
  } catch (error) {
    warn('install', 'native personal templates unavailable; retaining local records', String(error))
    await restoreLocalTemplates()
  }
}
