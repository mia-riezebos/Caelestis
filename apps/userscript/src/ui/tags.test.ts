// @vitest-environment happy-dom
import type { TagManagerModel } from '@caelestis/ui/elements'
import { beforeEach, expect, it, vi } from 'vitest'

vi.mock('@caelestis/ui/elements', () => ({ TAG_MANAGER_TAG: 'caelestis-tag-manager' }))
vi.mock('../alliance-server-sync.js', () => ({ refreshAllianceManifest: vi.fn() }))
vi.mock('../application/tree-server-state.js', () => ({ refreshServerSnapshot: vi.fn() }))
vi.mock('../state.js', () => ({
  isCurrentServerConnection: () => true,
  listServerTags: vi.fn(async () => ({ ok: true, tags: [], selected: [] })),
  mutateServerTag: vi.fn(async () => ({ ok: true })),
  onServerContents: () => () => undefined,
}))
vi.mock('../templates/tags.js', () => ({}))
vi.mock('./theme.js', () => ({ applyWplaceTheme: vi.fn() }))

import { refreshAllianceManifest } from '../alliance-server-sync.js'
import { refreshServerSnapshot } from '../application/tree-server-state.js'
import { openTagManager } from './tags.js'

beforeEach(() => vi.resetAllMocks())

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
