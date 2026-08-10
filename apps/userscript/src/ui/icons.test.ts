import { afterEach, describe, expect, it, vi } from 'vitest'
import { type IconName, icon } from './icons.js'

class TestElement {
  readonly attributes = new Map<string, string>()
  readonly children: TestElement[] = []

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  appendChild(child: TestElement): TestElement {
    this.children.push(child)
    return child
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('icons', () => {
  it('emits the stable Material-symbol path assigned to every declared icon', () => {
    vi.stubGlobal('document', { createElementNS: vi.fn(() => new TestElement()) })
    const names: IconName[] = [
      'extension',
      'settings',
      'close',
      'arrowBack',
      'search',
      'sort',
      'arrowUpward',
      'arrowDownward',
      'dragHandle',
      'caret',
      'folder',
      'image',
      'server',
      'createFolder',
      'uploadFile',
      'check',
      'rename',
      'trash',
    ]
    const expectedPathHashes: Partial<Record<IconName, number>> = {
      extension: 4_053_672_473,
      settings: 2_214_614_144,
      close: 2_893_230_536,
      arrowBack: 3_262_344_179,
      search: 744_388_370,
      sort: 2_288_028_837,
      arrowUpward: 2_465_923_461,
      arrowDownward: 3_862_644_523,
      dragHandle: 3_934_983_283,
      caret: 3_100_920_431,
      folder: 2_118_631_624,
      image: 2_097_672_284,
      server: 3_858_052_076,
      createFolder: 3_404_513_874,
      uploadFile: 3_064_132_360,
      check: 4_041_847_984,
      rename: 150_577_215,
      trash: 2_220_404_040,
    }

    const pathHash = (path: string): number => {
      let hash = 2_166_136_261
      for (const character of path) {
        hash ^= character.charCodeAt(0)
        hash = Math.imul(hash, 16_777_619)
      }
      return hash >>> 0
    }

    for (const name of names) {
      const svg = icon(name, 'size-4') as unknown as TestElement
      expect(svg.attributes.get('viewBox')).toBe('0 -960 960 960')
      expect(svg.attributes.get('class')).toBe('size-4')
      expect(svg.attributes.get('aria-hidden')).toBe('true')
      expect(pathHash(svg.children[0]?.attributes.get('d') ?? '')).toBe(expectedPathHashes[name])
    }
  })
})
