import { describe, expect, it } from 'vitest'
import {
  addLocalTemplate,
  localTemplates,
  moveLocalTemplate,
  removeLocalTemplate,
  templateById,
} from '../src/templates/local-store.js'

const imported = (id: string) => ({
  id,
  name: 'Move me',
  source: 'wplace' as const,
  originX: 0,
  originY: 0,
  width: 2,
  height: 2,
  indices: new Uint8Array([1, 2, 3, 4]),
  moved: 0,
  opaque: 4,
})

describe('local template moves', () => {
  it('commits the newest position and refuses a move after deletion', async () => {
    const id = `move-${crypto.randomUUID()}`
    await addLocalTemplate(imported(id), undefined, true)
    await Promise.all([moveLocalTemplate(id, 10, 20), moveLocalTemplate(id, 30, 40)])
    expect(templateById(id)).toMatchObject({ originX: 30, originY: 40 })
    expect(await removeLocalTemplate(id)).toBe(true)
    expect(await moveLocalTemplate(id, 50, 60)).toBe(false)
    expect(localTemplates().some((template) => template.id === id)).toBe(false)
  })
})
