// @vitest-environment happy-dom
import { type ContributionDay, seconds } from '@caelestis/shared'
import { flushSync, mount, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PainterPaceChart from './PainterPaceChart.svelte'

const DAY = 86_400
const PLOT_LEFT = 48
const PLOT_WIDTH = 640 - 48 - 16
const BASELINE = 240 - 22

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
  document.body.replaceChildren()
})

const row = (
  wplaceUserId: number,
  day: number,
  counts: Partial<Pick<ContributionDay, 'placed' | 'correct' | 'repairs'>> = {},
  displayName = `painter ${wplaceUserId}`,
): ContributionDay => ({
  wplaceUserId,
  displayName,
  templateId: 'template',
  day: seconds(day * DAY),
  placed: counts.placed ?? 0,
  correct: counts.correct ?? 0,
  repairs: counts.repairs ?? 0,
})

const mountChart = (
  days: readonly ContributionDay[],
  props: Partial<{ from: number; to: number; coverageFrom: number; live: boolean }> = {},
): void => {
  mounted = mount(PainterPaceChart, {
    target: document.body,
    props: { days, from: 0, to: 3 * DAY, coverageFrom: 0, ...props },
  })
  flushSync()
}

const chart = (): SVGSVGElement => {
  const found = document.querySelector('svg[role="img"]')
  if (!(found instanceof SVGSVGElement)) throw new Error('missing chart')
  found.getBoundingClientRect = () => ({ left: 0, right: 640, top: 0, bottom: 240 }) as DOMRect
  return found
}
const line = (wplaceUserId: number): SVGPathElement | null => {
  const found = document.querySelector(`path[data-painter-line="${wplaceUserId}"]`)
  return found instanceof SVGPathElement ? found : null
}
const lineIds = (): number[] =>
  [...document.querySelectorAll('path[data-painter-line]')].map((path) =>
    Number(path.getAttribute('data-painter-line')),
  )
const vertices = (wplaceUserId: number): [number, number][] => {
  const path = line(wplaceUserId)
  if (path === null) throw new Error(`missing line for painter ${wplaceUserId}`)
  return [...(path.getAttribute('d') ?? '').matchAll(/[ML]([\d.]+),([\d.]+)/g)].map((match) => [
    Number(match[1]),
    Number(match[2]),
  ])
}
const remount = async (): Promise<void> => {
  if (mounted !== null) await unmount(mounted)
  mounted = null
  document.body.replaceChildren()
}
const button = (selector: string): HTMLButtonElement => {
  const found = document.querySelector(selector)
  if (!(found instanceof HTMLButtonElement)) throw new Error(`missing ${selector}`)
  return found
}
const key = (init: KeyboardEventInit): void => {
  chart().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }))
  flushSync()
}
const announced = (): string => document.querySelector('[aria-live="polite"]')?.textContent ?? ''
const px = (t: number, from: number, to: number): number =>
  PLOT_LEFT + ((t - from) / (to - from)) * PLOT_WIDTH

describe('series', () => {
  it('draws one zero-filled line per served painter and holds today out to the right edge', () => {
    mountChart([row(1, 0, { placed: 10 }), row(1, 2, { placed: 5 }), row(2, 1, { placed: 4 })])

    expect(lineIds().sort()).toEqual([1, 2])
    const points = vertices(1)
    expect(points.map(([x]) => x)).toEqual([
      px(0, 0, 3 * DAY),
      px(DAY, 0, 3 * DAY),
      px(2 * DAY, 0, 3 * DAY),
      PLOT_LEFT + PLOT_WIDTH,
    ])
    // The missing middle day sits on the baseline instead of on a line between its neighbours.
    expect(points[1]?.[1]).toBe(BASELINE)
    expect(points[2]?.[1]).toBe(points[3]?.[1])
    expect(points[0]?.[1]).toBeLessThan(points[2]?.[1] ?? 0)
  })

  it('only draws painters who are in the served rows', () => {
    mountChart([row(1, 0, { placed: 10 })])
    expect(lineIds()).toEqual([1])
    expect(document.querySelectorAll('[data-painter-toggle]')).toHaveLength(1)
    expect(document.body.textContent).not.toContain('user 2')
  })

  it('shows history before the fetched coverage as unavailable rather than as zero', () => {
    mountChart([row(1, 5, { placed: 10 })], { from: 0, to: 7 * DAY, coverageFrom: 4 * DAY + 1 })

    const note = document.querySelector('[data-unavailable-before]')
    expect(note?.getAttribute('data-unavailable-before')).toBe(String(4 * DAY))
    expect(note?.textContent).toContain('no longer available')
    const points = vertices(1)
    expect(points[0]?.[0]).toBe(PLOT_LEFT)
    expect(points).toHaveLength(4)
  })

  it('renders an empty state when the server served no painters', () => {
    mountChart([])
    expect(document.querySelector('svg[role="img"]')).toBeNull()
    expect(document.body.textContent).toContain('No shared painter activity')
  })
})

