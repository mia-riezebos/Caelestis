import { encodeIndexedPng, PALETTE_RGB } from '@caelestis/shared'
import sharp from 'sharp'
import { expect, it } from 'vitest'
import { encodeTimelapseGif } from '../lib/social-gif.js'
import { renderTimelapse, sampleTimeline } from '../lib/social-render.js'
import { template } from './fixtures.js'

it('encodes view-backed frames with visible changes and a fifteen-second playback', async () => {
  const backing = new Uint8Array(24).fill(99)
  const red = backing.subarray(4, 12)
  red.set([255, 0, 0, 255, 255, 0, 0, 255])
  const blue = new Uint8Array([0, 0, 255, 255, 255, 0, 0, 255])
  const gif = await encodeTimelapseGif([red, red, blue, blue], 2, 1)
  const metadata = await sharp(gif, { animated: true }).metadata()
  expect(metadata.width).toBe(2)
  expect(metadata.pageHeight).toBe(1)
  expect(metadata.delay?.reduce((sum, delay) => sum + delay, 0)).toBe(15000)
  const { data, info } = await sharp(gif, { animated: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  expect([...data.subarray(0, 8)]).toEqual([...red])
  expect([...data.subarray((info.height - 1) * 8, info.height * 8)]).toEqual([...blue])
})

it('renders saved PNG history and holds live pixels unless the template is finished', async () => {
  const png = await encodeIndexedPng(1000, 1000, new Uint8Array(1000000).fill(1))
  const live = await encodeIndexedPng(1000, 1000, new Uint8Array(1000000).fill(2))
  const reads: string[] = []
  const readTile = async (hash: string) => {
    reads.push(hash)
    if (hash === 'history') return png
    if (hash === 'live') return live
    throw new Error(`Unexpected tile ${hash}`)
  }
  const options = {
    template: template({ bbox: { minX: 499, minY: 499, maxX: 501, maxY: 501 } }),
    histories: new Map([['0/0', [{ bucketStart: 1, hash: 'history' }]]]),
    canvas: new Map([['0/0', 'live']]),
    readTile,
    width: 2,
    height: 2,
  }
  for (const finished of [false, true]) {
    reads.length = 0
    const gif = await renderTimelapse({ ...options, template: { ...options.template, finished } })
    expect(gif).not.toBeNull()
    if (gif === null) throw new Error('Expected a rendered observation')
    const pixels = await sharp(gif, { animated: true }).ensureAlpha().raw().toBuffer()
    expect([...pixels.subarray(-4, -1)]).toEqual(PALETTE_RGB[finished ? 1 : 2])
    expect(reads).toEqual(finished ? ['history'] : ['history', 'live'])
  }
  expect(await renderTimelapse({ ...options, histories: new Map(), canvas: new Map() })).toBeNull()
})

it('samples unique observations while retaining both timeline endpoints', () => {
  expect(sampleTimeline([9, 1, 5, 1], 2)).toEqual([1, 9])
  expect(sampleTimeline([9, 1, 5, 1], 3)).toEqual([1, 5, 9])
})
