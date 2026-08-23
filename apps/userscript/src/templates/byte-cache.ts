/** A FIFO cache bounded by both entry count and retained byte size. */
export class ByteCache<K> {
  readonly #entries = new Map<K, Uint8Array>()
  #bytes = 0

  constructor(
    readonly maxEntries: number,
    readonly maxBytes: number,
  ) {}

  get(key: K): Uint8Array | undefined {
    return this.#entries.get(key)
  }

  set(key: K, value: Uint8Array): void {
    const replaced = this.#entries.get(key)
    if (replaced !== undefined) {
      this.#bytes -= replaced.byteLength
      this.#entries.delete(key)
    }
    while (
      this.#entries.size > 0 &&
      (this.#entries.size >= this.maxEntries || this.#bytes + value.byteLength > this.maxBytes)
    ) {
      const oldest = this.#entries.keys().next()
      if (oldest.done) break
      this.delete(oldest.value)
    }
    if (value.byteLength > this.maxBytes || this.maxEntries <= 0) return
    this.#entries.set(key, value)
    this.#bytes += value.byteLength
  }

  delete(key: K): boolean {
    const value = this.#entries.get(key)
    if (value === undefined) return false
    this.#entries.delete(key)
    this.#bytes -= value.byteLength
    return true
  }
}
