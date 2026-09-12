import { log } from './debug.js'
import { pageWindow } from './page-world.js'

/**
 * A live reference to Wplace's global state object.
 *
 * Wplace keeps its app-wide state (theme, language, the open dialogs, the map) on one class
 * instance inside a module closure. Nothing exports it and nothing hangs it on `window`, so the
 * only honest way to reach its setters is to be there when it is built.
 *
 * **Its private fields are WeakMaps.** The bundle compiles `#field` to `WeakMap.prototype.set(this,
 * value)` in the constructor, so a trap on that method sees the instance as `this` is registered.
 * The instance is recognised by shape, not by name: it is the first key whose prototype has a
 * `theme` accessor. The trap comes off the moment it succeeds, and after a startup window if it
 * never does, so a build that stops using WeakMaps costs one wrapper for a few seconds and nothing
 * more. Everything built on this degrades: without the state, the theme key falls back to the
 * settings dialog.
 *
 * Same family of nastiness as `map-handle.ts`, fenced the same way: the wrapper completes the
 * original call exactly, catches everything it does on the side, and runs in the page's realm.
 */

export interface WplaceState {
  theme: string
  [key: string]: unknown
}

/** How long after install the trap stays armed if the state never appears. */
const CAPTURE_WINDOW_MS = 20_000

let captured: WplaceState | null = null
let installedRealm: object | null = null
/** This installation's own wrapper, so a cleanup never restores over another copy's. */
let installedWrapper: WeakMap<object, unknown>['set'] | null = null
let original: WeakMap<object, unknown>['set'] | null = null
let expiry: ReturnType<typeof setTimeout> | null = null

const looksLikeState = (value: unknown): value is WplaceState => {
  if (typeof value !== 'object' || value === null) return false
  const prototype = Object.getPrototypeOf(value) as object | null
  if (prototype === null || prototype === Object.prototype) return false
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'theme')
  return descriptor !== undefined && typeof descriptor.set === 'function'
}

const remove = (): void => {
  if (expiry !== null) clearTimeout(expiry)
  expiry = null
  const realm = installedRealm as (Window & typeof globalThis) | null
  if (realm !== null && original !== null) {
    const prototype = realm.WeakMap.prototype
    // Only if it is still this installation's own wrapper; another copy's is theirs to remove.
    if (prototype.set === installedWrapper) prototype.set = original
  }
  installedRealm = null
  installedWrapper = null
  original = null
}

/** Arm the trap in the page realm. Must run at document-start, before Wplace's modules evaluate. */
export const installWplaceStateCapture = (
  realm: Window & typeof globalThis = pageWindow(),
): void => {
  if (captured !== null || installedRealm !== null) return
  const prototype = realm.WeakMap.prototype
  const native = prototype.set
  const wrapped = function (this: WeakMap<object, unknown>, key: object, value: unknown) {
    // Everything beyond the original call is wrapped: this runs inside someone else's
    // constructor, and a throw here would abort whatever Wplace was initialising.
    try {
      if (captured === null && looksLikeState(key)) {
        captured = key
        log('install', 'captured the Wplace state via WeakMap.set')
        remove()
      }
    } catch {
      // Detection is best-effort; a failure here must not become the page's problem.
    }
    return native.call(this, key, value)
  }
  ;(wrapped as { __caelestis?: true }).__caelestis = true
  try {
    prototype.set = wrapped as typeof prototype.set
  } catch {
    return
  }
  installedRealm = realm
  installedWrapper = wrapped as typeof prototype.set
  original = native
  expiry = setTimeout(remove, CAPTURE_WINDOW_MS)
}

export const getWplaceState = (): WplaceState | null => captured

/** Test seam: disarm and forget. */
export const releaseWplaceStateCapture = (): void => {
  remove()
  captured = null
}
