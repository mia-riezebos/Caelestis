// @vitest-environment happy-dom
import { type ArchiveHistory, millis, seconds, type Template } from '@caelestis/shared'
import { flushSync, mount, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  getArchiveHistory: vi.fn(),
  getContributions: vi.fn(),
  getHistory: vi.fn(),
  getProgressHistory: vi.fn(),
  getLeaderboard: vi.fn(),
  getPainterHistory: vi.fn(),
  getPainterTotals: vi.fn(),
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
  api.getProgressHistory.mockReset().mockResolvedValue({ samples: [] })
  api.getContributions.mockReset().mockResolvedValue({ days: [] })
  api.getLeaderboard.mockReset().mockResolvedValue({ entries: [] })
  api.getArchiveHistory
    .mockReset()
    .mockResolvedValue({ source: 'eralyon', basis: null, samples: [], frames: [] })
  api.getPainterHistory.mockReset().mockResolvedValue({ buckets: [] })
  api.getPainterTotals.mockReset().mockResolvedValue({ painters: [] })
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
  it.each([false, true])(
    'includes backfilled progress in the estimate (reported history: %s)',
    async (reported) => {
      api.getArchiveHistory.mockResolvedValue({
        source: 'eralyon',
        basis: {
          templateId: 'live',
          versionId: 'version',
          name: 'live',
          season: 0,
          bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
          total: 400,
          chunks: [],
        },
        samples: [0, 100, 200].map((correct, index) => ({
          at: NOW_SECONDS - (3 - index) * DAY_SECONDS,
          snapshotId: index,
          correct,
          mismatched: 0,
          total: 400,
        })),
        frames: [],
      })
      api.getHistory.mockResolvedValue({
        resolution: DAY_SECONDS,
        coverageStart: seconds(0),
        buckets: reported
          ? [
              {
                templateId: 'live',
                resolution: DAY_SECONDS,
                bucketStart: seconds(NOW_SECONDS - DAY_SECONDS),
                placed: 1000,
                correct: 10,
                repairs: 0,
              },
            ]
          : [],
      })
      mounted = mount(StatsPanel, {
        target: document.body,
        props: {
          season: 0,
          liveDashboard: false,
          templates: [template('live', NOW_SECONDS - DAY_SECONDS, null)],
          subscribeDashboard: live.subscribe,
          progress: { completed: 260, mismatched: 0, unpainted: 140, known: 400, total: 400 },
        },
      })
      flushSync()
      await vi.waitFor(() =>
        expect(document.body.textContent).toContain(
          reported ? 'Estimated completion in ~2 d' : 'Estimated completion in ~34 h',
        ),
      )
      expect(document.body.textContent).toContain(reported ? '3 d of data' : '2 d of data')
    },
  )

  it.each([false, true])(
    'waits for imported history before revealing the chart (failure: %s)',
    async (failure) => {
      const pending = Promise.withResolvers<ArchiveHistory>()
      api.getArchiveHistory.mockReturnValue(pending.promise)
      mounted = mount(StatsPanel, {
        target: document.body,
        props: {
          season: 0,
          liveDashboard: false,
          templates: [template('live', 0, null)],
          subscribeDashboard: live.subscribe,
          progress: { completed: 10, mismatched: 0, unpainted: 90, known: 100, total: 100 },
        },
      })
      flushSync()
      await new Promise((resolve) => setTimeout(resolve, 0))
      flushSync()
      expect(document.querySelector('svg[role="img"]')).toBeNull()
      if (failure) pending.reject(new Error('Archive unavailable'))
      else
        pending.resolve({
          source: 'eralyon',
          basis: {
            templateId: 'live',
            versionId: 'version',
            name: 'live',
            season: 0,
            bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
            total: 100,
            chunks: [],
          },
          samples: [1, 5].map((correct, index) => ({
            at: NOW_SECONDS - (3 - index) * DAY_SECONDS,
            snapshotId: index,
            correct,
            mismatched: 0,
            total: 100,
          })),
          frames: [],
        })
      await vi.waitFor(() => expect(document.querySelector('svg[role="img"]')).not.toBeNull())
      if (failure)
        expect(document.body.textContent).toContain('Imported progress history could not load.')
      else expect(document.querySelector('.chart-reveal [data-archive-progress]')).not.toBeNull()
    },
  )

  it('shows time to completion beyond a year using correct pixels rather than placements', async () => {
    api.getHistory.mockResolvedValue({
      resolution: DAY_SECONDS,
      coverageStart: seconds(NOW_SECONDS - DAY_SECONDS),
      buckets: [
        {
          templateId: 'live',
          resolution: DAY_SECONDS,
          bucketStart: seconds(NOW_SECONDS - DAY_SECONDS),
          placed: 1000,
          correct: 1,
          repairs: 0,
        },
      ],
    })
    mounted = mount(StatsPanel, {
      target: document.body,
      props: {
        season: 0,
        liveDashboard: false,
        templates: [template('live', 0, null)],
        subscribeDashboard: live.subscribe,
        progress: { completed: 1, mismatched: 0, unpainted: 400, known: 401, total: 401 },
      },
    })
    flushSync()
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Estimated completion in ~1.1 y'),
    )
  })

  it('preserves a complete, unknown, complete transition in recent history', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW_SECONDS * 1000)
    api.getProgressHistory.mockImplementation((_id, _version, from) =>
      Promise.resolve({
        samples:
          from === 0
            ? [{ at: NOW_SECONDS - 7200, correct: 5, mismatched: 0, total: 100 }]
            : [
                { at: NOW_SECONDS - 5400, correct: null, mismatched: null, total: 100 },
                { at: NOW_SECONDS - 3600, correct: 10, mismatched: 0, total: 100 },
                { at: NOW_SECONDS - 1800, correct: null, mismatched: null, total: 100 },
                { at: NOW_SECONDS - 900, correct: 20, mismatched: 0, total: 100 },
              ],
      }),
    )
    mounted = mount(StatsPanel, {
      target: document.body,
      props: {
        templates: [template('live', 0, null)],
        season: 1,
        liveDashboard: true,
        subscribeDashboard: live.subscribe,
        progress: { completed: 30, mismatched: 0, unpainted: 70, known: 100, total: 100 },
      },
    })
    flushSync()
    await vi.advanceTimersByTimeAsync(0)
    const hover = (key: string) => {
      document
        .querySelector('svg[role="img"]')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
      flushSync()
      return document.querySelector('[data-pace-tooltip]')?.textContent
    }
    hover('End')
    expect(hover('Home')).toMatch(/correct\s*5/)
    expect(hover('ArrowRight')).toMatch(/correct\s*10/)
    expect(hover('ArrowRight')).toContain('No coverage')
    expect(hover('ArrowRight')).toMatch(/correct\s*20/)
  })

  it('keeps successful saved observations after a transient refresh failure and requests recent finer history', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW_SECONDS * 1000)
    api.getProgressHistory.mockResolvedValue({
      samples: [
        { at: NOW_SECONDS - 3600, correct: 10, mismatched: 0, total: 100 },
        { at: NOW_SECONDS - 1800, correct: 20, mismatched: 0, total: 100 },
      ],
    })
    mounted = mount(StatsPanel, {
      target: document.body,
      props: {
        templates: [template('live', 0, null)],
        season: 1,
        liveDashboard: true,
        subscribeDashboard: live.subscribe,
        progress: { completed: 30, mismatched: 0, unpainted: 70, known: 100, total: 100 },
      },
    })
    flushSync()
    await vi.advanceTimersByTimeAsync(0)
    expect(api.getProgressHistory).toHaveBeenCalledWith(
      'live',
      'version',
      NOW_SECONDS - 6 * DAY_SECONDS,
      NOW_SECONDS + 1,
    )
    const firstValue = () => {
      const chart = document.querySelector('svg[role="img"]')
      chart?.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
      chart?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
      flushSync()
      return document.querySelector('[data-pace-tooltip]')?.textContent
    }
    expect(firstValue()).toMatch(/correct\s*10/)
    api.getProgressHistory.mockRejectedValue(new Error('Temporary error'))
    await vi.advanceTimersByTimeAsync(300000)
    flushSync()
    await vi.advanceTimersByTimeAsync(0)
    expect(document.body.textContent).toContain('Saved progress history could not load.')
    expect(firstValue()).toMatch(/correct\s*10/)
  })

  it('keeps the annual estimate visible while the next live history read is pending', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW_SECONDS * 1000)
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => (key === 'caelestis:estimate-period' ? '"1y"' : null),
      setItem: vi.fn(),
    })
    api.getHistory.mockResolvedValue({
      resolution: 900,
      coverageStart: seconds(NOW_SECONDS - 3 * DAY_SECONDS),
      buckets: [
        {
          templateId: 'live',
          resolution: 900,
          bucketStart: seconds(NOW_SECONDS - 900),
          placed: 60,
          correct: 60,
          repairs: 0,
        },
      ],
    })
    mounted = mount(StatsPanel, {
      target: document.body,
      props: {
        season: 0,
        liveDashboard: false,
        templates: [template('live', 0, null)],
        subscribeDashboard: live.subscribe,
        progress: { completed: 60, mismatched: 0, unpainted: 40, known: 100, total: 100 },
      },
    })
    flushSync()
    await vi.advanceTimersByTimeAsync(0)
    flushSync()
    expect(document.body.textContent).toContain('3 d of data')
    expect(api.getHistory).toHaveBeenCalledTimes(11)
    api.getHistory.mockImplementation(() => new Promise(() => {}))
    await vi.advanceTimersByTimeAsync(15_000)
    flushSync()
    expect(api.getHistory).toHaveBeenCalledTimes(22)
    expect(document.body.textContent).toContain('3 d of data')
    expect(document.body.textContent).not.toContain('Completion estimate unavailable')
  })

  it('changes and persists every ETA period using the loaded history', async () => {
    const storage = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    })
    api.getHistory.mockResolvedValue({
      resolution: DAY_SECONDS,
      coverageStart: seconds(0),
      buckets: [
        {
          templateId: 'live',
          resolution: DAY_SECONDS,
          bucketStart: seconds(NOW_SECONDS - DAY_SECONDS),
          placed: 420,
          correct: 420,
          repairs: 0,
        },
      ],
    })
    const props = {
      season: 0,
      liveDashboard: false,
      templates: [template('live', 0, null)],
      subscribeDashboard: live.subscribe,
      progress: { completed: 420, mismatched: 0, unpainted: 2400, known: 2820, total: 2820 },
    }
    mounted = mount(StatsPanel, { target: document.body, props })
    flushSync()
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Estimated completion in ~40 d'),
    )
    const select = document.querySelector<HTMLSelectElement>(
      'select[aria-label="Completion estimate pace period"]',
    )
    if (select === null) throw new Error('missing estimate period')
    expect(select.value).toBe('7d')
    select.value = '1d'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    flushSync()
    expect(document.body.textContent).toContain('Estimated completion in ~6 d')
    expect(storage.get('caelestis:estimate-period')).toBe('"1d"')
    await unmount(mounted)
    mounted = mount(StatsPanel, { target: document.body, props })
    flushSync()
    await vi.waitFor(() =>
      expect(
        document.querySelector<HTMLSelectElement>(
          'select[aria-label="Completion estimate pace period"]',
        )?.value,
      ).toBe('1d'),
    )
    const restored = document.querySelector<HTMLSelectElement>(
      'select[aria-label="Completion estimate pace period"]',
    )
    if (restored === null) throw new Error('missing estimate period')
    await vi.waitFor(() => expect(api.getHistory).toHaveBeenCalledTimes(22))
    restored.value = '1y'
    restored.dispatchEvent(new Event('change', { bubbles: true }))
    flushSync()
    expect(api.getHistory).toHaveBeenCalledTimes(22)
    await vi.waitFor(() => expect(document.body.textContent).toContain('40 d of data'))
  })
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
    await vi.waitFor(() => expect(api.getHistory).toHaveBeenCalledTimes(11))

    expect(api.getHistory).toHaveBeenCalledWith(['older', 'newer'], 0, finishedAt + 1)
    expect(
      api.getHistory.mock.calls
        .map((call) => call[3]?.maxResolution)
        .filter((resolution) => resolution !== undefined),
    ).toEqual([900, 1_800, 3_600, 5_400, 10_800, 21_600, 43_200, 129_600, 302_400, 1_296_000])
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
    await vi.waitFor(() => expect(api.getHistory).toHaveBeenCalledTimes(11))

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
      expect(api.getHistory).toHaveBeenCalledTimes(11)
      const preset = document.querySelector<HTMLButtonElement>('[data-range-preset="6h"]')
      preset?.click()
      flushSync()
      expect(preset?.getAttribute('aria-pressed')).toBe('true')

      await vi.advanceTimersByTimeAsync(15_000)
      flushSync()
      await vi.advanceTimersByTimeAsync(0)

      expect(api.getHistory).toHaveBeenCalledTimes(22)
      expect(api.getHistory).toHaveBeenLastCalledWith(['live'], 0, NOW_SECONDS + 16, {
        maxResolution: 1_296_000,
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

    await vi.waitFor(() => expect(document.body.textContent).toContain('10.5 h of data'))
  })
})

