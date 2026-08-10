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
  it('emits a nonempty, decorative Material-symbol SVG for every declared icon', () => {
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

    for (const name of names) {
      const svg = icon(name, 'size-4') as unknown as TestElement
      expect(svg.attributes.get('viewBox')).toBe('0 -960 960 960')
      expect(svg.attributes.get('class')).toBe('size-4')
      expect(svg.attributes.get('aria-hidden')).toBe('true')
      expect(svg.children[0]?.attributes.get('d')?.length).toBeGreaterThan(20)
    }
  })
})
