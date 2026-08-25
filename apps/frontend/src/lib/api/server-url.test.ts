import { describe, expect, it } from 'vitest'
import { resolveServerUrl } from './server-url.js'

describe('resolveServerUrl', () => {
  it('mounts the colocated production backend at /backend', () => {
    expect(resolveServerUrl(undefined, false, 'https://caelestis.mia.cx')).toBe(
      'https://caelestis.mia.cx/backend',
    )
  })

  it('mounts the local backend at /backend', () => {
    expect(resolveServerUrl(undefined, true, 'http://localhost:5173')).toBe(
      'http://127.0.0.1:8787/backend',
    )
  })

  it('keeps an explicitly configured full base URL', () => {
    expect(resolveServerUrl('https://example.com/custom/', false, 'https://ignored.example')).toBe(
      'https://example.com/custom',
    )
  })
})
