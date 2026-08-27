import { describe, expect, it, vi } from 'vitest'
import type { ServerTemplate } from '../server-cache.js'
import type { TreeNode } from '../server-manifest.js'
import { setFolderTemplatesPublished, templatesInFolderSubtree } from './folder-publication.js'

const node = (id: string, parentId: string | null): TreeNode => ({
  id,
  parentId,
  path: `/${id}`,
  name: id,
  createdAt: 0,
})

const template = (id: string, nodeId: string | null, published = false): ServerTemplate => ({
  id,
  nodeId,
  published,
  name: id,
  version: `${id}-version`,
  updatedAt: 0,
  bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
  chunks: [{ tile: '0/0', hash: id.padEnd(64, '0') }],
})

describe('folder publication', () => {
  it('selects templates in the folder and all descendants without crossing into siblings', () => {
    const nodes = [
      node('root', null),
      node('child', 'root'),
      node('grandchild', 'child'),
      node('sibling', null),
    ]
    const templates = [
      template('direct', 'root'),
      template('nested', 'grandchild'),
      template('outside', 'sibling'),
      template('top-level', null),
    ]

    expect(templatesInFolderSubtree(nodes, templates, 'root').map(({ id }) => id)).toEqual([
      'direct',
      'nested',
    ])
  })

  it('patches only templates whose publication state differs', async () => {
    const patch = vi.fn(async () => ({ ok: true as const }))
    const result = await setFolderTemplatesPublished(
      [template('draft', 'root'), template('live', 'root', true)],
      true,
      patch,
    )

    expect(patch).toHaveBeenCalledOnce()
    expect(patch).toHaveBeenCalledWith(expect.objectContaining({ id: 'draft' }))
    expect(result).toEqual({ requested: 1, succeeded: 1, failures: [] })
  })

  it('caps concurrent writes and reports each failed template', async () => {
    let active = 0
    let peak = 0
    const patch = vi.fn(async (entry: ServerTemplate) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 1))
      active--
      return entry.id === 'failed'
        ? ({ ok: false, message: 'refused' } as const)
        : ({ ok: true } as const)
    })
    const entries = [
      template('one', 'root'),
      template('two', 'root'),
      template('three', 'root'),
      template('failed', 'root'),
      template('five', 'root'),
      template('six', 'root'),
    ]

    const result = await setFolderTemplatesPublished(entries, true, patch)

    expect(peak).toBe(4)
    expect(result).toMatchObject({ requested: 6, succeeded: 5 })
    expect(result.failures).toEqual([
      { template: expect.objectContaining({ id: 'failed' }), message: 'refused' },
    ])
  })
})
