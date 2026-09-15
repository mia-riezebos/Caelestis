import { describe, expect, it } from 'vitest'
import { createWorkClient, type WorkItem } from '../index.js'

const id = '018f4f2a-1234-7abc-8def-0123456789ab'
const item: WorkItem = {
  id,
  season: 0,
  surface: { kind: 'world', allianceId: null },
  title: 'Fill coast',
  description: 'blue',
  status: 'open',
  priority: 'normal',
  tags: [],
  blockerIds: [],
  nodeId: null,
  templateIds: [id],
  claimant: null,
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
}

describe('work client transport contract', () => {
  it('lists scoped pages and returns the authoritative mutation result', async () => {
    const paths: string[] = []
    const client = createWorkClient(
      async (path) => {
        paths.push(path)
        return new Response(
          JSON.stringify(
            path.startsWith('/work?')
              ? { items: [item], canPlan: true, canClaim: true, nextCursor: null }
              : { ...item, status: 'blocked', revision: 2 },
          ),
          { status: 200 },
        )
      },
      0,
      { kind: 'world', allianceId: null },
    )
    expect(await client.list()).toMatchObject({ items: [item], canPlan: true })
    expect(
      await client.mutate(id, {
        action: 'edit',
        actor: { wplaceUserId: 1, displayName: 'Mia' },
        expectedRevision: 1,
        fields: item,
      }),
    ).toMatchObject({ status: 'blocked', revision: 2 })
    expect(paths[0]).toContain('season=0')
  })

  it('preserves refusal status and rejects a response for another work item', async () => {
    const refused = createWorkClient(
      async () => new Response(JSON.stringify({ error: 'revision conflict' }), { status: 409 }),
      0,
      { kind: 'world', allianceId: null },
    )
    await expect(
      refused.mutate(id, {
        action: 'release',
        actor: { wplaceUserId: 1, displayName: 'Mia' },
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ status: 409 })
    const wrongItem = createWorkClient(
      async () =>
        new Response(JSON.stringify({ ...item, id: '018f4f2a-1235-7abc-8def-0123456789ab' })),
      0,
      { kind: 'world', allianceId: null },
    )
    await expect(
      wrongItem.mutate(id, {
        action: 'release',
        actor: { wplaceUserId: 1, displayName: 'Mia' },
        expectedRevision: 1,
      }),
    ).rejects.toThrow('invalid work item')
  })
})
