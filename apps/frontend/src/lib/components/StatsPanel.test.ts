// @vitest-environment happy-dom
import { millis, seconds, type Template } from '@caelestis/shared'
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
  vi.useRealTimers()
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
    await vi.waitFor(() => expect(api.getHistory).toHaveBeenCalledTimes(8))

    expect(api.getHistory).toHaveBeenCalledWith(['older', 'newer'], 0, finishedAt + 1)
    expect(
      api.getHistory.mock.calls
        .map((call) => call[3]?.maxResolution)
        .filter((resolution) => resolution !== undefined),
    ).toEqual([900, 1_800, 3_600, 5_400, 10_800, 21_600, 43_200])
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
    await vi.waitFor(() => expect(api.getHistory).toHaveBeenCalledTimes(8))

    expect(api.getHistory).toHaveBeenCalledWith(['finished', 'live'], 0, NOW_SECONDS + 1)
  })

  it('advances and refreshes the history boundary while a template stays live', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW_SECONDS * 1_000)
    mounted = mount(StatsPanel, {
      target: document.body,
      props: {
        templates: [template('live', 0, null)],
        season: 1,
        progress: { completed: 1, mismatched: 0, unpainted: 1, known: 2, total: 2 },
      },
    })
    flushSync()
    await vi.advanceTimersByTimeAsync(0)
    expect(api.getHistory).toHaveBeenCalledTimes(8)

    await vi.advanceTimersByTimeAsync(15_000)
    flushSync()
    await vi.advanceTimersByTimeAsync(0)

    expect(api.getHistory).toHaveBeenCalledTimes(16)
    expect(api.getHistory).toHaveBeenLastCalledWith(['live'], 0, NOW_SECONDS + 16, {
      maxResolution: 43_200,
    })
  })

  it('formats partial-day coverage without exposing floating-point noise', async () => {
    api.getHistory.mockImplementation((_templateIds, _from, _to, options) =>
      Promise.resolve(
        options?.maxResolution === 43_200
          ? {
              resolution: 900,
              coverageStart: seconds(NOW_SECONDS - 10.5 * 3_600),
              buckets: [],
            }
          : { buckets: [] },
      ),
    )
    mounted = mount(StatsPanel, {
      target: document.body,
      props: {
        templates: [template('live', 0, null)],
        season: 1,
        progress: { completed: 0, mismatched: 0, unpainted: 1, known: 1, total: 1 },
      },
    })
    flushSync()

    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('over 10.5 h within the last day'),
    )
  })
})

describe('live counts', () => {
  it('refreshes contributions and the leaderboard while the panel is visible', async () => {
    vi.useFakeTimers()
    mounted = mount(StatsPanel, {
      target: document.body,
      props: {
        templates: [template('live', 0, null)],
        season: 1,
        progress: { completed: 0, mismatched: 0, unpainted: 1, known: 1, total: 1 },
      },
    })
    flushSync()
    await vi.advanceTimersByTimeAsync(0)

    expect(api.getContributions).toHaveBeenCalledTimes(1)
    expect(api.getLeaderboard).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(15_000)

    expect(api.getContributions).toHaveBeenCalledTimes(2)
    expect(api.getLeaderboard).toHaveBeenCalledTimes(2)
  })

  it('does not supersede a slow refresh with overlapping timer requests', async () => {
    vi.useFakeTimers()
    let resolveContributions: (value: { days: never[] }) => void = () => {}
    let resolveLeaderboard: (value: { entries: never[] }) => void = () => {}
    api.getContributions.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveContributions = resolve
      }),
    )
    api.getLeaderboard.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveLeaderboard = resolve
      }),
    )
    mounted = mount(StatsPanel, {
      target: document.body,
      props: {
        templates: [template('live', 0, null)],
        season: 1,
        progress: { completed: 0, mismatched: 0, unpainted: 1, known: 1, total: 1 },
      },
    })
    flushSync()
    await vi.advanceTimersByTimeAsync(30_000)

    expect(api.getContributions).toHaveBeenCalledTimes(1)
    expect(api.getLeaderboard).toHaveBeenCalledTimes(1)

    resolveContributions({ days: [] })
    resolveLeaderboard({ entries: [] })
    await vi.advanceTimersByTimeAsync(15_000)

    expect(api.getContributions).toHaveBeenCalledTimes(2)
    expect(api.getLeaderboard).toHaveBeenCalledTimes(2)
  })
})
