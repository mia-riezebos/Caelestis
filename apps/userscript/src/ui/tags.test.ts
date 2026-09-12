// @vitest-environment happy-dom
import type { TagManagerModel } from '@caelestis/ui/elements'
import { beforeEach, expect, it, vi } from 'vitest'
import type { ConnectedServer } from '../state.js'

const contents = vi.hoisted(() => new Set<(server: ConnectedServer) => void>())
const localContents = vi.hoisted(() => new Set<() => void>())

vi.mock('@caelestis/ui/elements', () => ({ TAG_MANAGER_TAG: 'caelestis-tag-manager' }))
vi.mock('../alliance-server-sync.js', () => ({ refreshAllianceManifest: vi.fn() }))
vi.mock('../application/tree-server-state.js', () => ({ refreshServerSnapshot: vi.fn() }))
vi.mock('../state.js', () => ({
  isCurrentServerConnection: () => true,
  listServerTags: vi.fn(async () => ({ ok: true, tags: [], selected: [] })),
  mutateServerTag: vi.fn(async () => ({ ok: true })),
  onServerContents: (listener: (server: ConnectedServer) => void) => {
    contents.add(listener)
    return () => contents.delete(listener)
  },
}))
vi.mock('../templates/tags.js', () => ({
  readLocalTags: vi.fn(async () => []),
  onLocalTags: (listener: () => void) => {
    localContents.add(listener)
    return () => localContents.delete(listener)
  },
}))
vi.mock('./theme.js', () => ({ applyWplaceTheme: vi.fn() }))

import { refreshAllianceManifest } from '../alliance-server-sync.js'
import { refreshServerSnapshot } from '../application/tree-server-state.js'
import { listServerTags, mutateServerTag } from '../state.js'
import { readLocalTags } from '../templates/tags.js'
import { openTagManager } from './tags.js'

beforeEach(() => {
  vi.resetAllMocks()
  contents.clear()
  localContents.clear()
})

it('refreshes an open local tag manager after native assignments change', async () => {
  vi.mocked(readLocalTags).mockResolvedValue([])
  openTagManager({ key: 'local:art', name: 'Artwork', server: null, nodeId: null }, vi.fn())
  const manager = document.querySelector('caelestis-tag-manager') as HTMLElement & {
    model: TagManagerModel
  }
  await vi.waitFor(() => expect(manager.model.ready).toBe(true))
  const latest = [{ id: 'tag', name: 'Native', templateIds: ['art'] }]
  vi.mocked(readLocalTags).mockResolvedValue(latest)
  for (const listener of localContents) listener()
  await vi.waitFor(() => expect(manager.model.selected).toEqual(['tag']))
  expect(manager.model.tags).toEqual(latest)
  manager.dispatchEvent(
    new CustomEvent('caelestis-tag-manager-intent', { detail: { type: 'close' } }),
  )
  expect(localContents.size).toBe(0)
})

it.each(['folder', 'template'])(
  'assigns the selected %s without confusing its parent folder',
  async (kind) => {
    const server: ConnectedServer = {
      url: 'https://example.com',
      info: null,
      token: null,
      status: 'connected',
      isAdmin: true,
      season: 0,
    }
    vi.mocked(listServerTags).mockResolvedValue({ ok: true, tags: [], selected: [] })
    vi.mocked(mutateServerTag).mockResolvedValue({ ok: true })
    vi.mocked(refreshServerSnapshot).mockResolvedValue({ status: 'admitted', changed: true })
    openTagManager(
      {
        key: 'server:folder',
        name: 'Selected',
        nodeId: 'folder',
        server,
        ...(kind === 'template' ? { templateId: 'template' } : {}),
      },
      vi.fn(),
    )
    const manager = document.querySelector('caelestis-tag-manager') as HTMLElement & {
      model: TagManagerModel
    }
    await vi.waitFor(() => expect(manager.model.ready).toBe(true))
    expect(manager.model.targetName).toBe('Selected')
    expect(listServerTags).toHaveBeenCalledWith(
      server,
      kind === 'template' ? 'template' : undefined,
      kind === 'folder' ? 'folder' : undefined,
    )
    manager.dispatchEvent(
      new CustomEvent('caelestis-tag-manager-intent', {
        detail: { type: 'assign', id: 'tag', attached: true },
      }),
    )
    await vi.waitFor(() =>
      expect(mutateServerTag).toHaveBeenCalledWith(
        server,
        kind === 'folder'
          ? { type: 'assign-folder', id: 'tag', folderId: 'folder', attached: true }
          : { type: 'assign', id: 'tag', templateId: 'template', attached: true },
      ),
    )
    await vi.waitFor(() => expect(manager.model.busy).toBe(false))
    manager.dispatchEvent(
      new CustomEvent('caelestis-tag-manager-intent', { detail: { type: 'close' } }),
    )
  },
)

