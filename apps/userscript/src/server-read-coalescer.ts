/**
 * Share one in-flight server read across every consumer in the same connection lifetime.
 *
 * The owner is deliberately opaque. State supplies an identity that survives immutable row
 * replacements but changes when a server is removed, reconnected, or given new credentials. That
 * keeps credentials out of string keys while preventing a new connection from joining an old read.
 */
const reads = new WeakMap<object, Map<string, Promise<unknown>>>()

export const coalesceServerRead = <T>(
  owner: object,
  /** Season, surface/scope, and resource belong in this bounded non-secret key. */
  key: string,
  read: () => Promise<T>,
): Promise<T> => {
  let owned = reads.get(owner)
  if (owned === undefined) {
    owned = new Map()
    reads.set(owner, owned)
  }
  const pending = owned.get(key) as Promise<T> | undefined
  if (pending !== undefined) return pending
  const started = read().finally(() => {
    if (owned?.get(key) === started) owned.delete(key)
  })
  owned.set(key, started)
  return started
}
