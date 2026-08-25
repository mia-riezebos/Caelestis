import { describe, expect, it } from 'vitest'
import { resolveServerUrl } from './server-url.js'

describe('resolveServerUrl', () => {
  it('mounts the colocated production backend at /backend', () => {
    expect(resolveServerUrl(undefined, null, false, 'https://caelestis.mia.cx')).toBe(
      'https://caelestis.mia.cx/backend',
    )
  })

  it('mounts the local backend at /backend', () => {
    expect(resolveServerUrl(undefined, null, true, 'http://localhost:5173')).toBe(
      'http://127.0.0.1:8787/backend',
    )
  })

  it('uses a stored server when no server is configured', () => {
    expect(
      resolveServerUrl(undefined, 'https://chosen.example/', false, 'https://ignored.example'),
    ).toBe('https://chosen.example/backend')
  })

  it('does not append /backend twice', () => {
    expect(
      resolveServerUrl(
        undefined,
        'https://chosen.example/backend/',
        false,
        'https://ignored.example',
      ),
    ).toBe('https://chosen.example/backend')
  })

  it('does not let a stored server override an explicitly configured server', () => {
    expect(
      resolveServerUrl(
        'https://fixed.example/backend/',
        'https://chosen.example/backend',
        false,
        'https://ignored.example',
      ),
    ).toBe('https://fixed.example/backend')
  })
})
