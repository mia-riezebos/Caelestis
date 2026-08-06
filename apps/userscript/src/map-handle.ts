import { log } from './debug.js'

/**
 * A live reference to wplace's MapLibre `Map`.
 *
 * Getting one took several dead ends, all recorded in `10-recon-map-stack`: it is on no global, on
 * no DOM node, in no module export, and `Function.prototype.bind` never sees it because the build
 * uses arrow functions. Synthesised input does not move the camera either — MapLibre ignores
 * untrusted events — and `pushState` does nothing, because wplace syncs the map to the URL and never
 * the reverse.
 *
 * What does work: **the Map assigns distinctive private fields to itself while it is being built.**
 * A setter on `Object.prototype` for one of those names sees the assignment, and `this` at that
 * moment *is* the Map. The trap is removed as soon as it fires.
 *
 * This is a deliberate piece of nastiness, so it is fenced in:
 *
 * - It only claims an object that actually looks like a Map, so an unrelated assignment is ignored.
 * - It re-defines the property on the target afterwards, so the object ends up exactly as it would
 *   have been and nothing downstream can tell.
 * - It removes itself on capture, and unconditionally after a timeout, so `Object.prototype` is
 *   never left modified.
 * - Everything that depends on it degrades: without a Map we fall back to the URL, which reloads.
 *
 * It must run before MapLibre constructs, so it belongs at `document-start`, ahead of everything.
 */

/** Assigned by MapLibre's `Map` during `_setupContainer`. Measured: `_canvasContainer` fires. */
const WITNESS_PROPERTIES = ['_canvasContainer', '_controlContainer', '_canvas'] as const

/** Give up long after the map would have been built, so the prototype is never left patched. */
const RELEASE_AFTER_MS = 30_000

let captured: MapLike | null = null

/** Only what we use. MapLibre's surface is far larger, and we deliberately touch little of it. */
export interface MapLike {
  flyTo(options: Record<string, unknown>): unknown
  jumpTo(options: Record<string, unknown>): unknown
  getZoom(): number
  getCenter(): { lng: number; lat: number }
  getCanvas(): HTMLCanvasElement
  cameraForBounds?(
    bounds: [[number, number], [number, number]],
    options?: Record<string, unknown>,
  ): { center: { lng: number; lat: number } | [number, number]; zoom: number } | undefined
}

const looksLikeMap = (value: unknown): value is MapLike =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as MapLike).flyTo === 'function' &&
  typeof (value as MapLike).getZoom === 'function'

const removeTraps = (): void => {
  for (const property of WITNESS_PROPERTIES) {
    const descriptor = Object.getOwnPropertyDescriptor(Object.prototype, property)
    if (descriptor?.set !== undefined) {
      // biome-ignore lint/performance/noDelete: restoring Object.prototype is the whole point
      delete (Object.prototype as Record<string, unknown>)[property]
    }
  }
}

export const installMapCapture = (): void => {
  for (const property of WITNESS_PROPERTIES) {
    try {
      Object.defineProperty(Object.prototype, property, {
        configurable: true,
        get() {
          return undefined
        },
        set(this: object, value: unknown) {
          if (captured === null && looksLikeMap(this)) {
            captured = this
            log('install', `captured the map via ${property}`)
            removeTraps()
          }
          // Complete the assignment the object was making, as an ordinary own property, so nothing
          // downstream can tell this happened.
          Object.defineProperty(this, property, {
            value,
            writable: true,
            configurable: true,
            enumerable: true,
          })
        },
      })
    } catch {
      // A property already defined non-configurably is not worth fighting over; the others remain.
    }
  }
  setTimeout(removeTraps, RELEASE_AFTER_MS)
}

export const getMap = (): MapLike | null => captured