describe('metric', () => {
  it('switches between placed, correct, and repairs per day and remembers the choice', () => {
    mountChart([
      row(1, 0, { placed: 10, correct: 2, repairs: 1 }),
      row(1, 1, { placed: 10, correct: 2, repairs: 1 }),
    ])

    expect(button('[data-painter-metric="placed"]').getAttribute('aria-pressed')).toBe('true')
    expect(document.body.textContent).toContain('px/day')
    for (const label of document.querySelectorAll('text[aria-label]')) {
      expect(label.getAttribute('aria-label')).toMatch(/pixels? per day$/)
    }
    const placedY = vertices(1)[0]?.[1]

    button('[data-painter-metric="correct"]').click()
    flushSync()
    expect(button('[data-painter-metric="correct"]').getAttribute('aria-pressed')).toBe('true')
    expect(stored.get('caelestis:painter-metric')).toBe(JSON.stringify('correct'))
    // The axis re-fits to the smaller metric, so the first vertex keeps its place near the top.
    expect(vertices(1)[0]?.[1]).toBeCloseTo(placedY ?? 0, 0)
    expect(chart().getAttribute('aria-label')).toContain('correct pixels')

    button('[data-painter-metric="repairs"]').click()
    flushSync()
    expect(chart().getAttribute('aria-label')).toContain('repaired pixels')
  })
})

describe('selection and colours', () => {
  const crowd = (count: number): ContributionDay[] =>
    Array.from({ length: count }, (_, index) =>
      row(index + 1, 0, { placed: 100 - index, correct: 100 - index }),
    )

  it('draws a bounded set of leading painters and lets the legend show the rest', () => {
    mountChart(crowd(12))

    expect(lineIds()).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(document.querySelectorAll('[data-painter-toggle]')).toHaveLength(8)
    const more = button('[data-legend-more]')
    expect(more.textContent?.trim()).toBe('+4 more')
    more.click()
    flushSync()
    expect(document.querySelectorAll('[data-painter-toggle]')).toHaveLength(12)
    expect(button('[data-painter-toggle="12"]').getAttribute('aria-pressed')).toBe('false')

    button('[data-painter-toggle="12"]').click()
    button('[data-painter-toggle="1"]').click()
    flushSync()
    expect(lineIds()).toEqual([2, 3, 4, 5, 6, 7, 8, 12])
    expect(button('[data-painter-toggle="1"]').getAttribute('aria-pressed')).toBe('false')

    // Collapsing keeps the painter who was switched on in the legend.
    button('[data-legend-more]').click()
    flushSync()
    expect(document.querySelector('[data-painter-toggle="12"]')).not.toBeNull()
  })

  it('keeps a painter’s colour across metric, range, and scope changes', async () => {
    mountChart(crowd(3), { to: 40 * DAY })
    const stroke = line(2)?.getAttribute('stroke')
    expect(stroke).toMatch(/^oklch\(var\(--painter-l\) var\(--painter-c\) [\d.]+\)$/)
    expect(stroke).not.toBe(line(1)?.getAttribute('stroke'))

    button('[data-painter-metric="correct"]').click()
    button('[data-range-preset="7d"]').click()
    flushSync()
    expect(line(2)?.getAttribute('stroke')).toBe(stroke)

    // In another scope the same painter ranks last, and still wears the same colour.
    await remount()
    mountChart([row(2, 0, { placed: 1, correct: 1 }), row(9, 0, { placed: 50, correct: 50 })])
    expect(lineIds()).toEqual([9, 2])
    expect(line(2)?.getAttribute('stroke')).toBe(stroke)
  })
})

