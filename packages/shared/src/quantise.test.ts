import { describe, expect, it } from 'vitest'
import { PALETTE_RGB, PALETTE_SIZE, TRANSPARENT_INDEX, WPLACE_PALETTE } from './palette.js'
import { OPAQUE_ALPHA_THRESHOLD, quantiseToPalette } from './quantise.js'

const rgba = (...pixels: Array<readonly [number, number, number, number]>): Uint8Array =>
  new Uint8Array(pixels.flat())

const indexOfHex = (hex: string): number => {
  const found = WPLACE_PALETTE.find((colour) => colour.hex === hex)
  if (found === undefined) throw new Error(`${hex} is not in the palette`)
  return found.index
}

describe('the palette', () => {
  it('has 63 paintable colours with transparent at 63', () => {
    // The index is the contract — paint requests carry indices, not RGB — so the shape is pinned
    // absolutely rather than derived from the array's own length.
    expect(WPLACE_PALETTE).toHaveLength(63)
    expect(TRANSPARENT_INDEX).toBe(63)
    expect(PALETTE_SIZE).toBe(64)
  })

  it('places the free colours first and the premium ones after', () => {
    // wplace's own grouping. "Hide colours I cannot place" depends on this split being right.
    const kinds = WPLACE_PALETTE.map((colour) => colour.kind)
    expect(kinds.indexOf('premium')).toBe(31)
    expect(kinds.lastIndexOf('free')).toBe(30)
  })

  it('carries its own index at its own position', () => {
    for (const [position, colour] of WPLACE_PALETTE.entries()) expect(colour.index).toBe(position)
  })

  it('pins the anchors of wplace order', () => {
    // Black first and White fifth are the entries most likely to survive a relabelling, so they are
    // the cheapest guard against the list being reordered or resorted.
    expect(WPLACE_PALETTE[0]?.hex).toBe('#000000')
    expect(WPLACE_PALETTE[4]?.hex).toBe('#FFFFFF')
    expect(WPLACE_PALETTE[62]?.hex).toBe('#CDC59E')
  })

  it('puts the free/premium boundary exactly where wplace puts it', () => {
    // wplace's own accessor is `t < 32 ? free : bit (t - 32) of extraColorsBitmap`, over an array
    // whose index 0 is Transparent. Dropping Transparent to the end leaves 31 free then 32 premium,
    // so this boundary is what makes the ownership bit `1 << (index - 31)` land on the right colour.
    expect(WPLACE_PALETTE.filter((colour) => colour.kind === 'free')).toHaveLength(31)
    expect(WPLACE_PALETTE.filter((colour) => colour.kind === 'premium')).toHaveLength(32)
    expect(WPLACE_PALETTE[30]?.kind).toBe('free')
    expect(WPLACE_PALETTE[31]?.kind).toBe('premium')
    // Contiguous, or the bit arithmetic above is meaningless.
    expect(WPLACE_PALETTE.findIndex((colour) => colour.kind === 'premium')).toBe(31)
  })

  it('holds the ordering that the previous ditherette-derived table got wrong', () => {
    // That table had the right set of colours and the right split, but 31 of 63 at the wrong index
    // from position 18 onward — silent, because a self-consistent wrong table still round-trips.
    // These four are where it diverged first and worst.
    expect(WPLACE_PALETTE[17]?.hex).toBe('#28509E') // Dark Blue, which it had at 18
    expect(WPLACE_PALETTE[19]?.hex).toBe('#60F7F2') // Cyan, which it had at 17
    expect(WPLACE_PALETTE[35]?.hex).toBe('#D6B594') // Light Tan, which it had at 54
    expect(WPLACE_PALETTE[15]?.hex).toBe('#10AEA6') // Teal — it carried #10AE82, not a wplace colour
  })

  it('holds no duplicate colours', () => {
    expect(new Set(WPLACE_PALETTE.map((colour) => colour.hex)).size).toBe(WPLACE_PALETTE.length)
  })

  it.each(['#F6AA09', '#F9DD3B', '#60F7F2', '#E09FF9', '#CB007A'])(
    'holds %s rather than the noise-shifted value the old recon recovered',
    (hex) => {
      // Clustering a noisy .wplace file produced centroids 1-2 off these. A regression to those
      // values would quantise every pixel of that colour one step away and never match wplace.
      expect(WPLACE_PALETTE.some((colour) => colour.hex === hex)).toBe(true)
    },
  )

  it('does not contain the spurious cluster the old recon invented', () => {
    // #180006 sat 24 from black and is not a wplace colour at all.
    expect(WPLACE_PALETTE.some((colour) => colour.hex === '#180006')).toBe(false)
  })
})

