import { log } from './debug.js'
import { pageWindow } from './page-world.js'

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
  easeTo(options: Record<string, unknown>): unknown
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

/**
 * The setters this installation put on `Object.prototype`, and what was there before them.
 *
 * Both halves matter. Deleting whatever setter currently sits under one of these names would remove
 * a setter the page installed after capture — these are ordinary private-ish names and nothing says
 * wplace will not use one — and overwriting a pre-existing descriptor without keeping it means it
 * never comes back.
 */
/**
 * The page's `Object.prototype`, which in a separate-realm sandbox is not this one.
 *
 * MapLibre's objects inherit from the page's. Trapping the local prototype means the assignment this
 * is waiting for never reaches a setter, `getMap()` stays null for the session, and everything built
 * on the handle — the WebGL context ownership check, any later camera move — is silently inert.
 */
const pageProto = (): object =>
  (pageWindow() as unknown as { Object: ObjectConstructor }).Object.prototype

const installed = new Map<string, PropertyDescriptor | undefined>()
const ours = new Map<string, PropertyDescriptor>()
let releaseTimer: ReturnType<typeof setTimeout> | null = null

const removeTraps = (): void => {
  if (releaseTimer !== null) {
    clearTimeout(releaseTimer)
    releaseTimer = null
  }
  for (const [property, original] of installed) {
    const current = Object.getOwnPropertyDescriptor(pageProto(), property)
    // Only if it is still ours. Someone else's setter under this name is theirs to remove.
    if (current === undefined || current.set !== ours.get(property)?.set) continue
    if (original === undefined) {
      delete (pageProto() as Record<string, unknown>)[property]
    } else {
      Object.defineProperty(pageProto(), property, original)
    }
  }
  installed.clear()
  ours.clear()
}

export const installMapCapture = (): void => {
  for (const property of WITNESS_PROPERTIES) {
    try {
      const original = Object.getOwnPropertyDescriptor(pageProto(), property)
      // An inherited descriptor already has page-visible assignment semantics. Replacing it, even
      // temporarily, can suppress a setter or turn a rejected write into an own property. The other
      // witness names are enough; an occupied one belongs to whoever installed it first.
      if (original !== undefined) continue
      const descriptor: PropertyDescriptor = {
        configurable: true,
        get() {
          return undefined
        },
        set(this: object, value: unknown) {
          // Preserve the assignment's native success/failure semantics first. Without this
          // inherited trap, strict assignment to a non-extensible receiver throws.
          Object.defineProperty(this, property, {
            value,
            writable: true,
            configurable: true,
            enumerable: true,
          })
          // Everything this setter does beyond completing the assignment is wrapped, because it runs
          // inside someone else's assignment statement. A throwing `flyTo` getter, a proxy trap, a
          // hostile receiver — any of them would otherwise throw after a successful assignment and
          // abort whatever was initialising, which for MapLibre is the map itself.
          try {
            if (captured === null && looksLikeMap(this)) {
              captured = this
              log('install', `captured the map via ${property}`)
              removeTraps()
            }
          } catch {
            // Detection is best-effort; a failure here must not become the page's problem.
          }
        },
      }
      Object.defineProperty(pageProto(), property, descriptor)
      installed.set(property, original)
      ours.set(property, descriptor)
    } catch {
      // A property already defined non-configurably is not worth fighting over; the others remain.
    }
  }
  releaseTimer = setTimeout(removeTraps, RELEASE_AFTER_MS)
}

export const getMap = (): MapLike | null => captured

/**
 * Remove the traps and forget the map.
 *
 * A test seam, and the honest name for what `removeTraps` already does: this module owns global
 * state, and a test that cannot put it back cannot run twice.
 */
export const releaseMapCapture = (): void => {
  removeTraps()
  captured = null
}
