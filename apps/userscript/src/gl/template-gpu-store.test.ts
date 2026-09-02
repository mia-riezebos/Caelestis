import { describe, expect, it, vi } from 'vitest'
import { TemplateGpuStore } from './template-gpu-store.js'

const context = (maximumTextureSize = 4) => {
  let nextTexture = 0
  return {
    TEXTURE_2D: 1,
    R8UI: 2,
    RED_INTEGER: 3,
    UNSIGNED_BYTE: 4,
    TEXTURE_MIN_FILTER: 5,
    TEXTURE_MAG_FILTER: 6,
    NEAREST: 7,
    TEXTURE_WRAP_S: 8,
    TEXTURE_WRAP_T: 9,
    CLAMP_TO_EDGE: 10,
    UNPACK_ALIGNMENT: 11,
    RGBA: 12,
    MAX_TEXTURE_SIZE: 13,
    getParameter: vi.fn(() => maximumTextureSize),
    createTexture: vi.fn(() => ({ id: nextTexture++ })),
    deleteTexture: vi.fn(),
    bindTexture: vi.fn(),
    pixelStorei: vi.fn(),
    texImage2D: vi.fn(),
    texSubImage2D: vi.fn(),
    texParameteri: vi.fn(),
  } as unknown as WebGL2RenderingContext
}

const template = (indices = new Uint8Array([1, 2, 3, 4, 5, 6])) => ({
  id: 'template',
  width: 3,
  height: 2,
  indices,
})

describe('template GPU store', () => {
  it('chunks with halos and advances uploads within the supplied allowance', () => {
    const gl = context()
    const store = new TemplateGpuStore(gl)
    const source = template()

    const first = store.advance(source, 5, 1)
    expect(first).toMatchObject({ status: 'pending', uploadedPixels: 5, entry: null })

    const second = store.advance(source, 100, 2)
    expect(second.status).toBe('complete')
    expect(second.uploadedPixels).toBe(23)
    expect(second.entry?.indices).toMatchObject([
      { x: 0, y: 0, width: 2, height: 2, textureWidth: 4, textureHeight: 4, inset: 1 },
      { x: 2, y: 0, width: 1, height: 2, textureWidth: 3, textureHeight: 4, inset: 1 },
    ])
    expect(store.memoryBytes()).toBe(256 + 16 + 12)
  })

  it('releases stale textures before uploading a replacement source', () => {
    const gl = context(16)
    const store = new TemplateGpuStore(gl)
    const original = template()
    expect(store.advance(original, 100, 1).status).toBe('complete')

    const replacement = template(new Uint8Array([6, 5, 4, 3, 2, 1]))
    expect(store.hasCurrent(replacement)).toBe(false)
    expect(store.advance(replacement, 100, 2).status).toBe('complete')

    expect(gl.deleteTexture).toHaveBeenCalledTimes(2)
    expect(store.hasCurrent(replacement)).toBe(true)
  })

  it('uploads unchanged palettes once and drops deleted cache entries', () => {
    const gl = context(16)
    const store = new TemplateGpuStore(gl)
    const uploaded = store.advance(template(), 100, 1)
    const entry = uploaded.entry
    expect(entry).not.toBeNull()
    if (entry === null) throw new Error('expected a complete GPU entry')
    const palette = new Uint8Array(256).fill(7)

    store.uploadPalette(entry, palette)
    store.uploadPalette(entry, palette)
    expect(gl.texImage2D).toHaveBeenCalledTimes(2)

    store.collect(new Set(), new Set())
    expect(store.entry('template')).toBeNull()
    expect(gl.deleteTexture).toHaveBeenCalledTimes(2)
  })
})