describe('quantising', () => {
  it('leaves an exact palette colour where it is', () => {
    const { indices, report } = quantiseToPalette(rgba([0, 0, 0, 255], [255, 255, 255, 255]))

    expect([...indices]).toEqual([indexOfHex('#000000'), indexOfHex('#FFFFFF')])
    expect(report.movedPixels).toBe(0)
    expect(report.maxDistance).toBe(0)
  })

  it('moves a near-miss onto the colour it was meant to be', () => {
    // The ±2 artefact that killed the reject rule: #F8A90A is what clustering saw for #F6AA09.
    const { indices, report } = quantiseToPalette(rgba([0xf8, 0xa9, 0x0a, 255]))

    expect(indices[0]).toBe(indexOfHex('#F6AA09'))
    expect(report.movedPixels).toBe(1)
    expect(report.maxDistance).toBe(2)
  })

  it.each([
    ['at the threshold', OPAQUE_ALPHA_THRESHOLD, false],
    ['one below it', OPAQUE_ALPHA_THRESHOLD - 1, true],
  ])('treats alpha %s as transparent: %s', (_label, alpha, transparent) => {
    // Alpha is a threshold rather than part of the distance metric. Folding it in would match
    // opaque palette entries against translucent pixels.
    const { indices } = quantiseToPalette(rgba([0, 0, 0, alpha]))
    expect(indices[0] === TRANSPARENT_INDEX).toBe(transparent)
  })

  it('does not count transparent pixels as moved', () => {
    const { report } = quantiseToPalette(rgba([200, 30, 40, 0], [0, 0, 0, 255]))
    expect(report.opaquePixels).toBe(1)
  })

  it('reports a photograph as obviously wrong', () => {
    // The replacement for the reject rule is that the numbers make it evident. A gradient no
    // template would contain should move nearly everything, by a lot.
    const pixels = new Uint8Array(256 * 4)
    for (let index = 0; index < 256; index += 1) {
      pixels[index * 4] = index
      pixels[index * 4 + 1] = 255 - index
      pixels[index * 4 + 2] = (index * 7) % 256
      pixels[index * 4 + 3] = 255
    }

    const { report } = quantiseToPalette(pixels)

    expect(report.movedPixels / report.opaquePixels).toBeGreaterThan(0.9)
    expect(report.maxDistance).toBeGreaterThan(8)
  })

  it('memoises by distinct colour rather than by pixel', () => {
    // The whole affordability argument: one repeated colour must cost one scan, not one per pixel.
    const pixels = new Uint8Array(10_000 * 4)
    for (let index = 0; index < 10_000; index += 1) pixels[index * 4 + 3] = 255

    const { report } = quantiseToPalette(pixels)

    expect(report.opaquePixels).toBe(10_000)
    expect(report.distinctColours).toBe(1)
  })

  it('reports how many palette entries the result actually uses', () => {
    const { report } = quantiseToPalette(rgba([0, 0, 0, 255], [0, 0, 0, 255], [255, 255, 255, 255]))
    expect(report.distinctPaletteEntries).toBe(2)
  })

  it('reports zero mean distance for an empty image rather than NaN', () => {
    const { report } = quantiseToPalette(rgba([0, 0, 0, 0]))
    expect(report.meanDistance).toBe(0)
  })

  it('never emits an index outside the palette', () => {
    const pixels = new Uint8Array(1_000 * 4)
    for (let index = 0; index < 1_000; index += 1) {
      pixels[index * 4] = (index * 13) % 256
      pixels[index * 4 + 1] = (index * 29) % 256
      pixels[index * 4 + 2] = (index * 71) % 256
      pixels[index * 4 + 3] = 255
    }

    const { indices } = quantiseToPalette(pixels)

    for (const index of indices) expect(index).toBeLessThan(PALETTE_RGB.length)
  })
})
