// @vitest-environment happy-dom
import { millis, type Template } from '@caelestis/shared'
import { flushSync, mount, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  getContributions: vi.fn(),
  getHistory: vi.fn(),
  getLeaderboard: vi.fn(),
}))

vi.mock('$lib/api/client', () => api)

import StatsPanel from './StatsPanel.svelte'

const DAY_SECONDS = 86_400
const NOW_SECONDS = 40 * DAY_SECONDS

const template = (id: string, createdAt: number, finishedAt: number | null): Template => ({
  id,
  nodeId: null,
  name: id,
  version: 'version',
  bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
  totalPixels: 1,
  chunks: [],
  published: true,
  finished: finishedAt !== null,
  finishedAt: finishedAt === null ? null : millis(finishedAt * 1_000),
  timelapseFrozen: false,
  createdAt: millis(createdAt * 1_000),
  updatedAt: millis(createdAt * 1_000),
})

let mounted: ReturnType<typeof mount> | null = null

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW_SECONDS * 1_000)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(640)
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: vi.fn(),
    removeItem: vi.fn(),
  })
  api.getHistory.mockReset().mockResolvedValue({ buckets: [] })
  api.getContributions.mockReset().mockResolvedValue({ days: [] })
  api.getLeaderboard.mockReset().mockResolvedValue({ entries: [] })
})

afterEach(async () => {
  if (mounted !== null) await unmount(mounted)
  mounted = null
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('retained history range', () => {
  it('requests an all-history range through a finished scope boundary', async () => {
    const finishedAt = NOW_SECONDS - DAY_SECONDS
    mounted = mount(StatsPanel, {
      target: document.body,
      props: {
        templates: [
          template('older', 1_000, finishedAt - 1_000),
          template('newer', 10 * DAY_SECONDS, finishedAt),
        ],
        season: 1,
        progress: { completed: 2, mismatched: 0, unpainted: 0, known: 2, total: 2 },
      },
    })
    flushSync()
    await vi.waitFor(() => expect(api.getHistory).toHaveBeenCalledTimes(2))

    expect(api.getHistory).toHaveBeenCalledWith(['older', 'newer'], 0, finishedAt + 1)
    expect(document.body.textContent).not.toContain('last 7 days')
  })

  it('ends at the current boundary when any included template is live', async () => {
    mounted = mount(StatsPanel, {
      target: document.body,
      props: {
        templates: [
          template('finished', 0, NOW_SECONDS - DAY_SECONDS),
          template('live', DAY_SECONDS, null),
        ],
        season: 1,
        progress: { completed: 1, mismatched: 0, unpainted: 1, known: 2, total: 2 },
      },
    })
    flushSync()
    await vi.waitFor(() => expect(api.getHistory).toHaveBeenCalledTimes(2))

    expect(api.getHistory).toHaveBeenCalledWith(['finished', 'live'], 0, NOW_SECONDS + 1)
  })
})
