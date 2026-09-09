// @vitest-environment happy-dom
import {
  type HistoryBucket,
  type PainterHistoryBucket,
  type PainterTotal,
  seconds,
} from '@caelestis/shared'
import { flushSync, mount, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ProgressPaceChart from './ProgressPaceChart.svelte'
import type { PainterHistorySource } from './progress-pace.js'

const HOUR = 3_600
const TO = 24 * HOUR
let mounted: ReturnType<typeof mount> | null = null
const stored = new Map<string, string>()

beforeEach(() => {
  stored.clear()
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(640)
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

const templateBucket = (bucketStart: number, placed = 5): HistoryBucket => ({
  templateId: 'template',
  resolution: 900,
  bucketStart: seconds(bucketStart),
  placed,
  correct: placed,
  repairs: 0,
})

const painter = (wplaceUserId: number, displayName = `Painter ${wplaceUserId}`): PainterTotal => ({
  wplaceUserId,
  displayName,
  placed: 100 - wplaceUserId,
  correct: 100 - wplaceUserId,
  repairs: 0,
})

const painterBucket = (
  wplaceUserId: number,
  bucketStart: number,
  counts: Partial<Pick<PainterHistoryBucket, 'placed' | 'correct' | 'repairs'>> = {},
  displayName = `Painter ${wplaceUserId}`,
): PainterHistoryBucket => ({
  templateId: 'template',
  wplaceUserId,
  displayName,
  resolution: 900,
  bucketStart: seconds(bucketStart),
  placed: counts.placed ?? 4,
  correct: counts.correct ?? 3,
  repairs: counts.repairs ?? 1,
})

/** The same retained source for every enabled window, as the panel would fetch it. */
const sources = (
  windows: readonly ('1h' | '6h')[],
  buckets: readonly PainterHistoryBucket[],
): PainterHistorySource[] =>
  windows.map((window) => ({
    window,
    history: { resolution: 900, coverageStart: seconds(0), buckets },
  }))

const mountChart = (props: {
  painters?: readonly PainterTotal[]
  selectedPainters?: ReadonlySet<number>
  onTogglePainter?: (wplaceUserId: number) => void
  painterHistories?: readonly PainterHistorySource[]
}): void => {
  mounted = mount(ProgressPaceChart, {
    target: document.body,
    props: {
      buckets: [templateBucket(0), templateBucket(12 * HOUR)],
      resolution: 900,
      from: 0,
      to: TO,
      anchorCorrect: 10,
      anchorMismatched: 0,
      ...props,
    },
  })
  flushSync()
}

const lines = (): string[] =>
  [...document.querySelectorAll('path[data-painter-line]')].map(
    (path) => `${path.getAttribute('data-painter-line')}:${path.getAttribute('data-pace-window')}`,
  )
const chart = (): SVGSVGElement => {
  const found = document.querySelector('svg[role="img"]')
  if (!(found instanceof SVGSVGElement)) throw new Error('missing chart')
  found.getBoundingClientRect = () => ({ left: 0, right: 640, top: 0, bottom: 240 }) as DOMRect
  return found
}
const key = (init: KeyboardEventInit): void => {
  chart().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }))
  flushSync()
}
const announced = (): string => document.querySelector('[aria-live="polite"]')?.textContent ?? ''
const search = (): HTMLInputElement => {
  const found = document.querySelector('[data-painter-search]')
  if (!(found instanceof HTMLInputElement)) throw new Error('missing painter search')
  return found
}

