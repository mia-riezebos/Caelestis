import {
  millis,
  uuidV7,
  WORLD_TEMPLATE_SURFACE,
  type WorkFields,
  type WorkItem,
} from '@caelestis/shared'
import { describe, expect, it, vi } from 'vitest'
import { MemoryBlobStore } from '../adapters/memory/memory-blob-store.js'
import { MemoryCounterStore } from '../adapters/memory/memory-counter-store.js'
import { MemorySqlStore } from '../adapters/memory/memory-sql-store.js'
import { createApp } from '../app.js'
import type { TemplateVersionRecord } from '../ports/index.js'
import { makeBackendContext } from '../runtime/backend-runtime.js'
import { DirectStatusReadModel } from '../status-read-model/port.js'

const actor = { wplaceUserId: 1, displayName: 'Mia' }
const other = { wplaceUserId: 2, displayName: 'Dawn' }
const fields: WorkFields = {
  title: 'Repair border',
  description: '',
  status: 'open',
  priority: 'normal',
  tags: ['repair'],
  blockerIds: [],
  nodeId: null,
  templateIds: [],
}
const setup = async () => {
  const sql = new MemorySqlStore()
  const live = new DirectStatusReadModel(sql)
  const notify = vi.spyOn(live, 'notifyManifestChange')
  const app = createApp(
    makeBackendContext(
      new MemoryBlobStore(),
      sql,
      new MemoryCounterStore(sql, () => millis(Date.now())),
      live,
    ),
    { bootstrapAdminToken: 'admin' },
  )
  const token = async (scope: string) => {
    const response = await app.request('/v1/admin/tokens', {
      method: 'POST',
      headers: { authorization: 'Bearer admin', 'content-type': 'application/json' },
      body: JSON.stringify({ label: scope, scope }),
    })
    return ((await response.json()) as { token: string }).token
  }
  const report = await token('report')
  const read = await token('read')
  const mutate = (id: string, body: unknown, credential = 'admin', scope = 'season=0') =>
    app.request(`/v1/work/${id}?${scope}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  const create = async (overrides: Partial<WorkFields> = {}) => {
    const id = uuidV7()
    const response = await mutate(id, {
      action: 'create',
      actor,
      expectedRevision: 0,
      fields: { ...fields, ...overrides },
    })
    expect(response.status).toBe(200)
    return (await response.json()) as WorkItem
  }
  return { app, sql, live, notify, report, read, mutate, create }
}

describe('shared work routes', () => {
  it('claims a template without planning permission and admits only one concurrent painter', async () => {
    const h = await setup()
    const templateId = uuidV7()
    await h.sql.insertTemplateVersion({
      templateId,
      versionId: uuidV7(),
      season: 0,
      surface: WORLD_TEMPLATE_SURFACE,
      nodeId: null,
      name: 'Box art',
      createdWithToken: 'a'.repeat(64),
      createdByUserId: null,
      createdAt: millis(1000),
      bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
      totalPixels: 1,
      chunks: [{ tileX: 0, tileY: 0, hash: 'b'.repeat(64) }],
    })
    const claim = { action: 'claim-template', actor, expectedRevision: 0 }
    expect((await h.mutate(templateId, claim, h.read)).status).toBe(403)
    expect((await h.mutate(templateId, claim, h.report)).status).toBe(400)
    await h.sql.setTemplatePublishedAt(templateId, millis(1000), millis(1000))
    expect((await h.mutate(templateId, claim, h.report, 'season=1')).status).toBe(400)
    const responses = await Promise.all(
      [actor, other].map((painter) => h.mutate(templateId, { ...claim, actor: painter }, h.report)),
    )
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409])
    const item = await h.sql.work.read(templateId)
    expect(item).toMatchObject({
      title: 'Box art',
      templateIds: [templateId],
      revision: 1,
      status: 'open',
    })
    const conflict = responses.find((response) => response.status === 409)
    expect(await conflict?.json()).toMatchObject({
      error: expect.stringContaining(`#${item?.claimant?.wplaceUserId}`),
    })
    expect((await h.mutate(templateId, { ...claim, actor: item?.claimant }, h.report)).status).toBe(
      200,
    )
    expect(await h.sql.work.history(templateId, Number.MAX_SAFE_INTEGER)).toHaveLength(1)
    expect(
      (
        await h.mutate(
          templateId,
          { action: 'release', actor: item?.claimant, expectedRevision: 1 },
          h.report,
        )
      ).status,
    ).toBe(200)
    expect(
      (await h.mutate(templateId, { ...claim, actor: other, expectedRevision: 2 }, h.report))
        .status,
    ).toBe(200)
    expect(await h.sql.work.read(templateId)).toMatchObject({ claimant: other, revision: 3 })
  })

  it('enforces planning scope and releases only the self-reported claimant', async () => {
    const h = await setup()
    const item = await h.create()
    expect(
      (await h.mutate(uuidV7(), { action: 'create', actor, fields, expectedRevision: 0 }, h.report))
        .status,
    ).toBe(403)
    expect(
      (await h.mutate(item.id, { action: 'claim', actor, expectedRevision: 1 }, h.read)).status,
    ).toBe(403)
    expect(
      (await h.mutate(item.id, { action: 'claim', actor, expectedRevision: 1 }, h.report)).status,
    ).toBe(200)
    expect(
      (await h.mutate(item.id, { action: 'release', actor: other, expectedRevision: 2 }, h.report))
        .status,
    ).toBe(403)
    expect(
      (
        await h.mutate(
          item.id,
          { action: 'assign', actor, claimant: other, expectedRevision: 2 },
          h.report,
        )
      ).status,
    ).toBe(403)
    expect(
      (await h.mutate(item.id, { action: 'assign', actor, claimant: other, expectedRevision: 2 }))
        .status,
    ).toBe(200)
    expect(
      (await h.mutate(item.id, { action: 'release', actor: other, expectedRevision: 3 }, h.report))
        .status,
    ).toBe(200)
    const history = await h.sql.work.history(item.id, Number.MAX_SAFE_INTEGER)
    expect(history.map((event) => event.action)).toEqual(['release', 'assign', 'claim', 'create'])
  })

  it('reports the winning painter on competing claims and keeps the manifest recoverable', async () => {
    const h = await setup()
    const item = await h.create()
    const before = await h.live.readManifestProjection({
      server: { id: uuidV7(), name: 'Test', auth: 'access_token' },
      season: 0,
      scope: 'public',
      ifNoneMatch: [],
      surface: WORLD_TEMPLATE_SURFACE,
    })
    const responses = await Promise.all(
      [actor, other].map((identity) =>
        h.mutate(item.id, { action: 'claim', actor: identity, expectedRevision: 1 }, h.report),
      ),
    )
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409])
    const winner = await h.sql.work.read(item.id)
    const conflict = responses.find((response) => response.status === 409)
    expect(await conflict?.json()).toMatchObject({
      item: winner,
      error: expect.stringContaining(`#${winner?.claimant?.wplaceUserId}`),
    })
    const recovered = await h.app.request('/v1/manifest?season=0', {
      headers: { authorization: `Bearer ${h.read}` },
    })
    expect(await recovered.json()).toMatchObject({ workRevision: 2 })
    expect(before).toBeDefined()
    expect(h.notify).toHaveBeenCalledWith(0, WORLD_TEMPLATE_SURFACE, false)
    const retry = await h.mutate(item.id, { action: 'claim', actor, expectedRevision: 1 }, h.report)
    expect(retry.status).toBe(409)
    expect(await h.sql.work.history(item.id, Number.MAX_SAFE_INTEGER)).toHaveLength(2)
  })

  it('preserves work history after folder deletion and supports close and reopen', async () => {
    const h = await setup()
    const node = await h.sql.insertNode({
      id: uuidV7(),
      season: 0,
      surface: WORLD_TEMPLATE_SURFACE,
      parentId: null,
      path: '/border',
      name: 'Border',
      description: null,
      createdAt: millis(Date.now()),
    })
    const item = await h.create({ nodeId: node.id })
    await h.sql.deleteNode(node.id)
    for (const [status, revision] of [
      ['completed', 1],
      ['open', 2],
    ] as const) {
      const response = await h.mutate(item.id, {
        action: 'edit',
        actor,
        expectedRevision: revision,
        fields: { ...fields, nodeId: node.id, status },
      })
      expect(response.status).toBe(200)
    }
    expect((await h.sql.work.read(item.id))?.status).toBe('open')
    expect((await h.sql.work.history(item.id, 2))[0]?.item.nodeId).toBe(node.id)
  })

  it('retains stable template references across replacement and deletion', async () => {
    const h = await setup()
    const templateId = uuidV7()
    const version: TemplateVersionRecord = {
      templateId,
      versionId: uuidV7(),
      season: 0,
      surface: WORLD_TEMPLATE_SURFACE,
      nodeId: null,
      name: 'Border',
      createdWithToken: 'a'.repeat(64),
      createdByUserId: null,
      createdAt: millis(1000),
      bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
      totalPixels: 1,
      chunks: [{ tileX: 0, tileY: 0, hash: 'b'.repeat(64) }],
    }
    await h.sql.insertTemplateVersion(version)
    await h.sql.setTemplatePublishedAt(templateId, millis(1000), millis(1000))
    const item = await h.create({ templateIds: [templateId] })
    const replacement = { ...version, versionId: uuidV7(), createdAt: millis(2000) }
    await h.sql.insertTemplateVersion(replacement, { requireExisting: true })
    expect((await h.sql.work.read(item.id))?.templateIds).toEqual([templateId])
    const current = await h.sql.readTemplate(templateId)
    expect(current).not.toBeNull()
    if (current === null || current.currentVersionId === null)
      throw new Error('Template replacement disappeared')
    expect(
      await h.sql.deleteTemplate(templateId, {
        versionId: current.currentVersionId,
        updatedAt: current.updatedAt,
      }),
    ).toBe(true)
    expect(
      (
        await h.mutate(item.id, {
          action: 'edit',
          actor,
          expectedRevision: 1,
          fields: { ...fields, templateIds: [templateId], status: 'completed' },
        })
      ).status,
    ).toBe(200)
    expect((await h.sql.work.history(item.id, 2))[0]?.item.templateIds).toEqual([templateId])
    expect(
      (
        await h.mutate(uuidV7(), {
          action: 'create',
          actor,
          expectedRevision: 0,
          fields: { ...fields, templateIds: [templateId] },
        })
      ).status,
    ).toBe(400)
  })

  it('rejects invalid links, cross-scope work, malformed identities and self blockers', async () => {
    const h = await setup()
    const item = await h.create()
    expect(
      (
        await h.mutate(
          item.id,
          { action: 'claim', actor, expectedRevision: 1 },
          h.report,
          'season=1',
        )
      ).status,
    ).toBe(400)
    expect(
      (
        await h.mutate(
          item.id,
          { action: 'claim', actor: { ...actor, wplaceUserId: -1 }, expectedRevision: 1 },
          h.report,
        )
      ).status,
    ).toBe(400)
    for (const patch of [
      { templateIds: [uuidV7()] },
      { nodeId: uuidV7() },
      { blockerIds: [item.id] },
    ]) {
      expect(
        (
          await h.mutate(item.id, {
            action: 'edit',
            actor,
            expectedRevision: 1,
            fields: { ...fields, ...patch },
          })
        ).status,
      ).toBe(400)
    }
  })
})
