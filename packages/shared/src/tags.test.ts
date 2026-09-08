import { describe, expect, it } from 'vitest'
import { parseTemplateTags, tagName, tagNameKey } from './tags.js'

describe('template tags', () => {
  it('normalizes names and rejects blank, oversized, and invisible names', () => {
    expect(tagName('  Cafe\u0301  ')).toBe('Café')
    expect(tagNameKey('CAFÉ')).toBe(tagNameKey('Cafe\u0301'))
    for (const name of [null, '', ' ', 'x'.repeat(65), 'a\u0000b', 'a\u200bb'])
      expect(tagName(name)).toBeNull()
  })
  it('rejects duplicate identities and names at the wire boundary', () => {
    const tag = { id: '01890f3a-6b7c-7def-8123-456789abcdef', name: 'Repair' }
    expect(parseTemplateTags([tag])).toEqual([tag])
    expect(parseTemplateTags([tag, tag])).toBeNull()
    expect(
      parseTemplateTags([tag, { id: '01890f3a-6b7c-7def-8123-456789abcdee', name: 'REPAIR' }]),
    ).toBeNull()
    expect(parseTemplateTags([{ ...tag, name: ' Repair ' }])).toBeNull()
  })
})
