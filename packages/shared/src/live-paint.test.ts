import { describe, expect, it } from 'vitest'
import { MAX_LIVE_MESSAGE_BYTES } from './live.js'
import {
  encodeLivePaintParts,
  LIVE_PAINT_ASSEMBLY_TTL_MS,
  LivePaintAssembler,
  MAX_LIVE_PAINT_BYTES,
} from './live-paint.js'
import type { LivePaintPart, PaintEvent } from './telemetry.js'
import { seconds } from './time.js'
import { uuidV7 } from './uuid.js'

const event = (pixels: number, displayName = '4dragonwings'): PaintEvent => ({
  eventId: uuidV7(),
  wplaceUserId: 2714778,
  displayName,
  season: 0,
  ts: seconds(1789162701),
  painted: pixels,
  tiles: [
    {
      x: 1,
      y: 2,
      pixels: {
        x: Array.from({ length: pixels }, (_, i) => i % 1000),
        y: Array.from({ length: pixels }, (_, i) => Math.floor(i / 1000)),
        colors: Array.from({ length: pixels }, () => 31),
      },
    },
  ],
})

const part = (changes: Partial<LivePaintPart> = {}): LivePaintPart => ({
  transferId: uuidV7(),
  eventId: uuidV7(),
  season: 0,
  index: 0,
  total: 2,
  chunk: '{',
  ...changes,
})

describe('paint report framing', () => {
  it.each(['4dragonwings', '💜'.repeat(128), '\\"\n'.repeat(85)])(
    'round-trips 100k pixels with name %s',
    (name) => {
      const original = event(100_000, name)
      const parts = encodeLivePaintParts(original, uuidV7())
      expect(parts.length).toBeGreaterThan(1)
      const assembler = new LivePaintAssembler()
      const owner = {}
      for (const [index, part] of parts.entries()) {
        const envelope = JSON.stringify({ type: 'paint-part', requestId: uuidV7(), ...part })
        expect(new TextEncoder().encode(envelope).byteLength).toBeLessThanOrEqual(
          MAX_LIVE_MESSAGE_BYTES,
        )
        const result = assembler.push(owner, part)
        if (index === parts.length - 1) expect(JSON.parse(result ?? '')).toEqual(original)
        else expect(result).toBeNull()
      }
    },
  )

  it('accepts identical duplicates but discards conflicting parts', () => {
    const assembler = new LivePaintAssembler()
    const owner = {}
    const first = part()
    expect(assembler.push(owner, first)).toBeNull()
    expect(assembler.push(owner, first)).toBeNull()
    expect(() => assembler.push(owner, { ...first, chunk: '[' })).toThrow('conflicting')
    expect(() => assembler.push(owner, { ...first, index: 1 })).toThrow('restart')
  })

  it('expires incomplete assemblies and lets a retry start over', () => {
    const assembler = new LivePaintAssembler()
    const owner = {}
    const first = part()
    assembler.push(owner, first, 0)
    expect(() =>
      assembler.push(owner, { ...first, index: 1, chunk: '}' }, LIVE_PAINT_ASSEMBLY_TTL_MS),
    ).toThrow('restart')
    expect(assembler.push(owner, first, LIVE_PAINT_ASSEMBLY_TTL_MS)).toBeNull()
    expect(
      assembler.push(owner, { ...first, index: 1, chunk: '}' }, LIVE_PAINT_ASSEMBLY_TTL_MS),
    ).toBe('{}')
  })

  it('bounds concurrent owners and releases disconnected owners', () => {
    const assembler = new LivePaintAssembler()
    const first = {}
    const fifth = {}
    for (const owner of [first, {}, {}, {}]) assembler.push(owner, part())
    expect(() => assembler.push(fifth, part())).toThrow('busy')
    assembler.discard(first)
    expect(assembler.push(fifth, part())).toBeNull()
  })

  it('shares the byte budget across owners and releases rejected transfers', () => {
    const assembler = new LivePaintAssembler()
    const owner = {}
    const first = part({ total: 2048, chunk: 'x'.repeat(64 * 1024) })
    for (let index = 0; index < MAX_LIVE_PAINT_BYTES / first.chunk.length; index++)
      assembler.push(owner, { ...first, index })
    expect(() => assembler.push({}, part())).toThrow('byte budget')
    expect(() => assembler.push(owner, { ...first, index: 128 })).toThrow('byte limit')
    expect(assembler.push({}, part())).toBeNull()
  })

  it.each([{ season: 1 }, { eventId: uuidV7() }, { total: 3 }, { index: 2, total: 3 }])(
    'rejects changed metadata or order: %o',
    (change) => {
      const assembler = new LivePaintAssembler()
      const owner = {}
      const first = part({ total: 3 })
      assembler.push(owner, first)
      const changed = 'total' in change && !('index' in change) ? { total: 4 } : change
      expect(() => assembler.push(owner, { ...first, ...changed })).toThrow()
    },
  )

  it('does not join parts belonging to different owners', () => {
    const assembler = new LivePaintAssembler()
    const first = part()
    assembler.push({}, first)
    expect(() => assembler.push({}, { ...first, index: 1 })).toThrow('restart')
  })

  it('retains complete-report reservations through accounting, disconnects, and expiry', () => {
    const assembler = new LivePaintAssembler()
    const owners = [{}, {}, {}, {}]
    const first = owners[0]
    if (first === undefined) throw new Error('fixture requires an owner')
    for (const owner of owners)
      expect(assembler.push(owner, part({ total: 1, chunk: '{}' }), 0)).toBe('{}')
    assembler.discard(first)
    expect(() => assembler.push(first, part(), LIVE_PAINT_ASSEMBLY_TTL_MS)).toThrow(
      'accounting is busy',
    )
    expect(() => assembler.push({}, part(), LIVE_PAINT_ASSEMBLY_TTL_MS)).toThrow('assembly is busy')
    assembler.finish(first)
    expect(assembler.push({}, part(), LIVE_PAINT_ASSEMBLY_TTL_MS)).toBeNull()
  })
})
