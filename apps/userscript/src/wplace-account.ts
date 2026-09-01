import { type PainterIdentity, TRANSPARENT_INDEX, WPLACE_PALETTE } from '@caelestis/shared'
import { log, warn } from './debug.js'
import { discardResponseBody } from './response.js'

/**
 * What wplace knows about the signed-in user.
 *
 * `/me` returns `extraColorsBitmap`, a mask over the *premium* colours in palette order — bit 0 is
 * the first premium entry, not palette index 0. Free colours are not in the mask because everyone
 * has them.
 *
 * This is what makes the "Owned" colour preset mean anything. Without it the preset can only guess,
 * which is worse than not offering it.
 */

let owned: ReadonlySet<number> | null = null
let identity: PainterIdentity | null = null
let identityUnavailable = false
let lastAttemptAt: number | null = null
let loading: Promise<void> | null = null
const ACCOUNT_TIMEOUT_MS = 10_000
const ACCOUNT_JSON_BYTES = 16 * 1024

const readBoundedJson = async (response: Response): Promise<unknown> => {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > ACCOUNT_JSON_BYTES) {
    await discardResponseBody(response)
    throw new RangeError(`response exceeds ${ACCOUNT_JSON_BYTES} bytes`)
  }
  if (response.body === null) return null
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > ACCOUNT_JSON_BYTES) {
        await reader.cancel()
        throw new RangeError(`response exceeds ${ACCOUNT_JSON_BYTES} bytes`)
      }
      text += decoder.decode(part.value, { stream: true })
    }
    text += decoder.decode()
  } finally {
    reader.releaseLock()
  }
  return text === '' ? null : JSON.parse(text)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const premiumIndices = (): readonly number[] =>
  WPLACE_PALETTE.filter(
    (colour) => colour.kind === 'premium' && colour.index !== TRANSPARENT_INDEX,
  ).map((colour) => colour.index)

/** Re-read `/me` when colour settings are shown, while respecting the shared negative cache. */
export const refreshAccount = (rerender?: () => void): void => {
  const before = owned
  void loadAccount(30_000).then(() => {
    if (owned === before || rerender === undefined) return
    try {
      rerender()
    } catch (error) {
      warn('install', 'account refresh callback failed', String(error))
    }
  })
}

/** Palette indices this account can place, or null when we have not been able to ask. */
export const ownedColours = (): ReadonlySet<number> | null => owned

/** Public wplace identity used only for opted-in template-area telemetry. */
export const accountIdentity = (): PainterIdentity | null => identity

/** Whether Wplace definitively rejected or omitted the identity, rather than a request failing. */
export const accountIdentityKnownUnavailable = (): boolean => identityUnavailable

const replaceOwned = (next: ReadonlySet<number> | null): void => {
  if (owned === next || (owned === null && next === null)) return
  owned = next
}

const replaceIdentity = (next: PainterIdentity | null): void => {
  identity = next
  identityUnavailable = next === null
}

const fetchAccount = async (): Promise<void> => {
  identityUnavailable = false
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(new Error('request timed out')),
    ACCOUNT_TIMEOUT_MS,
  )
  try {
    const response = await fetch('https://backend.wplace.live/me', {
      credentials: 'include',
      signal: controller.signal,
    })
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        replaceOwned(null)
        replaceIdentity(null)
      }
      log('install', `/me said ${response.status}; owned colours unavailable`)
      return
    }
    const body = await readBoundedJson(response)
    if (!isRecord(body)) {
      replaceOwned(null)
      replaceIdentity(null)
      return
    }
    const id = body.id
    const name = body.name
    replaceIdentity(
      Number.isSafeInteger(id) &&
        Number(id) >= 0 &&
        typeof name === 'string' &&
        name.length > 0 &&
        name.length <= 256
        ? { wplaceUserId: Number(id), displayName: name }
        : null,
    )
    const mask = body.extraColorsBitmap
    if (
      typeof mask !== 'number' ||
      !Number.isSafeInteger(mask) ||
      (mask !== -1 && (mask < 0 || mask > 0xffff_ffff))
    ) {
      replaceOwned(null)
      return
    }

    const set = new Set<number>()
    // -1 is all bits set, which is how wplace says "everything".
    premiumIndices().forEach((paletteIndex, bit) => {
      if (mask === -1 || (mask & (1 << bit)) !== 0) set.add(paletteIndex)
    })
    replaceOwned(set)
    log('install', 'owned colours read from /me', { premium: set.size, mask })
  } catch (error) {
    // Signed out, offline, or blocked. The preset simply stays unavailable.
    warn('install', 'could not read /me', String(error))
  } finally {
    clearTimeout(timeout)
    lastAttemptAt = Date.now()
  }
}

export const loadAccount = async (maxAgeMs = 60_000): Promise<void> => {
  if (lastAttemptAt !== null && Date.now() - lastAttemptAt < maxAgeMs) return
  if (loading !== null) return loading
  loading = fetchAccount().finally(() => {
    loading = null
  })
  return loading
}