describe('painter lines', () => {
  it('draws the selected painters for every enabled window on the shared axis', () => {
    stored.set('caelestis:pace-windows', JSON.stringify(['1h', '6h']))
    const crowd = [1, 2, 3, 4, 5, 6, 7].map((id) => painter(id))
    mountChart({
      painters: crowd,
      selectedPainters: new Set([1, 2, 3]),
      painterHistories: sources(
        ['1h', '6h'],
        [1, 2, 3].map((id) => painterBucket(id, 6 * HOUR)),
      ),
    })

    expect(lines().sort()).toEqual([1, 2, 3].flatMap((id) => [`${id}:1h`, `${id}:6h`]).sort())
    const line = document.querySelector('path[data-painter-line="1"][data-pace-window="1h"]')
    expect(line?.getAttribute('stroke')).toMatch(/^oklch\(var\(--painter-l\)/)
    expect(line?.getAttribute('d')).toMatch(/^M/)
    expect(chart().getAttribute('aria-label')).toContain('3 of 7 painters')
  })

  it('draws a window only from its own retained source and follows the metric switch', () => {
    stored.set('caelestis:pace-windows', JSON.stringify(['1h', '6h']))
    mountChart({
      painters: [painter(1)],
      selectedPainters: new Set([1]),
      painterHistories: sources(['1h'], [painterBucket(1, 6 * HOUR, { placed: 8, correct: 2 })]),
    })
    expect(lines()).toEqual(['1:1h'])
    const placedPath = document.querySelector('path[data-painter-line="1"]')?.getAttribute('d')

    document.querySelector<HTMLButtonElement>('button[data-painter-metric="correct"]')?.click()
    flushSync()
    expect(stored.get('caelestis:painter-metric')).toBe(JSON.stringify('correct'))
    expect(document.querySelector('path[data-painter-line="1"]')?.getAttribute('d')).not.toBe(
      placedPath,
    )
    expect(chart().getAttribute('aria-label')).toContain('correct pixels pace lines')
  })

  it('announces each painter’s pace on the keyboard walk and lists it in the tooltip', () => {
    stored.set('caelestis:pace-windows', JSON.stringify(['1h', '6h']))
    mountChart({
      painters: [painter(1, 'Ada')],
      selectedPainters: new Set([1]),
      painterHistories: sources(
        ['1h', '6h'],
        [painterBucket(1, 6 * HOUR, { placed: 60, correct: 60 }, 'Ada')],
      ),
    })
    key({ key: 'ArrowLeft' })
    expect(announced()).toContain('Ada 1h placed pixels')
    const tooltip = document.querySelector('[data-pace-tooltip]')
    const rows = tooltip?.querySelectorAll('[data-pace-row]')
    expect(rows).toHaveLength(2)
    expect(rows?.[0]?.textContent).toContain('All users')
    expect(rows?.[1]?.textContent?.match(/Ada/g)).toHaveLength(1)
    for (const row of rows ?? []) {
      expect(
        [...row.querySelectorAll('[data-pace-rate]')].map((rate) =>
          rate.getAttribute('data-pace-rate'),
        ),
      ).toEqual(['1h', '6h'])
    }
    expect(tooltip?.textContent).toContain('px/h')
  })

  it('keeps a painter’s colour when the scope reorders them', async () => {
    stored.set('caelestis:pace-windows', JSON.stringify(['1h']))
    mountChart({
      painters: [painter(3), painter(2)],
      selectedPainters: new Set([2, 3]),
      painterHistories: sources(['1h'], [painterBucket(2, HOUR), painterBucket(3, HOUR)]),
    })
    const stroke = document.querySelector('path[data-painter-line="2"]')?.getAttribute('stroke')
    if (mounted !== null) await unmount(mounted)
    mounted = null
    document.body.replaceChildren()
    mountChart({
      painters: [painter(2)],
      selectedPainters: new Set([2]),
      painterHistories: sources(['1h'], [painterBucket(2, HOUR)]),
    })
    expect(document.querySelector('path[data-painter-line="2"]')?.getAttribute('stroke')).toBe(
      stroke,
    )
  })

  it('offers the painters in a searchable picker whose rows toggle', async () => {
    stored.set('caelestis:pace-windows', JSON.stringify(['1h']))
    const onTogglePainter = vi.fn()
    const crowd = [1, 2, 3, 4, 5, 6, 7, 8].map((id) => painter(id))
    mountChart({
      painters: [...crowd, painter(42, 'Ada Lovelace')],
      selectedPainters: new Set([1, 2, 3, 4, 5]),
      onTogglePainter,
      painterHistories: sources(
        ['1h'],
        [1, 2, 3, 4, 5].map((id) => painterBucket(id, 6 * HOUR)),
      ),
    })
    expect(lines()).toHaveLength(5)

    // The legend holds a button; the search box lives in the popout it opens.
    const trigger = document.querySelector<HTMLButtonElement>('[data-painter-trigger]')
    expect(trigger?.textContent).toContain('5 of 9')
    expect(document.querySelector('[data-painter-search]')).toBeNull()
    trigger?.click()
    flushSync()
    await vi.waitFor(() => expect(document.querySelector('[data-painter-search]')).not.toBeNull())
    expect(document.querySelectorAll('[data-painter-option]')).toHaveLength(9)
    // The drawn state is read out as text: `aria-selected` belongs to the command cursor.
    const stateOf = (id: number): string | undefined =>
      document.querySelector(`[data-painter-option="${id}"] [data-painter-state]`)?.textContent
    expect(stateOf(1)).toBe('drawn')
    expect(stateOf(42)).toBe('not drawn')
    // The cursor starts on the pinned "All users" row, which spotlights nobody; each ArrowDown
    // moves the spotlight down the painters.
    const opacityOf = (id: number): string | null =>
      document.querySelector(`path[data-painter-line="${id}"]`)?.getAttribute('stroke-opacity') ??
      null
    await vi.waitFor(() =>
      expect(document.querySelector('[data-all-users][data-selected]')).not.toBeNull(),
    )
    expect(opacityOf(1)).toBe('0.9')
    expect(opacityOf(2)).toBe('0.9')
    search().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }))
    flushSync()
    await vi.waitFor(() => expect(opacityOf(2)).toBe('0.25'))
    expect(opacityOf(1)).toBe('0.9')
    search().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }))
    flushSync()
    await vi.waitFor(() => expect(opacityOf(2)).toBe('0.9'))
    expect(opacityOf(1)).toBe('0.25')

    const input = search()
    input.value = 'ada'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    flushSync()
    await vi.waitFor(() =>
      expect(document.querySelectorAll('[data-painter-option]')).toHaveLength(1),
    )
    expect(document.querySelector('[data-painter-option="42"]')?.textContent).toContain(
      'Ada Lovelace',
    )
    ;(document.querySelector('[data-painter-option="42"]') as HTMLElement).click()
    flushSync()
    await vi.waitFor(() => expect(onTogglePainter).toHaveBeenCalledWith(42))
    expect(onTogglePainter).toHaveBeenCalledTimes(1)
  })

  it('pins everyone’s pace at the top of the picker and toggles it with the painters', async () => {
    stored.set('caelestis:pace-windows', JSON.stringify(['1h']))
    mountChart({
      painters: [painter(1, 'Ada')],
      selectedPainters: new Set([1]),
      painterHistories: sources(['1h'], [painterBucket(1, 6 * HOUR)]),
    })
    const paceLines = (): number =>
      document.querySelectorAll('path[data-pace-window]:not([data-painter-line])').length
    expect(paceLines()).toBe(1)
    const trigger = document.querySelector<HTMLButtonElement>('[data-painter-trigger]')
    expect(trigger?.textContent).toContain('all users + Ada')
    trigger?.click()
    flushSync()
    await vi.waitFor(() => expect(document.querySelector('[data-all-users]')).not.toBeNull())
    // First row, and it stays put while the search narrows the painters.
    const rows = () => [...document.querySelectorAll('[data-all-users], [data-painter-option]')]
    expect(rows()[0]?.hasAttribute('data-all-users')).toBe(true)
    search().value = 'zzz'
    search().dispatchEvent(new Event('input', { bubbles: true }))
    flushSync()
    await vi.waitFor(() =>
      expect(document.querySelectorAll('[data-painter-option]')).toHaveLength(0),
    )
    expect(document.querySelector('[data-all-users] [data-painter-state]')?.textContent).toBe(
      'drawn',
    )

    ;(document.querySelector('[data-all-users]') as HTMLElement).click()
    flushSync()
    await vi.waitFor(() => expect(paceLines()).toBe(0))
    expect(lines()).toEqual(['1:1h'])
    expect(stored.get('caelestis:pace-all-users')).toBe('false')
    expect(document.querySelector('[data-all-users] [data-painter-state]')?.textContent).toBe(
      'not drawn',
    )
    expect(document.querySelector('[data-painter-trigger]')?.textContent).toContain('Ada')
    expect(document.querySelector('[data-painter-trigger]')?.textContent).not.toContain('all users')
  })

  it('offers everyone’s pace but no painter lines without painters', async () => {
    mountChart({})
    expect(lines()).toEqual([])
    const trigger = document.querySelector<HTMLButtonElement>('[data-painter-trigger]')
    expect(trigger?.textContent).toContain('all users')
    trigger?.click()
    flushSync()
    await vi.waitFor(() => expect(document.querySelector('[data-all-users]')).not.toBeNull())
    expect(document.querySelectorAll('[data-painter-option]')).toHaveLength(0)
    expect(document.body.textContent).toContain('No painters have reported yet')
  })
})
