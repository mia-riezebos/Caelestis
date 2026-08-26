import type { Appearance } from '../templates/appearance.js'

type DraftKey = keyof Appearance
type DraftValue = Appearance[DraftKey]
export type AppearanceUpdater = (base: Appearance) => Partial<Appearance>

/**
 * In-progress and unacknowledged appearance edits for overlay menus.
 *
 * The DOM is disposable: slider drafts survive rebuilds here, while sequenced updater intents keep
 * rapid edits composable until their durable writes settle.
 */
class OverlayAppearanceState {
  readonly #drafts = new Map<string, Map<DraftKey, DraftValue>>()
  readonly #intents = new Map<string, Map<string, Map<number, AppearanceUpdater>>>()
  #sequence = 0

  draftFor<K extends DraftKey>(id: string, property: K): Appearance[K] | undefined {
    return this.#drafts.get(id)?.get(property) as Appearance[K] | undefined
  }

  setDraft<K extends DraftKey>(id: string, property: K, value: Appearance[K]): void {
    const forTemplate = this.#drafts.get(id) ?? new Map<DraftKey, DraftValue>()
    forTemplate.set(property, value)
    this.#drafts.set(id, forTemplate)
  }

  clearDraft(id: string, property: DraftKey): boolean {
    const forTemplate = this.#drafts.get(id)
    if (forTemplate === undefined || !forTemplate.delete(property)) return false
    if (forTemplate.size === 0) this.#drafts.delete(id)
    return true
  }

  /** Remove and return a stable snapshot before a re-entrant durable commit can render again. */
  takeDrafts(id: string): ReadonlyArray<readonly [DraftKey, DraftValue]> {
    const pending = [...(this.#drafts.get(id) ?? [])]
    this.#drafts.delete(id)
    return pending
  }

  current(id: string, stored: Appearance): Appearance {
    const pending = this.#intents.get(id)
    let composed = stored
    if (pending === undefined) return composed
    // Preserve request order across properties. Colour updaters are toggles, so latest-value
    // replacement would incorrectly collapse a pair of clicks into one.
    const ordered = [...pending.values()].flatMap((bySequence) => [...bySequence])
    ordered.sort(([left], [right]) => left - right)
    for (const [, updater] of ordered) composed = { ...composed, ...updater(composed) }
    return composed
  }

  drafted(id: string, stored: Appearance): Appearance {
    let appearance = this.current(id, stored)
    for (const [property, value] of this.#drafts.get(id) ?? []) {
      appearance = { ...appearance, [property]: value }
    }
    return appearance
  }

  intend(id: string, properties: readonly string[], updater: AppearanceUpdater): number {
    const sequence = ++this.#sequence
    const pending = this.#intents.get(id) ?? new Map<string, Map<number, AppearanceUpdater>>()
    for (const property of properties) {
      const bySequence = pending.get(property) ?? new Map<number, AppearanceUpdater>()
      bySequence.set(sequence, updater)
      pending.set(property, bySequence)
    }
    this.#intents.set(id, pending)
    return sequence
  }

  release(id: string, properties: readonly string[], sequence: number): void {
    const pending = this.#intents.get(id)
    if (pending === undefined) return
    for (const property of properties) {
      const bySequence = pending.get(property)
      if (bySequence === undefined) continue
      bySequence.delete(sequence)
      if (bySequence.size === 0) pending.delete(property)
    }
    if (pending.size === 0) this.#intents.delete(id)
  }

  forget(id: string): void {
    this.#drafts.delete(id)
    this.#intents.delete(id)
  }

  ids(): ReadonlySet<string> {
    return new Set([...this.#drafts.keys(), ...this.#intents.keys()])
  }
}

export const overlayAppearanceState = new OverlayAppearanceState()
