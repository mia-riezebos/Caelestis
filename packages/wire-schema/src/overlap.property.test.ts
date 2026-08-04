import { tileKey, WORLD_PIXELS } from '@wts/shared'
import { Schema } from 'effect'
import { expect, it } from 'vitest'
import { Manifest } from './index.js'

/**
 * The group-overlap sweep against a brute-force oracle.
 *
 * The sweep beats the obvious all-pairs algorithm by maintaining an invariant rather than comparing
 * everything — 1.6s against 150s at the manifest cap, though not the O(n log n) an earlier version
 * of this comment claimed: the ordered insert is a `splice`, so adversarial input makes it
 * quadratic too, just with a far smaller constant. Actives are ordered by `minY` and y-disjoint,
 * so a new span can only meet its two neighbours. Every line that maintains the ordering is
 * load-bearing, and unit tests pin shapes rather than the invariant — replacing the ordered insert
 * with a plain `push` passed the entire suite while silently accepting overlapping templates in
 * ~0.6% of random groups.
 *
 * Only a differential test pins it, so this is that test. The oracle is the all-pairs comparison the
 * sweep replaced, written out directly.
 */

const SERVER_ID = '01890f3a-6b7c-7def-8123-456789abcdef'
const NODE_ID = '01890f3a-6b7c-7def-8123-456789abcde0'
const HASH = 'a'.repeat(64)
const uuid = (index: number): string =>
  `01890f3a-6b7c-7def-8123-${index.toString(16).padStart(12, '0')}`

type Box = { minX: number; minY: number; maxX: number; maxY: number }

/** Deterministic PRNG, so a failure is reproducible from its seed alone. */
const rng = (seed: number) => () => {
  seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff
  return seed / 0x7fffffff
}

const xRanges = ({ minX, maxX }: Box): Array<[number, number]> =>
  minX < maxX
    ? [[minX, maxX]]
    : [
        [minX, WORLD_PIXELS],
        [0, maxX],
      ]

/** The all-pairs comparison the sweep replaced. */
const oracleHasOverlap = (boxes: readonly Box[]): boolean => {
  for (let left = 0; left < boxes.length; left += 1) {
    for (let right = left + 1; right < boxes.length; right += 1) {
      // biome-ignore lint/style/noNonNullAssertion: indices are inside the array
      const a = boxes[left]!
      // biome-ignore lint/style/noNonNullAssertion: indices are inside the array
      const b = boxes[right]!
      if (!(b.minY < a.maxY && a.minY < b.maxY)) continue
      const overlapsX = xRanges(a).some(([aStart, aEnd]) =>
        xRanges(b).some(([bStart, bEnd]) => bStart < aEnd && aStart < bEnd),
      )
      if (overlapsX) return true
    }
  }
  return false
}

/** Small coordinates, so boxes collide often and both wrapped and unwrapped shapes appear. */
const randomBox = (next: () => number): Box => {
  const span = 1 + Math.floor(next() * 6)
  const minY = Math.floor(next() * 8)
  const maxY = minY + 1 + Math.floor(next() * 6)
  if (next() < 0.25) {
    // Wrapped: minX > maxX, so this box covers two x ranges.
    const maxX = 1 + Math.floor(next() * 4)
    return { minX: WORLD_PIXELS - span, minY, maxX, maxY }
  }
  const minX = Math.floor(next() * 12)
  return { minX, minY, maxX: minX + span, maxY }
}

const decodes = (boxes: readonly Box[]): boolean => {
  const templates = boxes.map((bbox, index) => ({
    id: uuid(1_000 + index),
    nodeId: NODE_ID,
    name: 'T',
    version: uuid(500_000 + index),
    bbox,
    // The chunk must intersect the bbox and the totals must fit it, or a different rule rejects and
    // the comparison stops being about overlap at all.
    totalPixels: 1,
    chunks: [{ tile: tileKey({ x: Math.floor(bbox.minX / 1_000), y: 0 }), hash: HASH }],
    published: true,
    createdAt: 1_750_000_000_000,
  }))
  const tiles = [...new Set(templates.flatMap((t) => t.chunks.map((c) => c.tile)))]
  try {
    Schema.decodeUnknownSync(Manifest)({
      version: 'manifest-1',
      season: 1,
      server: { id: SERVER_ID, name: 'S', auth: 'none' },
      nodes: [{ id: NODE_ID, parentId: null, path: '/g', name: 'G', createdAt: 1_750_000_000_000 }],
      templates,
      tiles,
    })
    return true
  } catch {
    return false
  }
}

it('agrees with an all-pairs oracle on every generated group', () => {
  const next = rng(20_260_804)
  let compared = 0
  for (let trial = 0; trial < 3_000; trial += 1) {
    const count = 2 + Math.floor(next() * 8)
    const boxes = Array.from({ length: count }, () => randomBox(next))
    const expected = oracleHasOverlap(boxes)

    // Only a manifest the oracle calls overlap-free should decode. A manifest can still be rejected
    // for an unrelated reason, so a rejection alone proves nothing — the direction that matters is
    // that an overlapping group is never accepted.
    if (expected) {
      expect(decodes(boxes), `accepted an overlapping group: ${JSON.stringify(boxes)}`).toBe(false)
      compared += 1
    } else if (decodes(boxes)) {
      compared += 1
    }
  }
  // Guard against the generator drifting into shapes that never exercise the comparison.
  expect(compared).toBeGreaterThan(1_000)
})

it('accepts every group the oracle calls overlap-free', () => {
  // The false-reject direction, kept separate so a failure says which way the sweep is wrong.
  const next = rng(9_130_402)
  let accepted = 0
  for (let trial = 0; trial < 3_000; trial += 1) {
    const count = 2 + Math.floor(next() * 8)
    const boxes = Array.from({ length: count }, () => randomBox(next))
    if (oracleHasOverlap(boxes)) continue
    expect(decodes(boxes), `rejected a legal group: ${JSON.stringify(boxes)}`).toBe(true)
    accepted += 1
  }
  expect(accepted).toBeGreaterThan(200)
})
