// @vitest-environment happy-dom
import { type HistoryBucket, seconds } from '@caelestis/shared'
import { flushSync, mount, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ProgressPaceChart from './ProgressPaceChart.svelte'

let mounted: ReturnType<typeof mount> | null = null
const stored = new Map<string, string>()

beforeEach(() => {
  stored.clear()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  })
})

afterEach(async () => {
  if (mounted !== null) await unmount(mounted)
  mounted = null
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
    const paceBuckets = [3_600, 4_500, 5_400, 6_300, 7_200, 8_100].map((start) =>
      bucket(900, start),
    )

    mounted = mount(ProgressPaceChart, {
      target: document.body,
      props: {
        buckets,
        paceBuckets,
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
})
