import { WPLACE_PALETTE } from '@caelestis/shared'
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => vi.unstubAllGlobals())

/** Drive the installed page hooks through native canvas writes, uploads, and raster draws. */
const setup = async () => {
  vi.resetModules()
  const occupancy: number[] = []
  vi.doMock('./templates/drafted.js', () => ({ draftedPixelsIn: () => occupancy }))
  const reads = vi.fn()
  class Pixels {
    constructor(readonly canvas: Canvas) {}
    putImageData(
      image: ImageData,
      dx: number,
      dy: number,
      sx = 0,
      sy = 0,
      w = image.width,
      h = image.height,
    ) {
      for (let y = sy; y < sy + h; y++)
        for (let x = sx; x < sx + w; x++) {
          this.canvas.data.set(
            image.data.subarray((y * image.width + x) * 4, (y * image.width + x + 1) * 4),
            ((dy + y) * this.canvas.width + dx + x) * 4,
          )
        }
    }
    clearRect(x: number, y: number, w: number, h: number) {
      for (let row = y; row < y + h; row++)
        this.canvas.data.fill(
          0,
          (row * this.canvas.width + x) * 4,
          (row * this.canvas.width + x + w) * 4,
        )
    }
    drawImage(source: Canvas) {
      this.canvas.data.set(source.data)
    }
    getImageData(x: number, y: number, width: number, height: number): ImageData {
      reads(x, y, width, height)
      const data = new Uint8ClampedArray(width * height * 4)
      for (let row = 0; row < height; row++)
        data.set(
          this.canvas.data.subarray(
            ((y + row) * this.canvas.width + x) * 4,
            ((y + row) * this.canvas.width + x + width) * 4,
          ),
          row * width * 4,
        )
      return { data, width, height, colorSpace: 'srgb' }
    }
    getTransform() {
      return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
    }
    reset() {
      this.canvas.data.fill(0)
    }
  }
  class Canvas extends EventTarget {
    private backingWidth = 1_000
    get width() {
      return this.backingWidth
    }
    set width(value: number) {
      this.backingWidth = value
      this.data.fill(0)
    }
    height = 1_000
    data = new Uint8ClampedArray(4_000_000)
    context = new Pixels(this)
    classList = { contains: () => true }
    getContext(type: string) {
      return type === '2d' ? this.context : gl
    }
  }
  const gl = {
    TEXTURE0: 0x84c0,
    TEXTURE_2D: 0x0de1,
    FRAMEBUFFER: 0x8d40,
    DRAW_FRAMEBUFFER: 0x8ca9,
    MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8b4d,
    getParameter: vi.fn(() => 2),
    getUniformLocation: vi.fn(() => ({})),
    createProgram: () => ({}),
    createTexture: () => ({}),
    createFramebuffer: () => ({}),
    useProgram() {},
    deleteProgram() {},
    uniform1i() {},
    uniformMatrix4fv() {},
    activeTexture() {},
    bindTexture() {},
    deleteTexture() {},
    texImage2D() {},
    texSubImage2D() {},
    drawArrays() {},
    drawElements() {},
    bindFramebuffer() {},
    deleteFramebuffer() {},
    enable() {},
    disable() {},
    colorMask() {},
    clear() {},
  }
  vi.stubGlobal('OffscreenCanvas', Canvas)
  const realm = {
    Object,
    Request,
    URL,
    Response,
    fetch: vi.fn(async () => new Response('{}')),
    Blob,
    createImageBitmap: vi.fn(),
    HTMLCanvasElement: Canvas,
    OffscreenCanvas: Canvas,
    CanvasRenderingContext2D: Pixels,
    ArrayBuffer,
    Float32Array,
  } as unknown as Window & typeof globalThis
  const api = await import('./tile-transform.js')
  api.install(realm, () => null)
  const mapCanvas = new Canvas()
  mapCanvas.getContext('webgl2')
  const hooked = gl as unknown as WebGL2RenderingContext
  const program = hooked.createProgram()
  if (program === null) throw new Error('Expected a fake program')
  hooked.useProgram(program)
  hooked.uniform1i(hooked.getUniformLocation(program, 'u_image0'), 0)
  hooked.uniformMatrix4fv(
    hooked.getUniformLocation(program, 'u_projection_matrix'),
    false,
    new Float32Array(16),
  )
  hooked.bindTexture(hooked.TEXTURE_2D, hooked.createTexture())
  api.captureTilePixels(true)
  const source = new Canvas()
  const tile = { x: 8, y: 9 }
  api.registerDraftCanvas(source, tile)
  const draw = (canvas = source) => {
    hooked.texSubImage2D(hooked.TEXTURE_2D, 0, 0, 0, 0, 0, canvas as unknown as HTMLCanvasElement)
    hooked.drawArrays(0, 0, 4)
  }
  const pixel = (index: number): ImageData => ({
    width: 1,
    height: 1,
    colorSpace: 'srgb',
    data: new Uint8ClampedArray([...(WPLACE_PALETTE[index]?.rgb ?? []), 255]),
  })
  return { api, source, tile, draw, pixel, reads, Canvas, occupancy, realm }
}

