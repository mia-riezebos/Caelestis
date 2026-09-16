import 'fake-indexeddb/auto'
import { Blob, File } from 'node:buffer'
import { afterEach, beforeEach, vi } from 'vitest'

// IndexedDB's Node implementation needs clonable Blob values. Keep the entire HTTP family in
// the same realm so FormData stores those blobs as files instead of stringifying them.
Object.assign(globalThis, { Blob, File })
Object.assign(window, { Blob, File })
const { FormData, Request, Response } = await import('undici')
Object.assign(globalThis, { FormData, Request, Response })
Object.assign(window, { FormData, Request, Response })

const blockedNetwork = async (input: RequestInfo | URL) => {
  const url = new URL(typeof input === 'string' ? input : input.toString())
  // Startup account discovery is a page boundary, not a real-network test dependency.
  if (url.origin === 'https://backend.wplace.live' && url.pathname === '/me')
    return Response.json({})
  throw new Error(`unexpected network request in userscript test: ${url}`)
}

beforeEach(() => {
  vi.stubGlobal('fetch', blockedNetwork)
  Object.assign(window, { fetch: blockedNetwork })
})

afterEach(() => localStorage.clear())