describe('live counts', () => {
  it('includes imported contributions after template creation but before the first report', async () => {
    api.getProgressHistory.mockResolvedValue({
      samples: [
        {
          at: NOW_SECONDS - 2 * DAY_SECONDS + 3600,
          correct: 22,
          mismatched: 0,
          total: 100,
        },
      ],
    })
    api.getArchiveHistory.mockResolvedValue({
      source: 'eralyon',
      basis: {
        templateId: 'live',
        versionId: 'version',
        name: 'live',
        season: 0,
        bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
        total: 100,
        chunks: [],
      },
      samples: [10, 22].map((correct, index) => ({
        at: NOW_SECONDS - (3 - index) * DAY_SECONDS,
        snapshotId: index,
        correct,
        mismatched: 0,
        total: 100,
      })),
      frames: [],
    })
    api.getHistory.mockResolvedValue({
      resolution: 900,
      coverageStart: seconds(NOW_SECONDS - DAY_SECONDS),
      buckets: [
        {
          templateId: 'live',
          resolution: 900,
          bucketStart: seconds(NOW_SECONDS - DAY_SECONDS),
          placed: 7,
          correct: 7,
          repairs: 0,
        },
      ],
    })
    mounted = mount(StatsPanel, {
      target: document.body,
      props: {
        season: 0,
        liveDashboard: false,
        templates: [template('live', 0, null)],
        subscribeDashboard: live.subscribe,
        progress: { completed: 29, mismatched: 0, unpainted: 71, known: 100, total: 100 },
      },
    })
    flushSync()
    await vi.waitFor(() =>
      expect(
        document.querySelector('[aria-label$="12 net correct pixels (imported)"]'),
      ).not.toBeNull(),
    )
  })

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
  it('reads painter buckets for the enabled windows and draws them on the progress chart', async () => {
    const bucketStart = seconds(NOW_SECONDS - 1_800)
    api.getHistory.mockResolvedValue({
      buckets: [
        { templateId: 'live', resolution: 900, bucketStart, placed: 4, correct: 4, repairs: 0 },
      ],
    })
    const painter = (wplaceUserId: number, displayName: string, placed: number) => ({
      wplaceUserId,
      displayName,
      placed,
      correct: placed,
      repairs: 0,
    })
    // Seven painters: the leading five draw by default, the others wait in the picker.
    api.getPainterTotals.mockResolvedValue({
      painters: [
        painter(5, 'Ada', 70),
        painter(6, 'Bo', 60),
        painter(7, 'Cyd', 50),
        painter(8, 'Dee', 40),
        painter(9, 'Eli', 30),
        painter(10, 'Fen', 20),
        painter(11, 'Gus', 10),
      ],
    })
    api.getPainterHistory.mockImplementation((_ids, painters: readonly number[]) =>
      Promise.resolve({
        resolution: 900,
        coverageStart: seconds(0),
        buckets: painters.map((wplaceUserId) => ({
          templateId: 'live',
          wplaceUserId,
          displayName: `painter ${wplaceUserId}`,
          resolution: 900,
          bucketStart,
          placed: 3,
          correct: 3,
          repairs: 0,
        })),
      }),
    )
    mounted = mount(StatsPanel, {
      target: document.body,
      props: {
        season: 0,
        liveDashboard: true,
        templates: [template('live', 0, null)],
        subscribeDashboard: live.subscribe,
        progress: { completed: 4, mismatched: 0, unpainted: 1, known: 5, total: 5 },
      },
    })
    flushSync()

    // One bounded list of painters for the scope, then one retained tier per enabled window (1h
    // and 6h) for the selected painters only.
    await vi.waitFor(() => expect(api.getPainterTotals).toHaveBeenCalledTimes(1))
    expect(api.getPainterTotals.mock.calls[0]?.[3]).toEqual({ limit: 500 })
    await vi.waitFor(() => expect(api.getPainterHistory).toHaveBeenCalledTimes(2))
    expect(api.getPainterHistory.mock.calls.map((call) => call[4]?.maxResolution).sort()).toEqual(
      [10_800, 1_800].sort(),
    )
    expect(api.getPainterHistory.mock.calls[0]?.[1]).toEqual([5, 6, 7, 8, 9])
    await vi.waitFor(() =>
      expect(
        document.querySelector('path[data-painter-line="5"][data-pace-window="1h"]'),
      ).not.toBeNull(),
    )
    expect(
      document.querySelectorAll('path[data-painter-line][data-pace-window="6h"]'),
    ).toHaveLength(5)
    expect(document.querySelector('path[data-painter-line="10"]')).toBeNull()
    expect(document.querySelector('[data-painter-trigger]')?.textContent).toContain('5 of 7')
    expect(api.getContributions).not.toHaveBeenCalled()
    // The heatmap read stays a year of weeks: painter pace no longer rides on contribution days.
    expect(live.subscribe.mock.calls[0]?.[1]).toBe(NOW_SECONDS - 86_400 * 7 * 53)

    // Choosing another painter from the popout fetches the windows again for the new selection.
    document.querySelector<HTMLButtonElement>('[data-painter-trigger]')?.click()
    flushSync()
    await vi.waitFor(() => expect(document.querySelector('[data-painter-search]')).not.toBeNull())
    const input = document.querySelector<HTMLInputElement>('[data-painter-search]')
    if (input !== null) input.value = 'fen'
    input?.dispatchEvent(new Event('input', { bubbles: true }))
    flushSync()
    await vi.waitFor(() =>
      expect(document.querySelectorAll('[data-painter-option]')).toHaveLength(1),
    )
    ;(document.querySelector('[data-painter-option="10"]') as HTMLElement).click()
    flushSync()
    await vi.waitFor(() =>
      expect(document.querySelector('path[data-painter-line="10"]')).not.toBeNull(),
    )
    expect(api.getPainterHistory.mock.calls.at(-1)?.[1]).toEqual([5, 6, 7, 8, 9, 10])
    // The row's read-out state follows the toggle, independent of the command cursor.
    expect(
      document.querySelector('[data-painter-option="10"] [data-painter-state]')?.textContent,
    ).toBe('drawn')

    document.querySelector<HTMLButtonElement>('[data-painters-hide-all]')?.click()
    flushSync()
    await vi.waitFor(() =>
      expect(document.querySelectorAll('path[data-painter-line]')).toHaveLength(0),
    )
    document.querySelector<HTMLButtonElement>('[data-painters-show-all]')?.click()
    flushSync()
    await vi.waitFor(() =>
      expect(document.querySelectorAll('path[data-painter-line]')).toHaveLength(14),
    )
    expect(api.getPainterHistory.mock.calls.at(-1)?.[1]).toEqual([5, 6, 7, 8, 9, 10, 11])
  })

  it('draws the template lines alone when the server has no painter buckets', async () => {
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
    api.getPainterTotals.mockRejectedValue(new Error('404'))
    api.getPainterHistory.mockRejectedValue(new Error('404'))
    mounted = mount(StatsPanel, {
      target: document.body,
      props: {
        season: 0,
        liveDashboard: true,
        templates: [template('live', 0, null)],
        subscribeDashboard: live.subscribe,
        progress: { completed: 1, mismatched: 0, unpainted: 1, known: 2, total: 2 },
      },
    })
    flushSync()
    await vi.waitFor(() => expect(document.querySelector('svg[role="img"]')).not.toBeNull())
    // Everyone's pace is still there to toggle; there are just no painters to add to it.
    expect(document.querySelector('[data-painter-trigger]')?.textContent).toContain('all users')
    expect(document.querySelector('path[data-painter-line]')).toBeNull()
  })
})
