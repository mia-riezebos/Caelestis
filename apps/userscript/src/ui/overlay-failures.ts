export type OverlayFailureKey =
  | 'delete'
  | 'visible'
  | 'move'
  | 'server-move'
  | 'move-ready'
  | 'move-stopped'
  | `appearance:${string}`

type Message = (name: string) => string

interface Refusal {
  readonly satisfied: () => boolean
  attempts: number
}

export interface RenderedFailure {
  readonly key: OverlayFailureKey
  readonly message: string
  /** True only once per raised refusal, so rebuilt alert nodes do not repeat themselves. */
  readonly announce: boolean
}

/** Refused durable writes, their expiry conditions, and screen-reader announcement lifecycle. */
class OverlayFailures {
  readonly #messages = new Map<string, Map<OverlayFailureKey, Message>>()
  readonly #announced = new Map<string, Set<OverlayFailureKey>>()
  readonly #refusals = new Map<string, Map<OverlayFailureKey, Refusal>>()

  record(
    id: string,
    key: OverlayFailureKey,
    message: Message,
    satisfied: () => boolean = () => false,
  ): void {
    const messages = this.#messages.get(id) ?? new Map<OverlayFailureKey, Message>()
    messages.set(key, message)
    this.#messages.set(id, messages)

    const refusals = this.#refusals.get(id) ?? new Map<OverlayFailureKey, Refusal>()
    refusals.set(key, { satisfied, attempts: (refusals.get(key)?.attempts ?? 0) + 1 })
    this.#refusals.set(id, refusals)
    // A repeated deliberate attempt is a new event and deserves another announcement.
    this.#announced.get(id)?.delete(key)
  }

  expire(id: string): void {
    const messages = this.#messages.get(id)
    const refusals = this.#refusals.get(id)
    if (messages === undefined || refusals === undefined) return
    for (const [key, refusal] of [...refusals]) {
      if (!messages.has(key)) {
        refusals.delete(key)
        continue
      }
      if (refusal.satisfied()) this.clear(id, key)
    }
  }

  clear(id: string, ...keys: readonly OverlayFailureKey[]): void {
    const messages = this.#messages.get(id)
    if (messages === undefined) return
    for (const key of keys) {
      messages.delete(key)
      this.#announced.get(id)?.delete(key)
      this.#refusals.get(id)?.delete(key)
    }
    if (messages.size === 0) this.#messages.delete(id)
  }

  forget(id: string): void {
    this.#messages.delete(id)
    this.#announced.delete(id)
    this.#refusals.delete(id)
  }

  ids(): ReadonlySet<string> {
    return new Set([...this.#messages.keys(), ...this.#announced.keys(), ...this.#refusals.keys()])
  }

  has(id: string, key: OverlayFailureKey): boolean {
    return this.#messages.get(id)?.has(key) === true
  }

  signature(id: string, name: string): string {
    return [...(this.#messages.get(id) ?? [])]
      .map(
        ([key, text]) => `${key}#${this.#refusals.get(id)?.get(key)?.attempts ?? 0}=${text(name)}`,
      )
      .join(',')
  }

  render(id: string, name: string): readonly RenderedFailure[] {
    const messages = this.#messages.get(id)
    if (messages === undefined) return []
    const seen = this.#announced.get(id) ?? new Set<OverlayFailureKey>()
    this.#announced.set(id, seen)
    return [...messages].map(([key, message]) => {
      const announce = !seen.has(key)
      seen.add(key)
      return { key, message: message(name), announce }
    })
  }

  unannounce(id: string, key: OverlayFailureKey): void {
    this.#announced.get(id)?.delete(key)
  }
}

export const overlayFailures = new OverlayFailures()
