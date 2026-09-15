import { describe, expect, it } from 'vitest'
import { deleteTemplate, loadTemplate, saveTemplate } from '../src/templates/persist.js'

const template = (id: string, name = 'Grid') => ({
  id,
  name,
  source: 'image' as const,
  originX: 12,
  originY: 34,
  width: 2,
  height: 2,
  indices: new Uint8Array([1, 2, 3, 4]),
  moved: 0,
  opaque: 4,
  visible: true,
  everPlaced: true,
  revision: 0,
})

describe('personal template persistence', () => {
  it('persists pixels and rejects a stale writer without losing the winner', async () => {
    const id = `persistence-${crypto.randomUUID()}`
    const initial = template(id)
    expect(await saveTemplate(initial, null)).toEqual({ status: 'saved', revision: 1 })
    expect(await saveTemplate({ ...initial, name: 'Winner', revision: 1 }, 1)).toEqual({
      status: 'saved',
      revision: 2,
    })
    expect(await saveTemplate({ ...initial, name: 'Stale', revision: 1 }, 1)).toEqual({
      status: 'conflict',
    })
    const loaded = await loadTemplate(id)
    expect(loaded).toMatchObject({ status: 'loaded', template: { name: 'Winner' } })
    if (loaded.status === 'loaded') {
      expect([...(loaded.template as { readonly indices: Uint8Array }).indices]).toEqual([
        1, 2, 3, 4,
      ])
    }
    expect(await deleteTemplate(id, 2)).toEqual({ status: 'saved', revision: 2 })
  })
})
