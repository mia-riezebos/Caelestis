import { describe, expect, it, vi } from 'vitest'
import { WORLD_TEMPLATE_SURFACE } from './template-surface.js'
import { uuidV7 } from './uuid.js'
import type { WorkItem } from './work.js'
import { createWorkClient } from './work-client.js'

const item = (): WorkItem => ({
  id: uuidV7(),
  season: 0,
  surface: WORLD_TEMPLATE_SURFACE,
  title: 'Border',
  description: '',
  status: 'open',
  priority: 'normal',
  tags: [],
  blockerIds: [],
  nodeId: null,
  templateIds: [],
  claimant: null,
  revision: 1,
  createdAt: 0,
  updatedAt: 0,
})

describe('work client pages', () => {
  it('loads subsequent pages without dropping retained work', async () => {
    const first = item()
    const second = item()
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ items: [first], nextCursor: first.id, canPlan: true, canClaim: true }),
      )
      .mockResolvedValueOnce(
        Response.json({ items: [second], nextCursor: null, canPlan: true, canClaim: true }),
      )
    const client = createWorkClient(request, 0, WORLD_TEMPLATE_SURFACE)
    expect((await client.list()).items).toEqual([first, second])
    expect(request.mock.calls[1]?.[0]).toContain(`&after=${first.id}`)
  })

  it('rejects repeated cursors and cross-scope responses', async () => {
    const first = item()
    const request = vi.fn().mockImplementation(async () =>
      Response.json({
        items: [first],
        nextCursor: first.id,
        canPlan: false,
        canClaim: false,
      }),
    )
    await expect(createWorkClient(request, 0, WORLD_TEMPLATE_SURFACE).list()).rejects.toThrow(
      'cursor',
    )
    expect(request).toHaveBeenCalledTimes(2)
    await expect(createWorkClient(request, 1, WORLD_TEMPLATE_SURFACE).list()).rejects.toThrow(
      'scope',
    )
  })
})
