// @vitest-environment happy-dom
import { type HistoryBucket, type PainterHistoryBucket, seconds } from '@caelestis/shared'
import { flushSync, mount, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ProgressPaceChart from './ProgressPaceChart.svelte'

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

const painterBucket = (
  wplaceUserId: number,
  bucketStart: number,
  counts: Partial<Pick<PainterHistoryBucket, 'placed' | 'correct' | 'repairs'>> = {},
  displayName = `painter ${wplaceUserId}`,
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

const mountChart = (painters: readonly PainterHistoryBucket[]): void => {
  mounted = mount(ProgressPaceChart, {
    target: document.body,
    props: {
      buckets: [templateBucket(0), templateBucket(12 * HOUR)],
      resolution: 900,
      from: 0,
      to: TO,
      anchorCorrect: 10,
      anchorMismatched: 0,
      painterHistory: { resolution: 900, coverageStart: seconds(0), buckets: painters },
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
  it('draws the leading painters for every enabled window on the shared axis', () => {
    stored.set('caelestis:pace-windows', JSON.stringify(['1h', '6h']))
    const crowd = Array.from({ length: 7 }, (_, index) =>
      painterBucket(index + 1, 6 * HOUR, { placed: 100 - index, correct: 100 - index }),
    )
    mountChart(crowd)

    expect(lines().sort()).toEqual([1, 2, 3, 4, 5].flatMap((id) => [`${id}:1h`, `${id}:6h`]).sort())
    const line = document.querySelector('path[data-painter-line="1"][data-pace-window="1h"]')
    expect(line?.getAttribute('stroke')).toMatch(/^oklch\(var\(--painter-l\)/)
    expect(line?.getAttribute('d')).toMatch(/^M/)
    expect(chart().getAttribute('aria-label')).toContain('5 of 7 painters')
  })

  it('follows the window toggles and the metric switch', () => {
    stored.set('caelestis:pace-windows', JSON.stringify(['1h']))
    mountChart([painterBucket(1, 6 * HOUR, { placed: 8, correct: 2, repairs: 0 })])
    expect(lines()).toEqual(['1:1h'])
    const placedPath = document.querySelector('path[data-painter-line="1"]')?.getAttribute('d')

    const toggle = document.querySelector<HTMLButtonElement>('button[data-pace-toggle="6h"]')
    toggle?.click()
    flushSync()
    expect(lines().sort()).toEqual(['1:1h', '1:6h'])

    document.querySelector<HTMLButtonElement>('button[data-painter-metric="correct"]')?.click()
    flushSync()
    expect(stored.get('caelestis:painter-metric')).toBe(JSON.stringify('correct'))
    expect(document.querySelector('path[data-painter-line="1"]')?.getAttribute('d')).not.toBe(
      placedPath,
    )
    expect(chart().getAttribute('aria-label')).toContain('correct pixels pace lines')
  })

  it('announces each painter’s pace on the keyboard walk and lists it in the tooltip', () => {
    stored.set('caelestis:pace-windows', JSON.stringify(['1h']))
    mountChart([painterBucket(1, 6 * HOUR, { placed: 60, correct: 60, repairs: 0 }, 'Ada')])
    key({ key: 'ArrowLeft' })
    expect(announced()).toContain('Ada 1h placed pixels')
    expect(document.body.textContent).toContain('Ada 1h')
    expect(document.body.textContent).toContain('px/h')
  })

  it('keeps a painter’s colour when the scope reorders them', async () => {
    mountChart([painterBucket(2, HOUR), painterBucket(3, HOUR, { placed: 9, correct: 9 })])
    const stroke = document.querySelector('path[data-painter-line="2"]')?.getAttribute('stroke')
    if (mounted !== null) await unmount(mounted)
    mounted = null
    document.body.replaceChildren()
    mountChart([painterBucket(2, HOUR, { placed: 50, correct: 50 })])
    expect(document.querySelector('path[data-painter-line="2"]')?.getAttribute('stroke')).toBe(
      stroke,
    )
  })

  it('offers the painters in a searchable picker whose rows toggle', async () => {
    stored.set('caelestis:pace-windows', JSON.stringify(['1h']))
    const crowd = Array.from({ length: 8 }, (_, index) =>
      painterBucket(
        index + 1,
        6 * HOUR,
        { placed: 100 - index, correct: 100 - index },
        `Painter ${index + 1}`,
      ),
    )
    mountChart([...crowd, painterBucket(42, 6 * HOUR, { placed: 1, correct: 1 }, 'Ada Lovelace')])
    expect(lines()).toHaveLength(5)

    const input = search()
    expect(input.placeholder).toBe('5 painters')
    input.focus()
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }))
    input.value = 'ada'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    flushSync()
    await vi.waitFor(() =>
      expect(document.querySelectorAll('[data-painter-option]')).toHaveLength(1),
    )
    expect(document.querySelector('[data-painter-option="42"]')?.textContent).toContain(
      'Ada Lovelace',
    )
    // Bits selects on pointerup, so a pointerdown on the trigger can release on an item.
    document
      .querySelector('[data-painter-option="42"]')
      ?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse' }))
    flushSync()
    await vi.waitFor(() => expect(lines()).toContain('42:1h'))
    expect(lines()).toHaveLength(6)
  })

  it('draws nothing painter-specific without painter history', () => {
    mounted = mount(ProgressPaceChart, {
      target: document.body,
      props: {
        buckets: [templateBucket(0)],
        resolution: 900,
        from: 0,
        to: TO,
        anchorCorrect: 5,
        anchorMismatched: 0,
      },
    })
    flushSync()
    expect(document.querySelector('[data-painter-search]')).toBeNull()
    expect(lines()).toEqual([])
  })
})
