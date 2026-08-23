import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  addLocalFolders: vi.fn(() => true),
  createNode: vi.fn(),
  deleteNode: vi.fn(),
  deleteTemplate: vi.fn(),
  getState: vi.fn(() => ({ localFolders: [] })),
  listServerNodes: vi.fn(),
  nextLocalFolderId: vi.fn(() => 'local-folder'),
  removeLocalFolder: vi.fn(() => true),
  uploadTemplate: vi.fn(),
}))
const store = vi.hoisted(() => ({
  canCopyAsLocalTemplate: vi.fn((template: { wrapX?: boolean }) => template.wrapX !== true),
  copyAsLocalTemplate: vi.fn(),
  localTemplates: vi.fn(),
  removeLocalTemplate: vi.fn(),
  setTemplateFolder: vi.fn(),
  templateAsPng: vi.fn(),
}))

vi.mock('../state.js', () => ({ ...state, MAX_LOCAL_FOLDERS: 32_000 }))
vi.mock('../templates/local-store.js', () => store)
vi.mock('../templates/server-sync.js', () => ({
  serverTemplateKey: (url: string, id: string) => `srv:${url}:${id}`,
}))
vi.mock('../debug.js', () => ({ warn: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('branch transplant', () => {
  it('reports an aggregate admission refusal separately from a server failure', async () => {
    const server = {
      url: 'https://example.test',
      info: null,
      token: null,
      status: 'connected' as const,
      isAdmin: false,
      season: 0,
    }
    state.listServerNodes.mockResolvedValue({ status: 'not-admitted' })
    const { transplant } = await import('./transplant.js')

    await expect(
      transplant(
        { kind: 'server', server, nodeId: 'root' },
        { kind: 'local', folderId: null },
        () => [],
      ),
    ).resolves.toEqual(
      expect.objectContaining({ ok: false, message: expect.stringContaining('safety limits') }),
    )
  })

  it('refuses a wrapped branch before creating Local destination folders', async () => {
    const server = {
      url: 'https://example.test',
      info: null,
      token: null,
      status: 'connected' as const,
      isAdmin: false,
      season: 0,
    }
    state.listServerNodes.mockResolvedValue({
      status: 'ok',
      nodes: [{ id: 'root', parentId: null, path: '/root', name: 'Root', createdAt: 1 }],
    })
    store.localTemplates.mockReturnValue([
      {
        id: 'srv:https://example.test:template',
        name: 'Across the seam',
        originX: 2_047_999,
        originY: 0,
        width: 2,
        height: 1,
        wrapX: true,
      },
    ])
    const { transplant } = await import('./transplant.js')

    await expect(
      transplant(
        { kind: 'server', server, nodeId: 'root' },
        { kind: 'local', folderId: null },
        () => [{ id: 'template', name: 'Across the seam' }],
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        nodes: 0,
        templates: 0,
        message: expect.stringContaining('cannot be moved into Local'),
      }),
    )
    expect(state.addLocalFolders).not.toHaveBeenCalled()
    expect(store.copyAsLocalTemplate).not.toHaveBeenCalled()
  })

  it('does not copy or delete a server branch when Local folder persistence fails', async () => {
    const server = {
      url: 'https://example.test',
      info: null,
      token: null,
      status: 'connected' as const,
      isAdmin: false,
      season: 0,
    }
    state.listServerNodes.mockResolvedValue({
      status: 'ok',
      nodes: [{ id: 'root', parentId: null, path: '/root', name: 'Root', createdAt: 1 }],
    })
    store.localTemplates.mockReturnValue([
      {
        id: 'srv:https://example.test:template',
        name: 'Template',
        originX: 0,
        originY: 0,
        width: 1,
        height: 1,
      },
    ])
    state.addLocalFolders.mockReturnValueOnce(false)
    const { transplant } = await import('./transplant.js')

    await expect(
      transplant(
        { kind: 'server', server, nodeId: 'root' },
        { kind: 'local', folderId: null },
        () => [{ id: 'template', name: 'Template' }],
      ),
    ).resolves.toEqual(expect.objectContaining({ ok: false, templates: 0 }))
    expect(store.copyAsLocalTemplate).not.toHaveBeenCalled()
    expect(state.deleteTemplate).not.toHaveBeenCalled()
    expect(state.deleteNode).not.toHaveBeenCalled()
  })
})
