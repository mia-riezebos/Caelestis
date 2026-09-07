// @vitest-environment happy-dom
import { millis, seconds, type Template } from '@caelestis/shared'
import { flushSync, mount, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  getContributions: vi.fn(),
  getHistory: vi.fn(),
  getLeaderboard: vi.fn(),
}))
const live = vi.hoisted(() => ({ subscribe: vi.fn() }))

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
  // Exercise history timers without advancing chart animation frames alongside them.
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList)
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: vi.fn(),
    removeItem: vi.fn(),
  })
  api.getHistory.mockReset().mockResolvedValue({ buckets: [] })
  api.getContributions.mockReset().mockResolvedValue({ days: [] })
  api.getLeaderboard.mockReset().mockResolvedValue({ entries: [] })
  live.subscribe.mockReset().mockReturnValue(() => undefined)
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
        season: 0,
        liveDashboard: true,
        templates: [
          template('older', 1_000, finishedAt - 1_000),
          template('newer', 10 * DAY_SECONDS, finishedAt),
        ],
        subscribeDashboard: live.subscribe,
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
        season: 0,
        liveDashboard: true,
        templates: [
          template('finished', 0, NOW_SECONDS - DAY_SECONDS),
          template('live', DAY_SECONDS, null),
        ],
        subscribeDashboard: live.subscribe,
        progress: { completed: 1, mismatched: 0, unpainted: 1, known: 2, total: 2 },
      },
    })
    flushSync()
    await vi.waitFor(() => expect(api.getHistory).toHaveBeenCalledTimes(8))

    expect(api.getHistory).toHaveBeenCalledWith(['finished', 'live'], 0, NOW_SECONDS + 1)
  })

  it.each([false, true])(
    'advances the live history boundary with liveDashboard=%s',
    async (liveDashboard) => {
      vi.useFakeTimers()
      vi.setSystemTime(NOW_SECONDS * 1_000)
      api.getHistory.mockResolvedValue({
        buckets: [
          {
            templateId: 'live',
            resolution: 900,
            bucketStart: seconds(NOW_SECONDS - 900),
            placed: 1,
            correct: 1,
            repairs: 0,
          },
        ],
      })
      mounted = mount(StatsPanel, {
        target: document.body,
        props: {
          templates: [template('live', 0, null)],
          season: 1,
          liveDashboard,
          subscribeDashboard: live.subscribe,
          progress: { completed: 1, mismatched: 0, unpainted: 1, known: 2, total: 2 },
        },
      })
      flushSync()
      await vi.advanceTimersByTimeAsync(0)
      expect(api.getHistory).toHaveBeenCalledTimes(8)
      const preset = document.querySelector<HTMLButtonElement>('[data-range-preset="6h"]')
      preset?.click()
      flushSync()
      expect(preset?.getAttribute('aria-pressed')).toBe('true')

      await vi.advanceTimersByTimeAsync(15_000)
      flushSync()
      await vi.advanceTimersByTimeAsync(0)

      expect(api.getHistory).toHaveBeenCalledTimes(16)
      expect(api.getHistory).toHaveBeenLastCalledWith(['live'], 0, NOW_SECONDS + 16, {
        maxResolution: 43_200,
      })
      expect(preset?.getAttribute('aria-pressed')).toBe('true')
      expect(document.querySelector('[data-handle="head"]')?.getAttribute('aria-valuenow')).toBe(
        String(NOW_SECONDS + 16 - 6 * 3_600),
      )
      expect(document.querySelector('[data-handle="tail"]')?.getAttribute('aria-valuenow')).toBe(
        String(NOW_SECONDS + 16),
      )
      expect(document.querySelector('[class*="animate-ping"]')).not.toBeNull()
    },
  )

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
        season: 0,
        liveDashboard: true,
        templates: [template('live', 0, null)],
        subscribeDashboard: live.subscribe,
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
  it('applies contributions and leaderboard snapshots from one live subscription', async () => {
    mounted = mount(StatsPanel, {
      target: document.body,
      props: {
        season: 0,
        liveDashboard: true,
        templates: [template('live', 0, null)],
        subscribeDashboard: live.subscribe,
        progress: { completed: 0, mismatched: 0, unpainted: 1, known: 1, total: 1 },
      },
    })
    flushSync()
    expect(live.subscribe).toHaveBeenCalledOnce()
    const listener = live.subscribe.mock.calls[0]?.[2]
    listener?.({
      contributions: { days: [] },
      leaderboard: { entries: [] },
    })
    await vi.waitFor(() => expect(document.body.textContent).toContain('No contributions yet'))
    expect(api.getContributions).not.toHaveBeenCalled()
    expect(api.getLeaderboard).not.toHaveBeenCalled()
  })

  it('does not add a polling fallback while the subscription stays quiet', async () => {
    vi.useFakeTimers()
    mounted = mount(StatsPanel, {
      target: document.body,
      props: {
        season: 0,
        liveDashboard: true,
        templates: [template('live', 0, null)],
        subscribeDashboard: live.subscribe,
        progress: { completed: 0, mismatched: 0, unpainted: 1, known: 1, total: 1 },
      },
    })
    flushSync()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(live.subscribe).toHaveBeenCalledOnce()
    expect(api.getContributions).not.toHaveBeenCalled()
    expect(api.getLeaderboard).not.toHaveBeenCalled()
  })

  it('keeps compatibility reads for a server without live v2', async () => {
    vi.useFakeTimers()
    mounted = mount(StatsPanel, {
      target: document.body,
      props: {
        season: 7,
        liveDashboard: false,
        templates: [template('live', 0, null)],
        subscribeDashboard: live.subscribe,
        progress: { completed: 0, mismatched: 0, unpainted: 1, known: 1, total: 1 },
      },
    })
    flushSync()
    await vi.advanceTimersByTimeAsync(0)

    expect(live.subscribe).not.toHaveBeenCalled()
    expect(api.getContributions).toHaveBeenCalledOnce()
    expect(api.getLeaderboard).toHaveBeenCalledWith(7, { templateIds: ['live'] })

    await vi.advanceTimersByTimeAsync(15_000)
    expect(api.getContributions).toHaveBeenCalledTimes(2)
    expect(api.getLeaderboard).toHaveBeenCalledTimes(2)
  })
})

