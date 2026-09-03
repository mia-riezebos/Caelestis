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

describe('rolling pace retention', () => {
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

    const buttons = [...document.querySelectorAll('button')]
    const paceWindow = (label: string): HTMLButtonElement => {
      const found = buttons.find((button) => button.textContent?.trim() === label)
      if (!(found instanceof HTMLButtonElement)) throw new Error(`missing ${label} pace button`)
      return found
    }

    expect(paceWindow('30m').disabled).toBe(false)
    expect(paceWindow('1h').disabled).toBe(false)
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

    const hoverLine = [...chart.querySelectorAll('line')].find(
      (line) => line.getAttribute('class') === 'stroke-base-content/25',
    )
    expect(Number(hoverLine?.getAttribute('x1'))).toBe(firstPaceX)
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
    const brush = document.querySelector('svg[role="slider"]')

    expect(shortLine?.getAttribute('data-series-start')).toBe('73800')
    expect(coarseLine?.getAttribute('data-series-start')).toBe('21600')
    expect(shortLine?.getAttribute('d')).toMatch(/^M/)
    expect(coarseLine?.getAttribute('d')).toMatch(/^M/)
    expect(brush?.getAttribute('aria-valuemin')).toBe('0')
    expect(brush?.getAttribute('aria-valuemax')).toBe(String(to))
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

  it('distinguishes sub-day ticks across a multi-day range', () => {
    mounted = mount(ProgressPaceChart, {
      target: document.body,
      props: {
        buckets: [bucket(3_600, 0)],
        resolution: 3_600,
        from: 0,
        to: 3.5 * 86_400,
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
    mounted = mount(ProgressPaceChart, {
      target: document.body,
      props: {
        buckets: [bucket(21_600, 0)],
        resolution: 21_600,
        from: 0,
        to: 3 * 365 * 86_400,
        anchorCorrect: 1,
        anchorMismatched: 0,
      },
    })
    flushSync()

    const labels = [...document.querySelectorAll('text[data-axis="time"]')].map(
      (label) => label.textContent?.trim() ?? '',
    )
    expect(labels.length).toBeGreaterThan(1)
    expect(labels.every((label) => /19(?:70|71|72|73)/.test(label))).toBe(true)
  })
})
