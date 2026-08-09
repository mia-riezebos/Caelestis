/**
 * Debug instrumentation for the render path.
 *
 * The overlay depends on a chain of inferences about someone else's WebGL traffic — which texture
 * is a tile, which tile it is, where MapLibre put it — and when one link breaks, the only visible
 * symptom is that the overlay silently goes missing. That is very hard to reason about from a
 * screenshot, so every link reports what it did and, more importantly, why it declined.
 *
 * Off by default so a shipped script stays quiet. Turn it on from the console with
 * `__wts.debug(true)` and reload, or set `localStorage.wtsDebug = '1'` to have it survive reloads.
 * `__wts.dump()` prints the counters and the recent event ring, which is the thing to send when
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

/** Categories that fire per frame; logged to the ring always, to the console only when they change. */
const NOISY: ReadonlySet<Category> = new Set(['frame', 'draw', 'quad'])

let enabled = false
let ring: Entry[] = []
const counters = new Map<string, number>()
const lastNoisy = new Map<Category, string>()
const started = Date.now()

const readInitialSetting = (): boolean => {
  try {
    return localStorage.getItem('wtsDebug') === '1'
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
  count(counterKey(category, message))
  if (!enabled) return

  const entry: Entry = { at: Date.now() - started, category, message, data }
  ring.push(entry)
  if (ring.length > RING_SIZE) ring.shift()

  // A per-frame category would drown the console, so it only speaks when its story changes.
  if (NOISY.has(category)) {
    const signature = `${message}:${JSON.stringify(data ?? null)}`
    if (lastNoisy.get(category) === signature) return
    lastNoisy.set(category, signature)
  }
  if (data === undefined) console.info(`[wts:${category}] ${message}`)
  else console.info(`[wts:${category}] ${message}`, data)
}

/** Always reaches the console, debug on or off: something that should not have happened. */
export const warn = (category: Category, message: string, data?: unknown): void => {
  count(`${category}:${message}`)
  ring.push({ at: Date.now() - started, category, message, data })
  if (ring.length > RING_SIZE) ring.shift()
  console.warn(`[wts:${category}] ${message}`, data ?? '')
}

export const isEnabled = (): boolean => enabled

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
      enabled = on
      try {
        if (on) localStorage.setItem('wtsDebug', '1')
        else localStorage.removeItem('wtsDebug')
      } catch {
        // Private browsing and the like. The in-memory flag still applies for this session.
      }
      return `[wts] debug ${on ? 'on' : 'off'} — reload to capture startup, __wts.dump() to print`
    },
    dump() {
      const sorted = [...counters.entries()].sort((a, b) => b[1] - a[1])
      console.group('[wts] debug dump')
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
    },
    ...extra,
  }
  ;(window as unknown as Record<string, unknown>).__wts = api
  console.info(
    enabled
      ? '[wts] debug is ON. __wts.dump() to print, __wts.debug(false) to stop.'
      : '[wts] debug is off. __wts.debug(true) then reload to capture everything.',
  )
}