describe('painter pace', () => {
  it('draws the served painters and marks history before the fetched coverage unavailable', async () => {
    // Sixteen weeks of coverage end today; a scope created on day zero predates them.
    const now = 200 * DAY_SECONDS
    vi.spyOn(Date, 'now').mockReturnValue(now * 1_000)
    mounted = mount(StatsPanel, {
      target: document.body,
      props: {
        season: 0,
        liveDashboard: true,
        templates: [template('old', 1_000, null)],
        subscribeDashboard: live.subscribe,
        progress: { completed: 0, mismatched: 0, unpainted: 1, known: 1, total: 1 },
      },
    })
    flushSync()
    expect(document.querySelector('[data-painter-pace] svg')).toBeNull()
    const listener = live.subscribe.mock.calls[0]?.[2]
    const contributionsFrom = live.subscribe.mock.calls[0]?.[1]
    listener?.({
      contributions: {
        days: [
          {
            wplaceUserId: 5,
            displayName: 'Ada',
            templateId: 'old',
            day: seconds(now - DAY_SECONDS),
            placed: 3,
            correct: 3,
            repairs: 0,
          },
        ],
      },
      leaderboard: { entries: [] },
    })
    await vi.waitFor(() =>
      expect(
        document.querySelector('[data-painter-pace] path[data-painter-line="5"]'),
      ).not.toBeNull(),
    )
    expect(document.querySelectorAll('[data-painter-pace] [data-painter-toggle]')).toHaveLength(1)
    expect(
      document
        .querySelector('[data-painter-pace] [data-unavailable-before]')
        ?.getAttribute('data-unavailable-before'),
    ).toBe(String(Math.floor(contributionsFrom / DAY_SECONDS) * DAY_SECONDS))
  })

  it('says so when the first contribution read fails', async () => {
    vi.useFakeTimers()
    api.getContributions.mockRejectedValue(new Error('offline'))
    mounted = mount(StatsPanel, {
      target: document.body,
      props: {
        season: 0,
        liveDashboard: false,
        templates: [template('live', 0, null)],
        subscribeDashboard: live.subscribe,
        progress: { completed: 0, mismatched: 0, unpainted: 1, known: 1, total: 1 },
      },
    })
    flushSync()
    await vi.advanceTimersByTimeAsync(0)
    expect(document.querySelector('[data-painter-pace]')?.textContent).toContain(
      'Could not load painter contributions',
    )
  })
})
