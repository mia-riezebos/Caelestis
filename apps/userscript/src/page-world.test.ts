import { afterEach, describe, expect, it, vi } from 'vitest'
import { isPageInstance, isUint8Array } from './page-world.js'

const originalImageBitmap = Object.getOwnPropertyDescriptor(globalThis, 'ImageBitmap')

afterEach(() => {
  vi.unstubAllGlobals()
  delete (globalThis as Record<string, unknown>).TestBlob
  if (originalImageBitmap === undefined) delete (globalThis as Record<string, unknown>).ImageBitmap
  else Object.defineProperty(globalThis, 'ImageBitmap', originalImageBitmap)
})

describe('isPageInstance', () => {
  it('does not throw when the named page global is callable but invalid for instanceof', () => {
    Object.defineProperty(globalThis, 'ImageBitmap', {
      configurable: true,
      value: () => undefined,
    })

    expect(() => isPageInstance({}, 'ImageBitmap')).not.toThrow()
    expect(isPageInstance({}, 'ImageBitmap')).toBe(false)
  })

  it('does not accept an object from a different realm as a page instance', () => {
    class PageBlob {}
    class SandboxBlob {}
    const page = { TestBlob: PageBlob }
    ;(globalThis as Record<string, unknown>).TestBlob = SandboxBlob

    expect(isPageInstance(new PageBlob(), 'TestBlob', page)).toBe(true)
    expect(isPageInstance(new SandboxBlob(), 'TestBlob', page)).toBe(false)
    delete (globalThis as Record<string, unknown>).TestBlob
  })
})

describe('isUint8Array', () => {
  it('accepts a typed array created by a different global constructor', () => {
    const foreign = new Uint8Array([1])
    class SandboxUint8Array extends Uint8Array {}
    vi.stubGlobal('Uint8Array', SandboxUint8Array)

    expect(foreign).not.toBeInstanceOf(Uint8Array)
    expect(isUint8Array(foreign)).toBe(true)
    expect(isUint8Array(new Uint8ClampedArray([1]))).toBe(false)
  })
})
