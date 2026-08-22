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
 * moment *is* the Map. The trap is removed as soon as it succeeds (or after a bounded startup
 * window); the layer attachment loop rearms it only after the captured map's canvas is detached.
 *
 * This is a deliberate piece of nastiness, so it is fenced in:
 *
 * - It only claims an object that actually looks like a Map, so an unrelated assignment is ignored.
 * - It re-defines the property on the target afterwards, so the object ends up exactly as it would
 *   have been and nothing downstream can tell.
 * - It is removed explicitly during teardown; while installed, every intercepted assignment is
 *   immediately materialised as the same ordinary own property the engine would have created.
 * - Everything that depends on it degrades: without a Map we fall back to the URL, which reloads.
 *
 * It must run before MapLibre constructs, so it belongs at `document-start`, ahead of everything.
 */

/** Assigned by MapLibre's `Map` during `_setupContainer`. Measured: `_canvasContainer` fires. */
const WITNESS_PROPERTIES = ['_canvasContainer', '_controlContainer', '_canvas'] as const

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
 * The page's `Object.prototype`, which in a separate-realm sandbox is not this one.
 *
 * MapLibre's objects inherit from the page's. Trapping the local prototype means the assignment this
 * is waiting for never reaches a setter, `getMap()` stays null for the session, and everything built
 * on the handle — the WebGL context ownership check, any later camera move — is silently inert.
 */
const pageProto = (realm: Window & typeof globalThis = pageWindow()): object =>
  (realm as unknown as { Object: ObjectConstructor }).Object.prototype

const installed = new Set<string>()
const ours = new Map<string, PropertyDescriptor>()
let installedPrototype: object | null = null

/**
 * The traps come off when the map is caught, and not on a clock.
 *
 * There was a thirty-second release timer here that bounded nothing: `main.ts` re-attaches every
 * second, so the traps went back on thirty seconds after each expiry for as long as the page was
 * open. Making that bound real is worse than dropping it — this setter is the only way the map is
 * ever found, so a MapLibre that constructs late would be missed for the rest of the session and
 * every overlay with it.
 *
 * Holding them costs close to nothing. They are three MapLibre-private names, and the setter's
 * whole job is to complete the assignment exactly as an ordinary property write would.
 */
const removeTraps = (): void => {
  const prototype = installedPrototype
  for (const property of installed) {
    if (prototype === null) continue
    const current = Object.getOwnPropertyDescriptor(prototype, property)
    // Only if it is still ours. Someone else's setter under this name is theirs to remove.
    if (current === undefined || current.set !== ours.get(property)?.set) continue
    delete (prototype as Record<string, unknown>)[property]
  }
  installed.clear()
  ours.clear()
  installedPrototype = null
}

export const installMapCapture = (realm: Window & typeof globalThis = pageWindow()): void => {
  const prototype = pageProto(realm)
  // One capture window owns one realm. A second install cannot safely move traps that page code may
  // already be executing through; release first if a caller deliberately wants another realm.
  if (installedPrototype !== null && installedPrototype !== prototype) return
  if (installedPrototype === prototype && installed.size > 0) return
  installedPrototype = prototype
  for (const property of WITNESS_PROPERTIES) {
    try {
      const original = Object.getOwnPropertyDescriptor(prototype, property)
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
          // Materialise the inherited assignment as the ordinary own property it was trying to
          // create. Reflect reports a non-extensible receiver without throwing through page code.
          // Everything this setter does beyond completing the assignment is wrapped, because it runs
          // inside someone else's assignment statement. A throwing `flyTo` getter, a proxy trap, a
          // hostile receiver — any of them would otherwise throw after a successful assignment and
          // abort whatever was initialising, which for MapLibre is the map itself.
          try {
            if (
              !Reflect.defineProperty(this, property, {
                value,
                writable: true,
                configurable: true,
                enumerable: true,
              })
            )
              return
            if (looksLikeMap(this) && captured === null) {
              captured = this
              log('install', `captured the map via ${property}`)
              removeTraps()
            }
          } catch {
            // Detection is best-effort; a failure here must not become the page's problem.
          }
        },
      }
      Object.defineProperty(prototype, property, descriptor)
      installed.add(property)
      ours.set(property, descriptor)
    } catch {
      // A property already defined non-configurably is not worth fighting over; the others remain.
    }
  }
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
