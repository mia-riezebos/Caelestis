import { describe, expect, it } from 'vitest'
import {
  assignShortcutBinding,
  decodePresenceDraftMask,
  encodePresenceDraft,
  filterWork,
  flattenPath,
  isPresenceDraft,
  keyBindingFromStroke,
  keyBindingLabel,
  keyBindingMatches,
  keyBindingReleasedBy,
  parseTemplateFilters,
  planTimelapseTiles,
  quantiseRect,
  rectIntersection,
  rectsIntersect,
  regionDocumentPixels,
  regionPixelComponents,
  regionShapePixels,
  templateSurfaceKey,
  type WorkItem,
} from '../index.js'

const id = '018f4f2a-1234-7abc-8def-0123456789ab'

describe('coordination and geometry contracts', () => {
  it('validates and rasterises a subtractive region document', () => {
    const document = {
      items: [
        {
          id: 'outer',
          op: 'add' as const,
          shape: { kind: 'rectangle' as const, x: 0, y: 0, w: 3, h: 3 },
        },
        {
          id: 'cut',
          op: 'subtract' as const,
          shape: { kind: 'rectangle' as const, x: 1, y: 1, w: 1, h: 1 },
        },
      ],
    }
    expect(regionDocumentPixels(document)).toMatchObject({
      count: 8,
      mask: new Uint8Array([1, 1, 1, 1, 0, 1, 1, 1, 1]),
    })
    const pixels = regionShapePixels({ kind: 'ellipse', x: 0, y: 0, w: 3, h: 3 })
    expect(pixels).toMatchObject({ count: 9, mask: new Uint8Array(9).fill(1) })
    expect(regionPixelComponents(pixels).boxes).toHaveLength(1)
    const curve = flattenPath(
      [
        { x: 0, y: 0, out: { x: 4, y: 0 } },
        { x: 4, y: 4 },
      ],
      false,
    )
    expect(curve[0]).toEqual({ x: 0, y: 0 })
    expect(curve.at(-1)).toEqual({ x: 4, y: 4 })
    expect(curve.some(({ x, y }) => x > y)).toBe(true)
    expect(curve.every(({ x, y }) => x >= 0 && x <= 4 && y >= 0 && y <= 4)).toBe(true)
  })

  it('keeps draft masks structurally bounded and shortcut overrides conflict-free', () => {
    expect(isPresenceDraft({ rect: { x: 0, y: 0, w: 2, h: 2 }, pixels: 4 })).toBe(true)
    expect(isPresenceDraft({ rect: { x: 0, y: 0, w: 2, h: 2 }, pixels: -1 })).toBe(false)
    const binding = keyBindingFromStroke(
      { key: 'z', code: 'KeyZ', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false },
      'windows-linux',
    )
    expect(binding).toMatchObject({ key: 'z', command: true })
    expect(keyBindingLabel(binding!, 'windows-linux')).toContain('Ctrl')
    const changed = assignShortcutBinding({}, 'redo-paint', binding!)
    expect(changed.displaced).toContain('undo-paint')
    const draft = encodePresenceDraft([
      { x: 2, y: 3 },
      { x: 3, y: 3 },
    ])!
    expect(decodePresenceDraftMask(draft)).toEqual(new Uint8Array([1, 1]))
    expect(rectsIntersect({ x: 0, y: 0, w: 2, h: 2 }, { x: 2, y: 0, w: 1, h: 1 })).toBe(false)
    expect(rectIntersection({ x: 0, y: 0, w: 3, h: 3 }, { x: 2, y: 2, w: 3, h: 3 })).toEqual({
      x: 2,
      y: 2,
      w: 1,
      h: 1,
    })
    expect(quantiseRect({ x: 3, y: 5, w: 2, h: 3 })).toEqual({ x: 0, y: 0, w: 8, h: 8 })
  })

  it('filters work and plans only the union of captured tiles', () => {
    const item = (status: WorkItem['status']): WorkItem => ({
      id,
      season: 0,
      surface: { kind: 'world', allianceId: null },
      status,
      priority: 'normal',
      title: 'Tile',
      description: '',
      tags: [],
      blockerIds: [],
      nodeId: null,
      templateIds: [id],
      claimant: null,
      claimants: [],
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    })
    expect(filterWork([item('open'), item('completed')], { state: 'open' })).toHaveLength(1)
    expect(
      planTimelapseTiles([
        { minX: 0, minY: 0, maxX: 1000, maxY: 1000 },
        { minX: 999, minY: 0, maxX: 1001, maxY: 1 },
      ]),
    ).toEqual([
      { x: 2047, y: 0 },
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ])
  })

  it('keeps filter URL state and surface keys canonical', () => {
    expect(parseTemplateFilters({ source: ['local', 'unknown'], tags: [id, id] })).toMatchObject({
      source: ['local'],
      tags: [id],
    })
    expect(templateSurfaceKey({ kind: 'world', allianceId: null })).toBe('world')
  })

  it('retains a recorded physical shortcut across keyboard layouts and releases its key', () => {
    const stroke = {
      key: 'z',
      code: 'KeyZ',
      ctrlKey: false,
      metaKey: true,
      altKey: false,
      shiftKey: false,
    }
    const recorded = keyBindingFromStroke(stroke, 'mac')
    const changedLayout = keyBindingFromStroke({ ...stroke, key: 'y' }, 'mac')
    if (recorded === null || changedLayout === null) throw new Error('Expected command shortcuts')
    expect(keyBindingMatches(recorded, changedLayout)).toBe(true)
    expect(keyBindingMatches(recorded, { ...changedLayout, command: false })).toBe(false)
    expect(keyBindingReleasedBy(recorded, { key: 'y', code: 'KeyZ' })).toBe(true)
  })
})
