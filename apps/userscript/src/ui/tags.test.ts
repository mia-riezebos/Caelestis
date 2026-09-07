// @vitest-environment happy-dom
import type { TagManagerModel } from '@caelestis/ui/elements'
import { expect, it, vi } from 'vitest'

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

import { refreshServerSnapshot } from '../application/tree-server-state.js'
import { openTagManager } from './tags.js'

it('retries a failed post-save template refresh without repeating the mutation', async () => {
  vi.mocked(refreshServerSnapshot)
    .mockResolvedValueOnce({ status: 'failed', message: 'Offline' })
    .mockResolvedValue({ status: 'admitted', changed: true })
  openTagManager(
    {
      key: 'server:https://example.com',
      name: 'Example',
      nodeId: null,
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
    new CustomEvent('caelestis-tag-manager-intent', { detail: { type: 'create', name: 'Repair' } }),
  )
  await vi.waitFor(() => expect(manager.model.error).toContain('Saved.'))
  manager.dispatchEvent(
    new CustomEvent('caelestis-tag-manager-intent', { detail: { type: 'retry' } }),
  )
  await vi.waitFor(() => expect(refreshServerSnapshot).toHaveBeenCalledTimes(2))
  expect(manager.model.error).toBeUndefined()
  const { mutateServerTag } = await import('../state.js')
  expect(mutateServerTag).toHaveBeenCalledTimes(1)
  manager.dispatchEvent(
    new CustomEvent('caelestis-tag-manager-intent', { detail: { type: 'close' } }),
  )
})
