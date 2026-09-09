// @vitest-environment happy-dom
import { type HistoryBucket, seconds } from '@caelestis/shared'
import { flushSync, mount, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ProgressPaceChart from './ProgressPaceChart.svelte'

let mounted: ReturnType<typeof mount> | null = null
const stored = new Map<string, string>()

beforeEach(() => {
  stored.clear()
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(640)
  // Tweens and transitions become cuts, so every assertion below sees the settled chart.
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList)
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  })
})

afterEach(async () => {
  if (mounted !== null) await unmount(mounted)
  mounted = null
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  document.body.replaceChildren()
})

const bucket = (resolution: number, bucketStart: number): HistoryBucket => ({
  templateId: 'template',
  resolution,
  bucketStart: seconds(bucketStart),
  placed: 1,
  correct: 1,
  repairs: 0,
})

const paceToggle = (label: string): HTMLElement => {
  if (document.querySelector('[data-pace-list]') === null) {
    document.querySelector<HTMLButtonElement>('[data-pace-trigger]')?.click()
    flushSync()
  }
  const found = document.querySelector(`[data-pace-toggle="${label}"]`)
  if (!(found instanceof HTMLElement)) throw new Error(`missing ${label} pace toggle`)
  return found
}

describe('rolling pace retention', () => {
  it('gives live history precedence when archive snapshots extend past the first reported point', () => {
    mounted = mount(ProgressPaceChart, {
      target: document.body,
      props: {
        buckets: [bucket(900, 129600)],
        resolution: 900,
        from: 0,
        to: 173700,
        anchorCorrect: 40,
        anchorMismatched: 3,
        archiveSamples: [10, 20, 999].map((correct, index) => ({
          at: index * 86400,
          snapshotId: index,
          correct,
          mismatched: 5,
          total: 1000,
        })),
      },
    })
    flushSync()
    const progress = document.querySelector('[data-archive-progress]')?.getAttribute('d') ?? ''
    expect(progress).toMatch(/L453\.9,/)
    expect(progress).not.toMatch(/L589\.2,/)
    const chart = document.querySelector('svg[role="img"]')
    chart?.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    chart?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    flushSync()
    expect(document.querySelector('[data-pace-tooltip]')?.textContent).not.toContain(
      'Eralyon snapshot',
    )
    expect(document.querySelector('[data-pace-tooltip]')?.textContent).toContain('40')
  })
  it('keeps an isolated snapshot visible as a short dash without filling unknown coverage', () => {
    mounted = mount(ProgressPaceChart, {
      target: document.body,
      props: {
        buckets: [],
        resolution: 900,
        from: 0,
        to: 172800,
        anchorCorrect: 0,
        anchorMismatched: 0,
        archiveSamples: [null, 10, null].map((correct, index) => ({
          at: index * 86400,
          snapshotId: index,
          correct,
          mismatched: correct === null ? null : 5,
          total: 20,
        })),
      },
    })
    flushSync()
    expect(document.querySelectorAll('[data-archive-singleton]')).toHaveLength(1)
    expect(document.querySelector('[data-archive-progress-area]')).toBeNull()
    expect(document.querySelector('[data-archive-pace]')).toBeNull()
  })
  it.each([false, true])(
    'shows sparse coverage without fabricated placements (all gaps: %s)',
    (allGaps) => {
      stored.set('caelestis:pace-windows', JSON.stringify(['1d']))
      mounted = mount(ProgressPaceChart, {
        target: document.body,
        props: {
          buckets: [],
          resolution: 900,
          from: 0,
          to: 172800,
          anchorCorrect: 5,
          anchorMismatched: 0,
          archiveSamples: (allGaps ? [null, null, null] : [10, 5, null]).map((correct, index) => ({
            at: index * 86400,
            snapshotId: index,
            correct,
            mismatched: correct === null ? null : 0,
            total: 20,
          })),
        },
      })
      flushSync()
      expect(document.querySelectorAll('[data-archive-progress]')).toHaveLength(allGaps ? 0 : 1)
      expect(document.querySelectorAll('[data-archive-progress-area]')).toHaveLength(
        allGaps ? 0 : 1,
      )
      expect(document.querySelectorAll('path[data-pace-window="1d"]')).toHaveLength(allGaps ? 0 : 1)
      expect(document.querySelectorAll('circle[data-pace-singleton="1d"]')).toHaveLength(allGaps ? 0 : 1)
      expect(document.body.textContent).toContain('No coverage')
      expect(document.body.textContent).not.toContain('No paint activity')
      const chart = document.querySelector('svg[role="img"]')
      if (!(chart instanceof SVGSVGElement)) throw new Error('missing chart')
      chart.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
      flushSync()
      expect(document.querySelector('[data-pace-tooltip]')?.textContent).toContain(
        'Eralyon snapshot',
      )
      expect(document.querySelector('[data-pace-tooltip]')?.textContent).toContain(
        allGaps ? 'No coverage' : '10',
      )
      chart.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      flushSync()
      expect(document.querySelector('[data-pace-row="all"]')?.textContent ?? '').toContain(
        allGaps ? '' : '-0.2',
      )
      chart.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
      flushSync()
      expect(document.querySelector('[data-pace-tooltip]')?.textContent).toContain('No coverage')
      expect(document.querySelector('[data-archive-hover]')).toBeNull()
      expect(document.querySelector('[data-painter-metric]')).toBeNull()
      if (!allGaps) {
        paceToggle('1d').click()
        flushSync()
        expect(document.querySelector('[data-archive-pace]')).toBeNull()
        expect(stored.get('caelestis:pace-windows')).toBe('[]')
        expect(document.querySelector('[data-pace-trigger]')?.textContent).toContain('None')
        paceToggle('1d').click()
        flushSync()
        expect(document.querySelector('path[data-pace-window="1d"]')).not.toBeNull()
      }
    },
  )
  it('breaks archived lines and fills at missing snapshots and clips sparse intervals to the view', () => {
    mounted = mount(ProgressPaceChart, {
      target: document.body,
      props: {
        buckets: [],
        resolution: 900,
        from: 43200,
        to: 302400,
        anchorCorrect: 0,
        anchorMismatched: 0,
        archiveSamples: [10, 5, null, 6, 9].map((correct, index) => ({
          at: index * 86400,
          snapshotId: index,
          correct,
          mismatched: correct === null ? null : 0,
          total: 20,
        })),
      },
    })
    flushSync()
    const lines = [...document.querySelectorAll('[data-archive-progress]')]
    const areas = [...document.querySelectorAll('[data-archive-progress-area]')]
    expect(lines).toHaveLength(2)
    expect(areas).toHaveLength(2)
    expect(lines[0]?.getAttribute('d')).toMatch(/^M48\.0,.*L138\.7,/)
    expect(lines[1]?.getAttribute('d')).toMatch(/^M501\.3,.*L592\.0,/)
    for (const [index, line] of lines.entries()) {
      expect(line.getAttribute('stroke-dasharray')).toBe('5 4')
      expect(areas[index]?.getAttribute('d')).toMatch(new RegExp(`^${line.getAttribute('d')}.*Z$`))
    }
  })
  it.each([false, true])(
    'connects sparse pace and progress to live history unless coverage is missing (gap: %s)',
    (gap) => {
      stored.set('caelestis:pace-windows', JSON.stringify(['1d']))
      mounted = mount(ProgressPaceChart, {
        target: document.body,
        props: {
          buckets: [bucket(900, 259200)],
          resolution: 900,
          from: 0,
          to: 260100,
          anchorCorrect: 40,
          anchorMismatched: 3,
          archiveSamples: [10, 20, gap ? null : 15].map((correct, index) => ({
            at: index * 86400,
            snapshotId: index,
            correct,
            mismatched: correct === null ? null : 5,
            total: 50,
          })),
        },
      })
      flushSync()
      const progress = document.querySelector('[data-archive-progress]')?.getAttribute('d') ?? ''
      const pace = document.querySelector('path[data-pace-window="1d"]')
      const pacePath = pace?.getAttribute('d') ?? ''
      expect((pacePath.match(/L/g) ?? []).length).toBe(gap ? 0 : 3)
      expect(progress.match(/L/g)).toHaveLength(gap ? 1 : 3)
      const mismatch = document.querySelector('[data-archive-mismatched]')?.getAttribute('d') ?? ''
      const area = document.querySelector('[data-archive-mismatched-area]')?.getAttribute('d') ?? ''
      expect(mismatch.match(/L/g)).toHaveLength(gap ? 1 : 3)
      expect(area.startsWith(mismatch)).toBe(true)
      const firstCorrect = progress.match(/^M([\d.]+),([\d.]+)/)
      const firstMismatched = mismatch.match(/^M([\d.]+),([\d.]+)/)
      expect(Number(firstMismatched?.[2])).toBeLessThan(Number(firstCorrect?.[2]))
      expect(area.endsWith(`L${firstCorrect?.[1]},${firstCorrect?.[2]}Z`)).toBe(true)
      if (!gap) {
        expect(progress).toMatch(/L590\.1,/)
        expect(pacePath).toMatch(/L592\.0,/)
        const chart = document.querySelector('svg[role="img"]')
        chart?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
        for (let index = 0; index < 3; index++) {
          chart?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
          flushSync()
        }
        expect(document.querySelector('[data-pace-tooltip]')?.textContent).toContain(
          'Includes imported net progress',
        )
      }
    },
  )
  it('uses Standard axis suffixes and exact pixel labels', () => {
    mounted = mount(ProgressPaceChart, {
      target: document.body,
      props: {
        buckets: [bucket(3600, 0), bucket(3600, 3600)],
        resolution: 3600,
        from: 0,
        to: 7200,
        anchorCorrect: 3_000_000,
        anchorMismatched: 0,
      },
    })
    flushSync()
    const labels = [...document.querySelectorAll('text[aria-label]')]
    expect(labels.some((label) => label.textContent?.includes('M'))).toBe(true)
    for (const label of labels) {
      expect(label.querySelector('title')?.textContent).toBe(label.getAttribute('aria-label'))
      expect(label.getAttribute('aria-label')).toMatch(/pixels?( per hour)?$/)
    }
  })

  it('keeps short windows selectable when only the recent history is granular enough', () => {
    const buckets = [bucket(3_600, 0), bucket(3_600, 3_600), bucket(3_600, 7_200)]
    const paceBuckets = [bucket(900, 4_500)]

    mounted = mount(ProgressPaceChart, {
      target: document.body,
      props: {
        buckets,
        paceHistories: [
          {
            window: '30m',
            history: { buckets: paceBuckets, resolution: 900, coverageStart: seconds(3_600) },
          },
          {
            window: '1h',
            history: { buckets: paceBuckets, resolution: 900, coverageStart: seconds(3_600) },
          },
        ],
        resolution: 3_600,
        from: 0,
        to: 9_000,
        anchorCorrect: 3,
        anchorMismatched: 0,
      },
    })
    flushSync()

    expect(paceToggle('30m').getAttribute('aria-disabled')).not.toBe('true')
    expect(paceToggle('1h').getAttribute('aria-disabled')).not.toBe('true')
    const oneHourLine = document.querySelector('path[data-pace-window="1h"]')
    expect(oneHourLine?.getAttribute('data-series-start')).toBe('7200')
    expect(oneHourLine?.getAttribute('d')).toMatch(/^M/)
  })

  it('snaps the hover timeline to a rendered fine-grained pace point', () => {
    stored.set('caelestis:pace-windows', JSON.stringify(['30m']))
    const buckets = [bucket(3_600, 0), bucket(3_600, 3_600), bucket(3_600, 7_200)]
    const paceBuckets = [bucket(900, 4_500), bucket(900, 5_400)]

    mounted = mount(ProgressPaceChart, {
      target: document.body,
      props: {
        buckets,
        paceHistories: [
          {
            window: '30m',
            history: { buckets: paceBuckets, resolution: 900, coverageStart: seconds(3_600) },
          },
        ],
        resolution: 3_600,
        from: 0,
        to: 9_000,
        anchorCorrect: 3,
        anchorMismatched: 0,
      },
    })
    flushSync()

    const chart = document.querySelector('svg[role="img"]')
    const paceLine = document.querySelector('path[data-pace-window="30m"]')
    if (!(chart instanceof SVGSVGElement) || !(paceLine instanceof SVGPathElement)) {
      throw new Error('missing chart or 30m pace line')
    }
    const path = paceLine.getAttribute('d') ?? ''
    const firstPaceX = Number(/^M([^,]+)/.exec(path)?.[1])
    chart.getBoundingClientRect = () => ({ left: 0 }) as DOMRect

    chart.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: firstPaceX }))
    flushSync()

    const crosshair = chart.querySelector('line[data-crosshair]')
    expect(Number(crosshair?.getAttribute('x1'))).toBe(firstPaceX)
  })

  it('starts coarser pace windows earlier without inventing pruned detail', () => {
    stored.set('caelestis:pace-windows', JSON.stringify(['30m', '6h']))
    const to = 90_000

    mounted = mount(ProgressPaceChart, {
      target: document.body,
      props: {
        buckets: [bucket(21_600, 0)],
        paceHistories: [
          {
            window: '30m',
            history: {
              buckets: [bucket(900, 72_000)],
              resolution: 900,
              coverageStart: seconds(72_000),
            },
          },
          {
            window: '6h',
            history: {
              buckets: [bucket(3_600, 0)],
              resolution: 3_600,
              coverageStart: seconds(0),
            },
          },
        ],
        resolution: 21_600,
        from: 0,
        to,
        anchorCorrect: 1,
        anchorMismatched: 0,
      },
    })
    flushSync()

    const shortLine = document.querySelector('path[data-pace-window="30m"]')
    const coarseLine = document.querySelector('path[data-pace-window="6h"]')
    const head = document.querySelector('[data-handle="head"]')
    const tail = document.querySelector('[data-handle="tail"]')

    expect(shortLine?.getAttribute('data-series-start')).toBe('73800')
    expect(coarseLine?.getAttribute('data-series-start')).toBe('21600')
    expect(Number(shortLine?.getAttribute('data-series-first-value'))).toBeGreaterThan(0)
    expect(Number(coarseLine?.getAttribute('data-series-first-value'))).toBeGreaterThan(0)
    expect(shortLine?.getAttribute('d')).toMatch(/^M/)
    expect(coarseLine?.getAttribute('d')).toMatch(/^M/)
    expect(head?.getAttribute('aria-valuemin')).toBe('0')
    expect(tail?.getAttribute('aria-valuemax')).toBe(String(to))
  })

  it('holds the latest complete pace through an unfinished bucket', () => {
    stored.set('caelestis:pace-windows', JSON.stringify(['2h']))
    mounted = mount(ProgressPaceChart, {
      target: document.body,
      props: {
        buckets: [
          { ...bucket(3_600, 0), placed: 1 },
          { ...bucket(3_600, 3_600), placed: 2 },
          { ...bucket(3_600, 7_200), placed: 3 },
          { ...bucket(3_600, 10_800), placed: 100 },
        ],
        resolution: 3_600,
        from: 0,
        to: 12_600,
        anchorCorrect: 6,
        anchorMismatched: 0,
      },
    })
    flushSync()

    const path = document.querySelector('path[data-pace-window="2h"]')?.getAttribute('d') ?? ''
    const points = [...path.matchAll(/[ML]([^,]+),([^ML]+)/g)]
    expect(points).toHaveLength(3)
    expect(points.at(-1)?.[2]).toBe(points.at(-2)?.[2])
  })

  it('keeps lifecycle-wide time labels sparse enough to read', () => {
    mounted = mount(ProgressPaceChart, {
      target: document.body,
      props: {
        buckets: [bucket(21_600, 0)],
        resolution: 21_600,
        from: 0,
        to: 180 * 86_400,
        anchorCorrect: 1,
        anchorMismatched: 0,
      },
    })
    flushSync()

    expect(document.querySelectorAll('text[data-axis="time"]')).toHaveLength(6)
  })

  it('distinguishes sub-day ticks across a two-day range', () => {
    mounted = mount(ProgressPaceChart, {
      target: document.body,
      props: {
        buckets: [bucket(3_600, 0)],
        resolution: 3_600,
        from: 0,
        to: 2 * 86_400,
        anchorCorrect: 1,
        anchorMismatched: 0,
      },
    })
    flushSync()

    const labels = [...document.querySelectorAll('text[data-axis="time"]')].map((label) =>
      label.textContent?.trim(),
    )
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('distinguishes the repeated local hour during DST fall-back', () => {
    vi.stubEnv('TZ', 'America/New_York')
    const from = Date.parse('2026-11-01T03:00:00Z') / 1_000
    expect(new Date(from * 1_000).getTimezoneOffset()).not.toBe(
      new Date((from + 6 * 3_600) * 1_000).getTimezoneOffset(),
    )

    mounted = mount(ProgressPaceChart, {
      target: document.body,
      props: {
        buckets: [bucket(3_600, from)],
        resolution: 3_600,
        from,
        to: from + 6 * 3_600,
        anchorCorrect: 1,
        anchorMismatched: 0,
      },
    })
    flushSync()

    const labels = [...document.querySelectorAll('text[data-axis="time"]')].map((label) =>
      label.textContent?.trim(),
    )
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('does not synthesize progress points for empty lifecycle history', () => {
    const emptyBuckets: HistoryBucket[] = []
    emptyBuckets[Symbol.iterator] = () => {
      throw new Error('empty history must not be iterated')
    }
    mounted = mount(ProgressPaceChart, {
      target: document.body,
      props: {
        buckets: emptyBuckets,
        resolution: 900,
        from: 0,
        to: 10 * 365 * 86_400,
        anchorCorrect: 0,
        anchorMismatched: 0,
      },
    })
    flushSync()

    expect(document.body.textContent).toContain('No paint activity reported in this window.')
    expect(document.querySelector('svg[role="img"]')).toBeNull()
  })

  it('distinguishes daily ticks across an offset-crossing fall-back', () => {
    vi.stubEnv('TZ', 'Atlantic/Azores')
    const from = Date.parse('2026-10-24T00:00:00Z') / 1_000
    expect(new Date(from * 1_000).getTimezoneOffset()).not.toBe(
      new Date((from + 4 * 86_400) * 1_000).getTimezoneOffset(),
    )

    mounted = mount(ProgressPaceChart, {
      target: document.body,
      props: {
        buckets: [bucket(86_400, from)],
        resolution: 86_400,
        from,
        to: from + 4 * 86_400,
        anchorCorrect: 1,
        anchorMismatched: 0,
      },
    })
    flushSync()

    const labels = [...document.querySelectorAll('text[data-axis="time"]')].map((label) =>
      label.textContent?.trim(),
    )
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('includes years on multi-year lifecycle ticks', () => {
    const from = Date.UTC(2020, 6, 1, 12) / 1_000
    mounted = mount(ProgressPaceChart, {
      target: document.body,
      props: {
        buckets: [bucket(21_600, from)],
        resolution: 21_600,
        from,
        to: from + 3 * 365 * 86_400,
        anchorCorrect: 1,
        anchorMismatched: 0,
      },
    })
    flushSync()

    const labels = [...document.querySelectorAll('text[data-axis="time"]')].map(
      (label) => label.textContent?.trim() ?? '',
    )
    expect(labels.length).toBeGreaterThan(1)
    expect(labels.every((label) => /202(?:0|1|2|3)/.test(label))).toBe(true)
  })
})

describe('time window', () => {
  // 640px wide, 48px gutters on both sides: the plot and the strip both map time across 544px.
  const PLOT_LEFT = 48
  const PLOT_WIDTH = 544
  const DAY = 86_400
  const THREE_DAYS = 3 * DAY
  const px = (t: number, from = 0, to = THREE_DAYS): number =>
    PLOT_LEFT + ((t - from) / (to - from)) * PLOT_WIDTH

  const mountThreeDays = (): void => {
    mounted = mount(ProgressPaceChart, {
      target: document.body,
      props: {
        buckets: Array.from({ length: 72 }, (_, hour) => bucket(3_600, hour * 3_600)),
        resolution: 3_600,
        from: 0,
        to: THREE_DAYS,
        anchorCorrect: 72,
        anchorMismatched: 0,
      },
    })
    flushSync()
  }

  const grip = (edge: 'head' | 'tail'): HTMLElement => {
    const found = document.querySelector(`[data-handle="${edge}"]`)
    if (!(found instanceof HTMLElement)) throw new Error(`missing ${edge} grip`)
    return found
  }
  const gripValue = (edge: 'head' | 'tail'): number =>
    Number(grip(edge).getAttribute('aria-valuenow'))
  const preset = (key: string): HTMLButtonElement => {
    const found = document.querySelector(`button[data-range-preset="${key}"]`)
    if (!(found instanceof HTMLButtonElement)) throw new Error(`missing ${key} preset`)
    return found
  }
  const pointer = (type: string, init: PointerEventInit): PointerEvent =>
    new PointerEvent(type, { bubbles: true, ...init })

  it('keeps resizing the window after the pointer leaves the strip', () => {
    mountThreeDays()

    grip('head').dispatchEvent(pointer('pointerdown', { clientX: px(0), clientY: 300 }))
    window.dispatchEvent(pointer('pointermove', { clientX: px(DAY), clientY: -400 }))
    flushSync()

    expect(gripValue('head')).toBe(DAY)
    expect(gripValue('tail')).toBe(THREE_DAYS)

    window.dispatchEvent(pointer('pointerup', { clientX: px(DAY), clientY: -400 }))
    window.dispatchEvent(pointer('pointermove', { clientX: px(2 * DAY), clientY: -400 }))
    flushSync()

    expect(gripValue('head')).toBe(DAY)
  })

  it('slides the whole window when its body is dragged', () => {
    mountThreeDays()
    preset('1d').click()
    flushSync()
    expect(gripValue('head')).toBe(2 * DAY)

    const body = document.querySelector('rect[data-brush-window]')
    if (!(body instanceof SVGRectElement)) throw new Error('missing brush window')
    body.dispatchEvent(pointer('pointerdown', { clientX: px(2.5 * DAY), clientY: 300 }))
    window.dispatchEvent(pointer('pointermove', { clientX: px(1.5 * DAY), clientY: 300 }))
    window.dispatchEvent(pointer('pointerup', { clientX: px(1.5 * DAY), clientY: 300 }))
    flushSync()

    expect(gripValue('head')).toBe(DAY)
    expect(gripValue('tail')).toBe(2 * DAY)
  })

  it('zooms to a range dragged across the plot', () => {
    mountThreeDays()
    const chart = document.querySelector('svg[role="img"]')
    if (!(chart instanceof SVGSVGElement)) throw new Error('missing chart')
    chart.getBoundingClientRect = () => ({ left: 0, top: 0, right: 640, bottom: 240 }) as DOMRect

    chart.dispatchEvent(pointer('pointerdown', { clientX: px(DAY / 2), clientY: 100 }))
    window.dispatchEvent(pointer('pointermove', { clientX: px(1.5 * DAY), clientY: 100 }))
    flushSync()
    expect(chart.querySelector('rect[data-plot-selection]')).not.toBeNull()

    window.dispatchEvent(pointer('pointerup', { clientX: px(1.5 * DAY), clientY: 100 }))
    flushSync()

    expect(chart.querySelector('rect[data-plot-selection]')).toBeNull()
    expect(gripValue('head')).toBe(DAY / 2)
    expect(gripValue('tail')).toBe(1.5 * DAY)
    expect(preset('all').getAttribute('aria-pressed')).toBe('false')
  })

  it('ignores a plain click on the plot', () => {
    mountThreeDays()
    const chart = document.querySelector('svg[role="img"]')
    if (!(chart instanceof SVGSVGElement)) throw new Error('missing chart')
    chart.getBoundingClientRect = () => ({ left: 0, top: 0, right: 640, bottom: 240 }) as DOMRect

    chart.dispatchEvent(pointer('pointerdown', { clientX: px(DAY), clientY: 100 }))
    window.dispatchEvent(pointer('pointermove', { clientX: px(DAY) + 2, clientY: 100 }))
    window.dispatchEvent(pointer('pointerup', { clientX: px(DAY) + 2, clientY: 100 }))
    flushSync()

    expect(gripValue('head')).toBe(0)
    expect(gripValue('tail')).toBe(THREE_DAYS)
    expect(preset('all').getAttribute('aria-pressed')).toBe('true')
  })

  it('offers presets narrower than the history and clears them with all', () => {
    mountThreeDays()

    expect(
      [...document.querySelectorAll('button[data-range-preset]')].map((b) =>
        b.getAttribute('data-range-preset'),
      ),
    ).toEqual(['6h', '1d', 'all'])

    preset('1d').click()
    flushSync()
    expect(gripValue('head')).toBe(2 * DAY)
    expect(gripValue('tail')).toBe(THREE_DAYS)
    expect(preset('1d').getAttribute('aria-pressed')).toBe('true')
    expect(preset('all').getAttribute('aria-pressed')).toBe('false')

    preset('all').click()
    flushSync()
    expect(gripValue('head')).toBe(0)
    expect(preset('all').getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelector('[aria-label="time range"]')?.getAttribute('role')).toBe('group')
    expect(document.querySelector('[role="tab"]')).toBeNull()
  })

  it('keeps an unaligned minimum preset selected', () => {
    mounted = mount(ProgressPaceChart, {
      target: document.body,
      props: {
        buckets: Array.from({ length: 73 }, (_, hour) => bucket(3_600, hour * 3_600)),
        resolution: 3_600,
        from: 0,
        to: THREE_DAYS + 1,
        anchorCorrect: 73,
        anchorMismatched: 0,
      },
    })
    flushSync()

    preset('6h').click()
    flushSync()

    expect(gripValue('head')).toBe(THREE_DAYS + 1 - 6 * 3_600)
    expect(gripValue('tail')).toBe(THREE_DAYS + 1)
    expect(preset('6h').getAttribute('aria-pressed')).toBe('true')
  })

  it('ignores cancellation from another pointer during a plot drag', () => {
    mountThreeDays()
    const chart = document.querySelector('svg[role="img"]')
    if (!(chart instanceof SVGSVGElement)) throw new Error('missing chart')
    chart.getBoundingClientRect = () => ({ left: 0, top: 0, right: 640, bottom: 240 }) as DOMRect

    chart.dispatchEvent(
      pointer('pointerdown', { pointerId: 1, clientX: px(DAY / 2), clientY: 100 }),
    )
    window.dispatchEvent(pointer('pointermove', { pointerId: 1, clientX: px(DAY), clientY: 100 }))
    window.dispatchEvent(pointer('pointercancel', { pointerId: 2 }))
    window.dispatchEvent(
      pointer('pointermove', { pointerId: 1, clientX: px(1.5 * DAY), clientY: 100 }),
    )
    window.dispatchEvent(
      pointer('pointerup', { pointerId: 1, clientX: px(1.5 * DAY), clientY: 100 }),
    )
    flushSync()

    expect(gripValue('head')).toBe(DAY / 2)
    expect(gripValue('tail')).toBe(1.5 * DAY)
  })

  it('ignores cancellation from another pointer during a brush drag', () => {
    mountThreeDays()

    grip('head').dispatchEvent(
      pointer('pointerdown', { pointerId: 1, clientX: px(0), clientY: 300 }),
    )
    window.dispatchEvent(pointer('pointercancel', { pointerId: 2 }))
    window.dispatchEvent(pointer('pointermove', { pointerId: 1, clientX: px(DAY), clientY: 300 }))
    window.dispatchEvent(pointer('pointerup', { pointerId: 1, clientX: px(DAY), clientY: 300 }))
    flushSync()

    expect(gripValue('head')).toBe(DAY)
  })

  it('keeps narrow-window grips and its move target separately targetable', () => {
    mounted = mount(ProgressPaceChart, {
      target: document.body,
      props: {
        buckets: [bucket(3_600, 0)],
        resolution: 3_600,
        from: 0,
        to: 180 * DAY,
        anchorCorrect: 1,
        anchorMismatched: 0,
      },
    })
    flushSync()
    preset('6h').click()
    flushSync()

    const head = grip('head')
    const tail = grip('tail')
    const move = document.querySelector('[data-brush-move]')
    if (!(move instanceof HTMLElement)) throw new Error('missing brush move target')

    expect(head.style.width).toBe('66px')
    expect(tail.style.width).toBe('66px')
    expect(move.style.width).toBe('44px')
    expect(Number.parseFloat(head.style.left) + 66).toBeCloseTo(
      Number.parseFloat(tail.style.left) - (6 * 3_600 * PLOT_WIDTH) / (180 * DAY),
    )
  })

  it('moves a grip with the keyboard', () => {
    mountThreeDays()
    const head = grip('head')
    const key = (init: KeyboardEventInit): void => {
      head.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }))
      flushSync()
    }

    key({ key: 'ArrowRight' })
    expect(gripValue('head')).toBe(3_600)
    key({ key: 'ArrowRight', shiftKey: true })
    expect(gripValue('head')).toBe(39_600)
    key({ key: 'End' })
    expect(gripValue('head')).toBe(THREE_DAYS - 6 * 3_600)
    key({ key: 'Escape' })
    expect(gripValue('head')).toBe(0)
    expect(grip('tail').getAttribute('aria-valuetext')).not.toBe('')
  })

  it('walks the data points with the keyboard and announces them', () => {
    mountThreeDays()
    const chart = document.querySelector('svg[role="img"]')
    if (!(chart instanceof SVGSVGElement)) throw new Error('missing chart')

    chart.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowLeft' }))
    flushSync()

    const crosshair = chart.querySelector('line[data-crosshair]')
    expect(crosshair).not.toBeNull()
    // The newest bucket holds its level out to `to`, so the last readable point is the right edge.
    expect(Number(crosshair?.getAttribute('x1'))).toBeCloseTo(px(THREE_DAYS), 0)
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toContain('correct')
  })

  it('keeps the areas touching both plot edges inside a window', () => {
    mountThreeDays()
    preset('1d').click()
    flushSync()

    const line = document.querySelector('svg[role="img"] path[stroke="var(--chart-correct)"]')
    const d = line?.getAttribute('d') ?? ''
    expect(Number(/^M([^,]+)/.exec(d)?.[1])).toBeCloseTo(PLOT_LEFT, 0)
    expect(Number(/L([^,]+),[^L]*$/.exec(d)?.[1])).toBeCloseTo(PLOT_LEFT + PLOT_WIDTH, 0)
  })
})

describe('motion', () => {
  const DAY = 86_400
  const THREE_DAYS = 3 * DAY
  const mountThreeDays = (): void => {
    mounted = mount(ProgressPaceChart, {
      target: document.body,
      props: {
        buckets: Array.from({ length: 72 }, (_, hour) => bucket(3_600, hour * 3_600)),
        resolution: 3_600,
        from: 0,
        to: THREE_DAYS,
        anchorCorrect: 72,
        anchorMismatched: 0,
      },
    })
    flushSync()
  }
  const timeLabels = (): (string | undefined)[] =>
    [...document.querySelectorAll('text[data-axis="time"]')].map((label) =>
      label.textContent?.trim(),
    )

  it('wipes the series in on load and fades a pace line in and out as it is toggled', () => {
    mountThreeDays()

    expect(document.querySelector('svg[role="img"] g.chart-reveal')).not.toBeNull()
    expect(document.querySelector('path[data-pace-window="2h"]')).toBeNull()

    paceToggle('2h').click()
    flushSync()
    expect(document.querySelector('path[data-pace-window="2h"]')).not.toBeNull()

    paceToggle('2h').click()
    flushSync()
    expect(document.querySelector('path[data-pace-window="2h"]')).toBeNull()
  })

  it('tweens the window into place instead of snapping when motion is allowed', async () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: false } as MediaQueryList)
    mountThreeDays()
    const before = timeLabels()
    const head = document.querySelector('[data-handle="head"]')

    document.querySelector<HTMLButtonElement>('button[data-range-preset="1d"]')?.click()
    flushSync()

    // The controls report the target immediately; the drawing catches up over the tween.
    expect(head?.getAttribute('aria-valuenow')).toBe(String(2 * DAY))
    expect(timeLabels()).toEqual(before)

    await new Promise((resolve) => setTimeout(resolve, 800))
    flushSync()
    expect(timeLabels()).not.toEqual(before)
  })

  it('keeps a plot drag on the displayed domain while a refit is moving', () => {
    const media = { matches: false }
    vi.spyOn(window, 'matchMedia').mockReturnValue(media as MediaQueryList)
    mountThreeDays()
    const chart = document.querySelector('svg[role="img"]')
    if (!(chart instanceof SVGSVGElement)) throw new Error('missing chart')
    chart.getBoundingClientRect = () => ({ left: 0, top: 0, right: 640, bottom: 240 }) as DOMRect
    const px = (t: number): number => 48 + (t / THREE_DAYS) * 544
    const pointer = (type: string, init: PointerEventInit): PointerEvent =>
      new PointerEvent(type, { bubbles: true, ...init })

    document.querySelector<HTMLButtonElement>('button[data-range-preset="1d"]')?.click()
    flushSync()
    chart.dispatchEvent(
      pointer('pointerdown', { pointerId: 1, clientX: px(DAY / 2), clientY: 100 }),
    )
    window.dispatchEvent(
      pointer('pointermove', { pointerId: 1, clientX: px(1.5 * DAY), clientY: 100 }),
    )
    // Happy DOM has no Web Animations API. Keep the refit animated, then cut only this exit.
    media.matches = true
    window.dispatchEvent(
      pointer('pointerup', { pointerId: 1, clientX: px(1.5 * DAY), clientY: 100 }),
    )
    flushSync()

    expect(document.querySelector('[data-handle="head"]')?.getAttribute('aria-valuenow')).toBe(
      String(DAY / 2),
    )
    expect(document.querySelector('[data-handle="tail"]')?.getAttribute('aria-valuenow')).toBe(
      String(1.5 * DAY),
    )
  })

  it('moves the window under a brush drag at once while the axis top keeps gliding', async () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: false } as MediaQueryList)
    mountThreeDays()
    const labelsBefore = timeLabels()
    // The first gridline is the lowest tick. Its y follows the drawn axis top: with the whole
    // history the top is 74.88 (72 px plus headroom); inside the first day it settles at 26.
    const firstGridline = (): number =>
      Number(document.querySelector('svg[role="img"] line')?.getAttribute('y1'))
    const plotBottom = 240 - 22
    const plotHeight = 240 - 18 - 22
    const px = (t: number): number => 48 + (t / THREE_DAYS) * 544
    const pointer = (type: string, init: PointerEventInit): PointerEvent =>
      new PointerEvent(type, { bubbles: true, ...init })

    document
      .querySelector('[data-handle="tail"]')
      ?.dispatchEvent(pointer('pointerdown', { clientX: px(THREE_DAYS), clientY: 300 }))
    window.dispatchEvent(pointer('pointermove', { clientX: px(DAY), clientY: 300 }))
    // A browser flushes between the move and the release; do the same here.
    flushSync()
    window.dispatchEvent(pointer('pointerup', { clientX: px(DAY), clientY: 300 }))
    flushSync()

    expect(timeLabels()).not.toEqual(labelsBefore)
    expect(firstGridline()).toBeCloseTo(plotBottom - (5 / 74.88) * plotHeight, 0)

    await new Promise((resolve) => setTimeout(resolve, 800))
    flushSync()
    expect(firstGridline()).toBeCloseTo(plotBottom - (5 / 26) * plotHeight, 0)
  })
})