it.each(['world', 'alliance'])(
  'retries a failed post-save %s refresh without repeating the mutation',
  async (scope) => {
    vi.mocked(refreshServerSnapshot).mockResolvedValue({ status: 'admitted', changed: true })
    const refresh = scope === 'world' ? refreshServerSnapshot : refreshAllianceManifest
    if (scope === 'world')
      vi.mocked(refreshServerSnapshot).mockResolvedValueOnce({
        status: 'failed',
        message: 'Offline',
      })
    else
      vi.mocked(refreshAllianceManifest)
        .mockResolvedValueOnce({ status: 'failed' })
        .mockResolvedValue({ status: 'unchanged', revision: 'current' })
    openTagManager(
      {
        key: 'server:https://example.com',
        name: 'Example',
        nodeId: null,
        ...(scope === 'world'
          ? {}
          : { surface: { kind: 'alliance-headquarters' as const, allianceId: 535_245 } }),
        server: {
          url: 'https://example.com',
          info: null,
          token: null,
          status: 'connected',
          isAdmin: true,
          season: 0,
        },
      },
      vi.fn(),
    )
    const manager = document.querySelector('caelestis-tag-manager') as HTMLElement & {
      model: TagManagerModel
    }
    await vi.waitFor(() => expect(manager.model.ready).toBe(true))
    manager.dispatchEvent(
      new CustomEvent('caelestis-tag-manager-intent', {
        detail: { type: 'create', name: 'Repair' },
      }),
    )
    await vi.waitFor(() => expect(manager.model.error).toContain('Saved.'))
    manager.dispatchEvent(
      new CustomEvent('caelestis-tag-manager-intent', { detail: { type: 'retry' } }),
    )
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2))
    expect(manager.model.error).toBeUndefined()
    const { mutateServerTag } = await import('../state.js')
    expect(mutateServerTag).toHaveBeenCalledTimes(1)
    manager.dispatchEvent(
      new CustomEvent('caelestis-tag-manager-intent', { detail: { type: 'close' } }),
    )
  },
)

it.each(['loading', 'saving', 'closed'])(
  'coalesces server updates received while %s and respects dismissal',
  async (phase) => {
    const server: ConnectedServer = {
      url: 'https://example.com',
      info: null,
      token: null,
      status: 'connected',
      isAdmin: true,
      season: 0,
    }
    const latest = [{ id: '019fed50-87a1-7523-a88c-bdeafad49681', name: 'New name' }]
    let resolveRead: (result: Awaited<ReturnType<typeof listServerTags>>) => void = () => undefined
    const pending = new Promise<Awaited<ReturnType<typeof listServerTags>>>((resolve) => {
      resolveRead = resolve
    })
    if (phase === 'saving')
      vi.mocked(listServerTags).mockResolvedValueOnce({ ok: true, tags: [], selected: [] })
    vi.mocked(listServerTags)
      .mockReturnValueOnce(pending)
      .mockResolvedValue({ ok: true, tags: latest, selected: [] })
    vi.mocked(refreshServerSnapshot).mockResolvedValue({ status: 'admitted', changed: true })
    openTagManager({ key: 'server:example', name: 'Example', nodeId: null, server }, vi.fn())
    const manager = document.querySelector('caelestis-tag-manager') as HTMLElement & {
      model: TagManagerModel
    }
    if (phase === 'saving') {
      await vi.waitFor(() => expect(manager.model.ready).toBe(true))
      manager.dispatchEvent(
        new CustomEvent('caelestis-tag-manager-intent', {
          detail: { type: 'create', name: 'Repair' },
        }),
      )
    }
    const reads = phase === 'saving' ? 2 : 1
    await vi.waitFor(() => expect(listServerTags).toHaveBeenCalledTimes(reads))
    for (let update = 0; update < 3; update++) for (const listener of contents) listener(server)
    if (phase === 'closed')
      manager.dispatchEvent(
        new CustomEvent('caelestis-tag-manager-intent', { detail: { type: 'close' } }),
      )
    resolveRead({ ok: true, tags: [], selected: [] })
    await vi.waitFor(() => expect(manager.model.loading || manager.model.busy).toBe(false))
    if (phase === 'closed') expect(listServerTags).toHaveBeenCalledTimes(reads)
    else {
      await vi.waitFor(() => expect(manager.model.tags).toEqual(latest))
      expect(listServerTags).toHaveBeenCalledTimes(reads + 1)
      manager.dispatchEvent(
        new CustomEvent('caelestis-tag-manager-intent', { detail: { type: 'close' } }),
      )
    }
    expect(contents.size).toBe(0)
  },
)
