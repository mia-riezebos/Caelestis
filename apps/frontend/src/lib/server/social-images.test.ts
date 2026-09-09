import type { Template } from '@caelestis/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { fetchBackend, renderTimelapse, renderTemplateHistory } = vi.hoisted(() => ({
  fetchBackend: vi.fn(),
  renderTimelapse: vi.fn(),
  renderTemplateHistory: vi.fn(),
}))
vi.mock('./backend.js', () => ({ fetchBackend }))
vi.mock('$lib/social-render.js', () => ({ renderTimelapse, renderTemplateHistory }))

import { ensureSocialImage } from './social-images.js'

const template = {
  id: 'art',
  version: 'v2',
  chunks: [{ tile: '0/0', hash: 'chunk' }],
} as unknown as Template
const poster = new TextEncoder().encode('GIF89a-poster')
const animation = new TextEncoder().encode('GIF89a-animation')
const object = (version = 'v2') => ({
  etag: 'old',
  uploaded: new Date(),
  customMetadata: { version },
})
const setup = (stored: ReturnType<typeof object> | null) => {
  const images = {
    head: vi.fn().mockResolvedValue(stored),
    put: vi.fn().mockResolvedValue(object()),
  }
  const work: Promise<unknown>[] = []
  const event = {
    url: new URL('https://test.example'),
    platform: {
      env: { SOCIAL_IMAGES: images },
      ctx: { waitUntil: (pending: Promise<unknown>) => work.push(pending) },
    },
  } as unknown as Parameters<typeof ensureSocialImage>[0]
  return { images, event, work }
}

beforeEach(() => {
  vi.clearAllMocks()
  fetchBackend.mockImplementation(async () => Response.json({ tiles: [] }))
  renderTimelapse.mockResolvedValue(poster)
  renderTemplateHistory.mockResolvedValue(animation)
})

describe('persistent template GIFs', () => {
  it('stores a first GIF before returning and then replaces it with rendered history', async () => {
    const { images, event, work } = setup(null)
    await ensureSocialImage(event, 0, template)
    expect(images.put).toHaveBeenNthCalledWith(
      1,
      'social/v2/0/art.gif',
      poster,
      expect.objectContaining({ onlyIf: { etagDoesNotMatch: '*' } }),
    )
    await Promise.all(work)
    expect(images.put).toHaveBeenLastCalledWith(
      'social/v2/0/art.gif',
      animation,
      expect.objectContaining({ onlyIf: { etagMatches: 'old' } }),
    )
  })

  it('returns a fresh stored GIF without decoding or fetching anything', async () => {
    const stored = object()
    const { images, event, work } = setup(stored)
    expect(await ensureSocialImage(event, 0, template)).toBe(stored)
    expect(images.put).not.toHaveBeenCalled()
    expect(fetchBackend).not.toHaveBeenCalled()
    expect(renderTimelapse).not.toHaveBeenCalled()
    expect(work).toHaveLength(0)
  })

  it('keeps the previous artwork version available while its replacement renders', async () => {
    let finish!: (bytes: Uint8Array) => void
    renderTemplateHistory.mockReturnValue(
      new Promise<Uint8Array>((resolve) => {
        finish = resolve
      }),
    )
    const stored = object('v1')
    const { images, event, work } = setup(stored)
    expect(await ensureSocialImage(event, 0, template)).toBe(stored)
    expect(images.put).not.toHaveBeenCalled()
    finish(animation)
    await Promise.all(work)
    expect(images.put).toHaveBeenCalledWith(
      'social/v2/0/art.gif',
      animation,
      expect.objectContaining({ onlyIf: { etagMatches: 'old' } }),
    )
  })

  it('retains the old GIF if the daily refresh fails', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const stored = { ...object(), uploaded: new Date(0) }
    const { images, event, work } = setup(stored)
    renderTemplateHistory.mockRejectedValue(new Error('archive unavailable'))
    expect(await ensureSocialImage(event, 0, template)).toBe(stored)
    await Promise.all(work)
    expect(images.put).not.toHaveBeenCalled()
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining('keeping the previous GIF'),
      expect.any(Error),
    )
    logged.mockRestore()
  })

  it('does not overwrite a timelapse that wins the first-image race', async () => {
    const { images, event, work } = setup(null)
    const winner = { ...object(), etag: 'winner' }
    images.head.mockResolvedValueOnce(null).mockResolvedValue(winner)
    images.put.mockResolvedValueOnce(null)
    expect(await ensureSocialImage(event, 0, template)).toBe(winner)
    await Promise.all(work)
    expect(images.put).toHaveBeenNthCalledWith(
      1,
      'social/v2/0/art.gif',
      poster,
      expect.objectContaining({ onlyIf: { etagDoesNotMatch: '*' } }),
    )
    expect(images.put).toHaveBeenLastCalledWith(
      'social/v2/0/art.gif',
      animation,
      expect.objectContaining({ onlyIf: { etagMatches: 'winner' } }),
    )
  })
})