it('does not reread an unchanged draft uploaded on every frame', async () => {
  const { api, source, tile, draw, pixel, reads } = await setup()
  source.context.putImageData(pixel(1), 2, 3)
  draw()
  expect(reads).toHaveBeenCalledTimes(1)
  reads.mockClear()
  for (let i = 0; i < 10; i++) draw()
  expect(reads).not.toHaveBeenCalled()
  source.context.putImageData(pixel(2), 2, 3)
  draw()
  expect(reads).not.toHaveBeenCalled()
  expect(api.draftPixels(tile)?.[996_002]).toBe(2)
})

it('recovers copied canvas writes and a replacement source on the same texture', async () => {
  const { api, source, tile, draw, pixel, reads, Canvas } = await setup()
  draw()
  const copy = new Canvas()
  copy.context.putImageData(pixel(2), 2, 3)
  source.context.drawImage(copy)
  draw()
  expect(api.draftPixels(tile)?.[996_002]).toBe(2)
  api.registerDraftCanvas(copy, tile)
  draw(copy)
  expect(reads).toHaveBeenCalledTimes(3)
  draw(copy)
  expect(reads).toHaveBeenCalledTimes(3)
})

it('retries a failed capture rather than stamping it clean', async () => {
  const { draw, reads } = await setup()
  reads.mockImplementationOnce(() => {
    throw new Error('temporary readback failure')
  })
  draw()
  draw()
  draw()
  expect(reads).toHaveBeenCalledTimes(2)
})

it('patches only the dirty portion of putImageData', async () => {
  const { api, source, tile, draw, pixel } = await setup()
  draw()
  const image = {
    ...pixel(2),
    width: 2,
    data: new Uint8ClampedArray([...pixel(1).data, ...pixel(2).data]),
  }
  source.context.putImageData(image, 2, 3, 1, 0, 1, 1)
  expect(api.draftPixels(tile)?.[996_002]).toBe(api.UNPAINTED)
  expect(api.draftPixels(tile)?.[996_003]).toBe(2)
})

it('captures a large dirty rectangle without decoding the full tile', async () => {
  const { source, draw, reads } = await setup()
  draw()
  reads.mockClear()
  source.context.putImageData(
    { width: 40, height: 2, colorSpace: 'srgb', data: new Uint8ClampedArray(320) },
    20,
    30,
  )
  draw()
  expect(reads).toHaveBeenCalledExactlyOnceWith(20, 30, 40, 2)
  draw()
  expect(reads).toHaveBeenCalledTimes(1)
})

it.each(['resize', 'reset'] as const)('recaptures a canvas cleared by %s', async (operation) => {
  const { api, source, tile, draw, pixel, reads } = await setup()
  source.context.putImageData(pixel(1), 2, 3)
  draw()
  if (operation === 'resize') source.width = 1_000
  else source.context.reset()
  draw()
  expect(api.draftPixels(tile)?.[996_002]).toBe(api.UNPAINTED)
  draw()
  expect(reads).toHaveBeenCalledTimes(2)
})

it('notifies once after native undo updates both colour and crosshair occupancy', async () => {
  const { api, source, tile, draw, pixel, occupancy } = await setup()
  source.context.putImageData(pixel(1), 2, 3)
  occupancy.push(996_002)
  draw()
  await Promise.resolve()
  const changed = vi.fn()
  api.onTilePixels(changed)
  source.context.clearRect(2, 3, 1, 1)
  occupancy.length = 0
  await Promise.resolve()
  expect(changed).toHaveBeenCalledExactlyOnceWith(tile, [2, 996, api.UNPAINTED], 'draft')
})

it('flushes a coalesced draft before taking the native submission snapshot', async () => {
  const { api, source, tile, pixel, realm } = await setup()
  const changed = vi.fn()
  api.onTilePixels(changed)
  source.context.putImageData(pixel(1), 2, 3)
  source.context.putImageData(pixel(2), 2, 3)
  expect(changed).not.toHaveBeenCalled()
  const submitted = vi.fn(() => {
    expect(changed).toHaveBeenCalledExactlyOnceWith(tile, [2, 996, 2], 'draft')
  })
  api.onPaintSubmission(submitted)
  await realm.fetch('https://backend.wplace.live/paint', { method: 'POST', body: '{}' })
  expect(submitted).toHaveBeenCalledOnce()
})