describe('window', () => {
  it('offers presets only when narrower than the history and zooms to them', () => {
    mountChart([row(1, 0, { placed: 1 }), row(1, 39, { placed: 1 })], { to: 40 * DAY })
    expect(document.querySelector('[data-range-preset="1d"]')).toBeNull()
    expect(document.querySelector('[data-range-preset="30d"]')).not.toBeNull()
    expect(button('[data-range-preset="all"]').getAttribute('aria-pressed')).toBe('true')

    button('[data-range-preset="7d"]').click()
    flushSync()
    expect(button('[data-range-preset="7d"]').getAttribute('aria-pressed')).toBe('true')
    const points = vertices(1)
    expect(points[0]?.[0]).toBeCloseTo(PLOT_LEFT, 0)
    expect(points[points.length - 1]?.[0]).toBeCloseTo(PLOT_LEFT + PLOT_WIDTH, 0)
    // Seven day starts, the first on the left edge, plus today's level held to the right edge.
    expect(points).toHaveLength(8)
  })

  it('hides presets that would not fit a short history', () => {
    mountChart([row(1, 0, { placed: 1 })])
    expect(document.querySelectorAll('[data-range-preset]')).toHaveLength(1)
  })

  it('zooms to a plot drag, snapped to whole days, and resets on double-click', () => {
    mountChart([row(1, 0, { placed: 1 }), row(1, 9, { placed: 1 })], { to: 10 * DAY })
    const pointer = (type: string, init: PointerEventInit): PointerEvent =>
      new PointerEvent(type, { bubbles: true, ...init })
    const plot = chart()
    const at = (t: number): number => px(t, 0, 10 * DAY)

    plot.dispatchEvent(pointer('pointerdown', { clientX: at(2.4 * DAY), clientY: 100 }))
    window.dispatchEvent(pointer('pointermove', { clientX: at(6.6 * DAY), clientY: 100 }))
    flushSync()
    expect(document.querySelector('[data-plot-selection]')).not.toBeNull()
    window.dispatchEvent(pointer('pointerup', { clientX: at(6.6 * DAY), clientY: 100 }))
    flushSync()

    expect(chart().getAttribute('aria-label')).toContain('Jan 3')
    expect(document.querySelectorAll('[data-plot-selection]')).toHaveLength(0)
    const points = vertices(1)
    // Days 2 through 7 inclusive: six vertices, the first and last on the plot edges.
    expect(points).toHaveLength(6)
    expect(points[0]?.[0]).toBe(PLOT_LEFT)

    plot.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    flushSync()
    expect(vertices(1)).toHaveLength(11)
  })
})

describe('keyboard and hover', () => {
  const mountTwo = (): void =>
    mountChart([
      row(1, 0, { placed: 10, correct: 8 }, 'Ada'),
      row(1, 1, { placed: 20, correct: 16 }, 'Ada'),
      row(2, 1, { placed: 5, correct: 5 }, 'Bo'),
    ])

  it('walks days and painters with the keyboard and announces each point', () => {
    mountTwo()
    key({ key: 'ArrowLeft' })
    expect(document.querySelector('line[data-crosshair]')).not.toBeNull()
    expect(announced()).toContain('Jan 3')
    expect(announced()).toContain('Ada 0 placed pixels per day')
    expect(announced()).toContain('Bo 0 placed pixels per day')

    key({ key: 'ArrowLeft' })
    expect(announced()).toBe('Jan 2, Ada 20 placed pixels per day, Bo 5 placed pixels per day')

    key({ key: 'ArrowDown' })
    expect(announced()).toBe('Ada, Jan 2, 20 placed pixels per day')
    expect(line(1)?.getAttribute('stroke-width')).toBe('2.5')
    expect(line(2)?.getAttribute('stroke-opacity')).toBe('0.3')
    key({ key: 'ArrowDown' })
    expect(announced()).toBe('Bo, Jan 2, 5 placed pixels per day')
    key({ key: 'ArrowLeft' })
    expect(announced()).toBe('Bo, Jan 1, 0 placed pixels per day')
    key({ key: 'ArrowUp' })
    expect(announced()).toBe('Ada, Jan 1, 10 placed pixels per day')
    key({ key: 'ArrowUp' })
    expect(announced()).toBe('Jan 1, Ada 10 placed pixels per day, Bo 0 placed pixels per day')

    key({ key: 'Escape' })
    expect(document.querySelector('line[data-crosshair]')).toBeNull()
  })

  it('reads the metric through the live region after a switch', () => {
    mountTwo()
    button('[data-painter-metric="correct"]').click()
    flushSync()
    key({ key: 'End' })
    key({ key: 'ArrowLeft' })
    expect(announced()).toContain('Ada 16 correct pixels per day')
  })

  it('snaps the pointer to a day and flips the tooltip near the right edge', () => {
    mountTwo()
    const plot = chart()
    plot.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, clientX: px(DAY, 0, 3 * DAY) + 5 }),
    )
    flushSync()
    const tooltip = document.querySelector<HTMLElement>('[data-painter-tooltip]')
    expect(tooltip?.textContent).toContain('Jan 2')
    expect(tooltip?.textContent).toContain('Ada')
    expect(tooltip?.textContent).toContain('20 px/day')
    expect(tooltip?.style.left).not.toBe('')
    expect(tooltip?.style.right).toBe('')

    plot.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, clientX: PLOT_LEFT + PLOT_WIDTH }),
    )
    flushSync()
    const flipped = document.querySelector<HTMLElement>('[data-painter-tooltip]')
    expect(flipped?.style.right).not.toBe('')
    expect(flipped?.style.left).toBe('')

    plot.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }))
    flushSync()
    expect(document.querySelector('[data-painter-tooltip]')).toBeNull()
  })

  it('marks today as partial while the scope is live', () => {
    mountChart([row(1, 0, { placed: 10 }), row(1, 2, { placed: 3 })], {
      to: 2 * DAY + 3_600,
      live: true,
    })
    key({ key: 'End' })
    expect(announced()).toContain('Jan 3 (today so far)')
  })
})
