import { pageWindow } from './page-world.js'
/**
 * Debug instrumentation for the render path.
 *
 * The overlay depends on a chain of inferences about someone else's WebGL traffic — which texture
 * is a tile, which tile it is, where MapLibre put it — and when one link breaks, the only visible
 * symptom is that the overlay silently goes missing. That is very hard to reason about from a
 * screenshot, so every link reports what it did and, more importantly, why it declined.
 *
 * Off by default so a shipped script stays quiet. Turn it on from the console with
 * `__caelestis.debug(true)` and reload, or set `localStorage.caelestisDebug = '1'` to have it survive reloads.
 * `__caelestis.dump()` prints the counters and the recent event ring, which is the thing to send when
 * something looks wrong.
 */

export type Category =
  | 'fetch'
  | 'bitmap'
  | 'texture'
  | 'quad'
  | 'frame'
  | 'clear'
  | 'draw'
  | 'install'

interface Entry {
  readonly at: number
  readonly category: Category
  readonly message: string
  readonly data?: unknown
}

const RING_SIZE = 400
const MAX_MESSAGE_LENGTH = 512
const MAX_DATA_STRING_LENGTH = 512
const MAX_DATA_ENTRIES = 20
const MAX_DATA_DEPTH = 3

/** Categories that fire per frame; logged to the ring always, to the console only when they change. */
const NOISY: ReadonlySet<Category> = new Set(['frame', 'draw', 'quad'])

let enabled = false
let ring: Entry[] = []
/** Exported for tests: this is module state, and a test needs to start from a known one. */
export const counters = new Map<string, number>()
const lastNoisy = new Map<Category, string>()
const started = Date.now()

const readInitialSetting = (): boolean => {
  try {
    return localStorage.getItem('caelestisDebug') === '1'
  } catch {
    return false
  }
}

/**
 * How many distinct counter keys to keep.
 *
 * Counters run even with debugging off, and callers write tile coordinates into their messages — so
 * keying on the message meant panning across a map added a permanent entry per tile. The ring bounds
 * the log; nothing bounded this.
 */
const MAX_COUNTERS = 200

const DROPPED = 'debug:counter-keys-dropped'

