/**
 * A `$state` value mirrored into localStorage, so view preferences — pace windows, sort orders,
 * overlay opacity — survive a reload. JSON-serialised; a corrupt or missing entry falls back to
 * the initial value rather than breaking the page.
 */
export class Persisted<T> {
  #key: string
  #value = $state() as T

  constructor(key: string, initial: T) {
    this.#key = key
    let held = initial
    try {
      const raw = localStorage.getItem(key)
      if (raw !== null) held = JSON.parse(raw) as T
    } catch {
      // Fall back to the initial value.
    }
    this.#value = held
  }

  get value(): T {
    return this.#value
  }

  set value(next: T) {
    this.#value = next
    try {
      localStorage.setItem(this.#key, JSON.stringify(next))
    } catch {
      // Storage full or unavailable: the in-memory value still works for this session.
    }
  }
}

export const persisted = <T>(key: string, initial: T): Persisted<T> => new Persisted(key, initial)
