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
const object = (version = 'v2') => ({
  size: 6,
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
})

describe('persistent template GIFs', () => {
  it('leaves full history rendering for large accepted templates to the scheduled job', async () => {
    const large = {
      ...template,
      bbox: { minX: 0, minY: 0, maxX: 20000, maxY: 20000 },
      chunks: Array.from({ length: 400 }, (_, i) => ({
        tile: `${i % 20}/${Math.floor(i / 20)}`,
        hash: `chunk-${i}`,
      })),
    } as unknown as Template
    const { event, work } = setup(null)
    await ensureSocialImage(event, 0, large)
    await Promise.all(work)
    expect(renderTemplateHistory).not.toHaveBeenCalled()
  })
  it('stores a first GIF before returning', async () => {
    const { images, event, work } = setup(null)
    await ensureSocialImage(event, 0, template)
    expect(images.put).toHaveBeenNthCalledWith(
      1,
      'social/v2/0/art.gif',
      poster,
      expect.objectContaining({ onlyIf: { etagDoesNotMatch: '*' } }),
    )
    await Promise.all(work)
    expect(images.put).toHaveBeenCalledTimes(1)
  })

  it('returns a fresh stored GIF without decoding or fetching anything', async () => {
    const stored = object()
    const { images, event, work } = setup(stored)
    expect(await ensureSocialImage(event, 0, template)).toMatchObject({
      etag: stored.etag,
      metadata: stored.customMetadata,
    })
    expect(images.put).not.toHaveBeenCalled()
    expect(fetchBackend).not.toHaveBeenCalled()
    expect(renderTimelapse).not.toHaveBeenCalled()
    expect(work).toHaveLength(0)
  })

  it('keeps an old artwork GIF available until the daily job replaces it', async () => {
    const stored = { ...object('v1'), uploaded: new Date(0) }
    const { images, event, work } = setup(stored)
    expect(await ensureSocialImage(event, 0, template)).toMatchObject({
      etag: stored.etag,
      metadata: stored.customMetadata,
    })
    expect(images.put).not.toHaveBeenCalled()
    await Promise.all(work)
    expect(renderTemplateHistory).not.toHaveBeenCalled()
    expect(fetchBackend).not.toHaveBeenCalled()
  })

  it('does not overwrite a timelapse that wins the first-image race', async () => {
    const { images, event, work } = setup(null)
    const winner = { ...object(), etag: 'winner' }
    images.head.mockResolvedValueOnce(null).mockResolvedValue(winner)
    images.put.mockResolvedValueOnce(null)
    expect(await ensureSocialImage(event, 0, template)).toMatchObject({
      etag: winner.etag,
      metadata: winner.customMetadata,
    })
    await Promise.all(work)
    expect(images.put).toHaveBeenNthCalledWith(
      1,
      'social/v2/0/art.gif',
      poster,
      expect.objectContaining({ onlyIf: { etagDoesNotMatch: '*' } }),
    )
    expect(images.put).toHaveBeenCalledTimes(1)
  })
})