const truncate = (value: string, limit: number): string =>
  value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`

/** Copy only a small diagnostic snapshot; never retain page/import-owned objects in the ring. */
const snapshot = (value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown => {
  if (typeof value === 'string') return truncate(value, MAX_DATA_STRING_LENGTH)
  if (
    value === null ||
    value === undefined ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return value
  }
  if (typeof value !== 'object') return truncate(String(value), MAX_DATA_STRING_LENGTH)
  try {
    if (Object.prototype.toString.call(value) === '[object Error]') {
      const error = value as { readonly name?: unknown; readonly message?: unknown }
      const name = typeof error.name === 'string' ? error.name : 'Error'
      const message = typeof error.message === 'string' ? error.message : ''
      return truncate(message.length > 0 ? `${name}: ${message}` : name, MAX_DATA_STRING_LENGTH)
    }
  } catch {}
  if (seen.has(value)) return '[circular]'
  if (depth >= MAX_DATA_DEPTH) return Object.prototype.toString.call(value)
  seen.add(value)
  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_DATA_ENTRIES).map((entry) => snapshot(entry, depth + 1, seen))
    if (value.length > MAX_DATA_ENTRIES) out.push(`… ${value.length - MAX_DATA_ENTRIES} more`)
    return out
  }
  const out: Record<string, unknown> = {}
  let entries = 0
  try {
    for (const key in value as Record<string, unknown>) {
      if (entries >= MAX_DATA_ENTRIES) {
        out['…'] = 'more properties omitted'
        break
      }
      out[truncate(key, MAX_DATA_STRING_LENGTH)] = snapshot(
        (value as Record<string, unknown>)[key],
        depth + 1,
        seen,
      )
      entries++
    }
    return out
  } catch {
    return Object.prototype.toString.call(value)
  }
}

export const count = (key: string, by = 1): void => {
  if (!counters.has(key) && counters.size >= MAX_COUNTERS) {
    // Set directly rather than recursing: at capacity, counting the drop would count its own drop.
    counters.set(DROPPED, (counters.get(DROPPED) ?? 0) + 1)
    return
  }
  counters.set(key, (counters.get(key) ?? 0) + by)
}

/** The stable part of a message: everything up to the first digit-bearing word. */
export const counterKey = (category: Category, message: string): string =>
  `${category}:${message.replace(/\s*\S*\d\S*/g, '').trim()}`

export const log = (category: Category, message: string, data?: unknown): void => {
  try {
    const boundedMessage = truncate(message, MAX_MESSAGE_LENGTH)
    count(counterKey(category, boundedMessage))
    if (!enabled) return
    const boundedData = snapshot(data)

    const entry: Entry = {
      at: Date.now() - started,
      category,
      message: boundedMessage,
      data: boundedData,
    }
    ring.push(entry)
    if (ring.length > RING_SIZE) ring.shift()

    // A per-frame category would drown the console, so it only speaks when its story changes.
    if (NOISY.has(category)) {
      const signature = `${boundedMessage}:${JSON.stringify(boundedData ?? null)}`
      if (lastNoisy.get(category) === signature) return
      lastNoisy.set(category, signature)
    }
    if (boundedData === undefined) console.info(`[caelestis:${category}] ${boundedMessage}`)
    else console.info(`[caelestis:${category}] ${boundedMessage}`, boundedData)
  } catch {
    // Diagnostics are observers. A hostile/broken page console or unserialisable debug payload must
    // never change the success semantics of the operation being observed.
  }
}

/** Always reaches the console, debug on or off: something that should not have happened. */
export const warn = (category: Category, message: string, data?: unknown): void => {
  try {
    // Same stable key as `log`. Keyed on the raw message, the two hottest warnings carry tile
    // coordinates and filled the 200-key table with single-use entries — after which every genuinely
    // new counter was refused, and `dump()` stopped showing the ones worth reading.
    const boundedMessage = truncate(message, MAX_MESSAGE_LENGTH)
    const boundedData = snapshot(data)
    count(counterKey(category, boundedMessage))
    ring.push({ at: Date.now() - started, category, message: boundedMessage, data: boundedData })
    if (ring.length > RING_SIZE) ring.shift()
    console.warn(`[caelestis:${category}] ${boundedMessage}`, boundedData ?? '')
  } catch {
    // Warnings report failures; they must not create a second failure of their own.
  }
}

export const isEnabled = (): boolean => enabled

/** Turn logging on or off and remember it. Shared by `__caelestis.debug()` and the Diagnostics setting. */
export const setEnabled = (on: boolean): void => {
  enabled = on
  try {
    if (on) localStorage.setItem('caelestisDebug', '1')
    else localStorage.removeItem('caelestisDebug')
  } catch {
    // Private browsing and the like. The in-memory flag still applies for this session.
  }
}

export interface DebugApi {
  debug(on: boolean): string
  dump(): void
  counters(): Record<string, number>
  events(category?: Category): Entry[]
  clear(): void
}

export const installDebugApi = (extra: Record<string, unknown> = {}): void => {
  enabled = readInitialSetting()
  const api: DebugApi & Record<string, unknown> = {
    debug(on: boolean) {
      setEnabled(on)
      return `[caelestis] debug ${on ? 'on' : 'off'} — reload to capture startup, __caelestis.dump() to print`
    },
    dump() {
      const sorted = [...counters.entries()].sort((a, b) => b[1] - a[1])
      console.group('[caelestis] debug dump')
      console.info('enabled:', enabled, '| uptime:', `${Date.now() - started}ms`)
      console.table(Object.fromEntries(sorted))
      console.info(`last ${ring.length} events:`)
      for (const entry of ring) {
        console.info(`  +${entry.at}ms [${entry.category}] ${entry.message}`, entry.data ?? '')
      }
      console.groupEnd()
    },
    counters: () => Object.fromEntries(counters),
    events: (category?: Category) =>
      category === undefined ? [...ring] : ring.filter((entry) => entry.category === category),
    clear() {
      ring = []
      counters.clear()
      lastNoisy.clear()
    },
    ...extra,
  }
  try {
    Object.defineProperty(pageWindow(), '__caelestis', {
      value: api,
      writable: true,
      configurable: true,
    })
  } catch {
    // Debug access is optional; a locked page global must not abort the userscript at document-start.
  }
  try {
    console.info(
      enabled
        ? '[caelestis] debug is ON. __caelestis.dump() to print, __caelestis.debug(false) to stop.'
        : '[caelestis] debug is off. __caelestis.debug(true) then reload to capture everything.',
    )
  } catch {
    // A replaced console is not part of the render path.
  }
}
