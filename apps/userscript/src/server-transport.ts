import { discardResponseBody } from './response.js'

const REMOTE_TIMEOUT_MS = 10_000
const LARGE_TRANSFER_TIMEOUT_MS = 120_000
const SERVER_JSON_BYTES = 16 * 1024
const TREE_JSON_BYTES = 64 * 1024 * 1024
const MUTATION_JSON_BYTES = 64 * 1024
const MANIFEST_READ_CONCURRENCY = 4

interface ManifestReadWaiter {
  readonly grant: () => void
  readonly cancel: () => void
}

let activeManifestReads = 0
let manifestSequence = 0
const manifestReadWaiters: ManifestReadWaiter[] = []

const acquireManifestRead = (signal?: AbortSignal): true | Promise<boolean> => {
  if (signal?.aborted) return Promise.resolve(false)
  if (activeManifestReads < MANIFEST_READ_CONCURRENCY) {
    activeManifestReads++
    return true
  }
  return new Promise<boolean>((resolve) => {
    const waiter: ManifestReadWaiter = {
      grant: () => {
        signal?.removeEventListener('abort', waiter.cancel)
        resolve(true)
      },
      cancel: () => {
        const index = manifestReadWaiters.indexOf(waiter)
        if (index !== -1) manifestReadWaiters.splice(index, 1)
        resolve(false)
      },
    }
    signal?.addEventListener('abort', waiter.cancel, { once: true })
    manifestReadWaiters.push(waiter)
  })
}

const releaseManifestRead = (): void => {
  const next = manifestReadWaiters.shift()
  if (next === undefined) activeManifestReads--
  else next.grant()
}

const readBoundedJson = async (response: Response, maxBytes: number): Promise<unknown> => {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discardResponseBody(response)
    throw new RangeError(`response exceeds ${maxBytes} bytes`)
  }
  if (response.body === null) return null
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let body = ''
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > maxBytes) {
        await reader.cancel()
        throw new RangeError(`response exceeds ${maxBytes} bytes`)
      }
      body += decoder.decode(part.value, { stream: true })
    }
    body += decoder.decode()
  } finally {
    reader.releaseLock()
  }
  try {
    return body === '' ? null : JSON.parse(body)
  } catch {
    return null
  }
}

const request = async <Result>(
  input: string,
  init: RequestInit,
  timeoutMs: number,
  read: (response: Response) => Promise<Result>,
): Promise<Result> => {
  const controller = new AbortController()
  const upstream = init.signal
  const abortFromUpstream = (): void => controller.abort(upstream?.reason)
  if (upstream?.aborted) abortFromUpstream()
  else upstream?.addEventListener('abort', abortFromUpstream, { once: true })
  const timeout = setTimeout(() => controller.abort(new Error('request timed out')), timeoutMs)
  try {
    return await read(await fetch(input, { ...init, signal: controller.signal }))
  } finally {
    clearTimeout(timeout)
    upstream?.removeEventListener('abort', abortFromUpstream)
  }
}

const requestJson = async (
  input: string,
  init: RequestInit,
  maxBytes: number,
  timeoutMs: number,
): Promise<{ response: Response; body: unknown }> =>
  request(input, init, timeoutMs, async (response) => ({
    response,
    body: await readBoundedJson(response, maxBytes),
  }))

export const requestServerMetadata = (
  input: string,
  init: RequestInit = {},
): Promise<{ response: Response; body: unknown }> =>
  requestJson(input, init, SERVER_JSON_BYTES, REMOTE_TIMEOUT_MS)

export const requestServerMutation = (
  input: string,
  init: RequestInit = {},
): Promise<{ response: Response; body: unknown }> =>
  requestJson(input, init, MUTATION_JSON_BYTES, REMOTE_TIMEOUT_MS)

export const requestServerTree = (
  input: string,
  init: RequestInit = {},
): Promise<{ response: Response; body: unknown }> =>
  requestJson(input, init, TREE_JSON_BYTES, LARGE_TRANSFER_TIMEOUT_MS)

export const requestServerUpload = (
  input: string,
  init: RequestInit = {},
): Promise<{ response: Response; body: unknown }> =>
  requestJson(input, init, MUTATION_JSON_BYTES, LARGE_TRANSFER_TIMEOUT_MS)

export const requestServerManifest = async (
  input: string,
  init: RequestInit = {},
  canStart?: () => boolean,
): Promise<{ response: Response; body: unknown; sequence: number }> => {
  const signal = init.signal ?? undefined
  const admission = acquireManifestRead(signal)
  if (admission !== true && !(await admission)) throw new Error('manifest read cancelled')
  try {
    // Admission may wait behind four slow servers. The caller's connection and credentials can be
    // replaced during that wait, so validate their lifetime again before sending captured headers.
    if (canStart?.() === false) throw new Error('manifest read superseded before it started')
    const sequence = ++manifestSequence
    return { ...(await requestServerTree(input, init)), sequence }
  } finally {
    releaseManifestRead()
  }
}

export const serverManifestSequence = (): number => manifestSequence

export const requestServerStatus = async (
  input: string,
  init: RequestInit = {},
): Promise<Response> =>
  request(input, init, LARGE_TRANSFER_TIMEOUT_MS, async (response) => {
    await discardResponseBody(response)
    return response
  })
