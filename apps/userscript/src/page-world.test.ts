import { afterEach, describe, expect, it } from 'vitest'
import { isPageInstance } from './page-world.js'

const originalImageBitmap = Object.getOwnPropertyDescriptor(globalThis, 'ImageBitmap')

afterEach(() => {
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
