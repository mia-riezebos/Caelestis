import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  addLocalFolders: vi.fn(() => true),
  createNode: vi.fn(),
  deleteNode: vi.fn(),
  deleteTemplate: vi.fn(),
  getState: vi.fn(
    (): {
      localFolders: Array<{ id: string; parentId: string | null; name: string; visible: boolean }>
    } => ({ localFolders: [] }),
  ),
  isCurrentServerConnection: vi.fn(() => true),
  leaseLocalFolder: vi.fn(() => vi.fn()),
  listServerNodes: vi.fn(),
  nextLocalFolderId: vi.fn(() => 'local-folder'),
  removeLocalFolders: vi.fn(() => true),
  uploadTemplate: vi.fn(),
}))
const store = vi.hoisted(() => ({
  canCopyAsLocalTemplate: vi.fn((template: { wrapX?: boolean }) => template.wrapX !== true),
  copyAsLocalTemplate: vi.fn(),
  isCurrentTemplate: vi.fn(() => true),
  leaseLocalTemplate: vi.fn(() => vi.fn()),
  localTemplates: vi.fn(),
  removeLocalTemplate: vi.fn(),
  setTemplateFolder: vi.fn(),
  templateAsPng: vi.fn(),
}))

vi.mock('../state.js', () => ({ ...state, MAX_LOCAL_FOLDERS: 32_000 }))
vi.mock('../templates/local-store.js', () => store)
vi.mock('../templates/move.js', () => ({ movingId: vi.fn(() => null) }))
vi.mock('../templates/server-sync.js', () => ({
  serverTemplateKey: (url: string, id: string) => `srv:${url}:${id}`,
}))
vi.mock('../debug.js', () => ({ warn: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
  state.getState.mockReturnValue({ localFolders: [] })
  state.leaseLocalFolder.mockReturnValue(vi.fn())
  state.addLocalFolders.mockReturnValue(true)
  state.removeLocalFolders.mockReturnValue(true)
  store.isCurrentTemplate.mockReturnValue(true)
  store.leaseLocalTemplate.mockReturnValue(vi.fn())
  store.localTemplates.mockReturnValue([])
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

  it('collects descendants from parent ids when compatible paths differ in ASCII case', async () => {
    const server = {
      url: 'https://source.test',
      info: null,
      token: null,
      status: 'connected' as const,
      isAdmin: true,
      season: 0,
    }
    state.listServerNodes.mockResolvedValue({
      status: 'ok',
      nodes: [
        { id: 'root', parentId: null, path: '/Root', name: 'Root', createdAt: 1 },
        { id: 'child', parentId: 'root', path: '/root/child', name: 'Child', createdAt: 2 },
      ],
    })
    state.nextLocalFolderId.mockReturnValueOnce('local-root').mockReturnValueOnce('local-child')
    state.deleteNode.mockResolvedValue({ ok: true })
    const { transplant } = await import('./transplant.js')

    await expect(
      transplant(
        { kind: 'server', server, nodeId: 'root' },
        { kind: 'local', folderId: null },
        () => [],
      ),
    ).resolves.toEqual(expect.objectContaining({ ok: true, nodes: 2 }))
    expect(state.addLocalFolders).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'local-root', name: 'Root' }),
      expect.objectContaining({ id: 'local-child', parentId: 'local-root', name: 'Child' }),
    ])
    expect(state.deleteNode).toHaveBeenCalledTimes(2)
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
        serverVersion: 'version',
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
        () => [{ id: 'template', name: 'Across the seam', version: 'version' }],
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
        serverVersion: 'version',
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
        () => [{ id: 'template', name: 'Template', version: 'version' }],
      ),
    ).resolves.toEqual(expect.objectContaining({ ok: false, templates: 0 }))
    expect(store.copyAsLocalTemplate).not.toHaveBeenCalled()
    expect(state.deleteTemplate).not.toHaveBeenCalled()
    expect(state.deleteNode).not.toHaveBeenCalled()
  })

  it('reports a Local template-capacity refusal without escaping the result protocol', async () => {
    const server = {
      url: 'https://example.test',
      info: null,
      token: null,
      status: 'connected' as const,
      isAdmin: true,
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
        serverVersion: 'version',
        originX: 0,
        originY: 0,
        width: 1,
        height: 1,
      },
    ])
    store.copyAsLocalTemplate.mockRejectedValue(new RangeError('too many local templates'))
    const { transplant } = await import('./transplant.js')

    await expect(
      transplant(
        { kind: 'server', server, nodeId: 'root' },
        { kind: 'local', folderId: null },
        () => [{ id: 'template', name: 'Template', version: 'version' }],
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        nodes: 1,
        templates: 0,
        message: expect.stringContaining('too many local templates'),
      }),
    )
    expect(state.deleteTemplate).not.toHaveBeenCalled()
    expect(state.deleteNode).not.toHaveBeenCalled()
  })

  it('holds a Local destination lease across the source read and deletion', async () => {
    const server = {
      url: 'https://example.test',
      info: null,
      token: null,
      status: 'connected' as const,
      isAdmin: true,
      season: 0,
    }
    let finishListing = (_value: unknown): void => undefined
    state.listServerNodes.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          finishListing = resolve
        }),
    )
    store.localTemplates.mockReturnValue([
      {
        id: 'srv:https://example.test:template',
        name: 'Template',
        serverVersion: 'version',
        originX: 0,
        originY: 0,
        width: 1,
        height: 1,
      },
    ])
    store.copyAsLocalTemplate.mockResolvedValue({ id: 'copied' })
    store.setTemplateFolder.mockResolvedValue(true)
    state.deleteTemplate.mockResolvedValue({ ok: true })
    state.deleteNode.mockResolvedValue({ ok: true })
    const releaseDestination = vi.fn()
    const releaseCreated = vi.fn()
    state.leaseLocalFolder
      .mockReturnValueOnce(releaseDestination)
      .mockReturnValueOnce(releaseCreated)
    const { transplant } = await import('./transplant.js')

    const moving = transplant(
      { kind: 'server', server, nodeId: 'root' },
      { kind: 'local', folderId: 'destination' },
      () => [{ id: 'template', name: 'Template', version: 'version' }],
    )

    expect(state.leaseLocalFolder).toHaveBeenCalledWith('destination')
    expect(releaseDestination).not.toHaveBeenCalled()
    finishListing({
      status: 'ok',
      nodes: [{ id: 'root', parentId: null, path: '/root', name: 'Root', createdAt: 1 }],
    })
    await expect(moving).resolves.toEqual(expect.objectContaining({ ok: true }))
    expect(state.leaseLocalFolder).toHaveBeenCalledWith('local-folder')
    expect(state.deleteTemplate).toHaveBeenCalled()
    expect(state.deleteNode).toHaveBeenCalled()
    expect(releaseCreated).toHaveBeenCalledOnce()
    expect(releaseDestination).toHaveBeenCalledOnce()
  })

  it('reports a partial move when a source server folder remains', async () => {
    const server = {
      url: 'https://example.test',
      info: null,
      token: null,
      status: 'connected' as const,
      isAdmin: true,
      season: 0,
    }
    state.listServerNodes.mockResolvedValue({
      status: 'ok',
      nodes: [{ id: 'root', parentId: null, path: '/root', name: 'Root', createdAt: 1 }],
    })
    store.localTemplates.mockReturnValue([])
    state.deleteNode.mockResolvedValue({ ok: false, message: 'folder is not empty' })
    const { transplant } = await import('./transplant.js')

    await expect(
      transplant(
        { kind: 'server', server, nodeId: 'root' },
        { kind: 'local', folderId: null },
        () => [],
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        message: expect.stringContaining('could not remove source folder “Root”'),
      }),
    )
  })

  it('keeps every copied Local template leased through remote source cleanup', async () => {
    const server = {
      url: 'https://example.test',
      info: null,
      token: null,
      status: 'connected' as const,
      isAdmin: true,
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
        serverVersion: 'version',
        originX: 0,
        originY: 0,
      },
    ])
    store.copyAsLocalTemplate.mockResolvedValue({ id: 'copied' })
    store.setTemplateFolder.mockResolvedValue(true)
    let finishDelete = (_value: { ok: true }): void => undefined
    state.deleteTemplate.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          finishDelete = resolve
        }),
    )
    state.deleteNode.mockResolvedValue({ ok: true })
    const release = vi.fn()
    store.leaseLocalTemplate.mockReturnValueOnce(release)
    const { transplant } = await import('./transplant.js')

    const moving = transplant(
      { kind: 'server', server, nodeId: 'root' },
      { kind: 'local', folderId: null },
      () => [{ id: 'template', name: 'Template', version: 'version' }],
    )
    await vi.waitFor(() => expect(state.deleteTemplate).toHaveBeenCalledOnce())
    expect(store.leaseLocalTemplate).toHaveBeenCalledWith('copied')
    expect(release).not.toHaveBeenCalled()
    finishDelete({ ok: true })

    await expect(moving).resolves.toEqual(expect.objectContaining({ ok: true }))
    expect(release).toHaveBeenCalledOnce()
  })

  it('keeps a changed Local source instead of deleting its newer revision', async () => {
    const server = {
      url: 'https://destination.test',
      info: null,
      token: null,
      status: 'connected' as const,
      isAdmin: true,
      season: 0,
    }
    const source = { id: 'source', folderId: 'root', name: 'Template', originX: 0, originY: 0 }
    state.getState.mockReturnValue({
      localFolders: [{ id: 'root', parentId: null, name: 'Root', visible: true }],
    })
    store.localTemplates.mockReturnValue([source])
    store.templateAsPng.mockResolvedValue(new Blob(['png']))
    state.createNode.mockResolvedValue({ ok: true, node: { id: 'remote-root' } })
    state.uploadTemplate.mockResolvedValue({ ok: true, id: 'remote-template' })
    store.isCurrentTemplate.mockReturnValueOnce(true).mockReturnValueOnce(false)
    const { transplant } = await import('./transplant.js')

    await expect(
      transplant(
        { kind: 'local', folderId: 'root' },
        { kind: 'server', server, nodeId: null },
        () => [],
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        message: expect.stringContaining('changed'),
      }),
    )
    expect(store.removeLocalTemplate).not.toHaveBeenCalled()
    expect(state.removeLocalFolders).not.toHaveBeenCalled()
  })

  it('keeps a Local folder that receives content after its snapshot', async () => {
    const server = {
      url: 'https://destination.test',
      info: null,
      token: null,
      status: 'connected' as const,
      isAdmin: true,
      season: 0,
    }
    const source = { id: 'source', folderId: 'root', name: 'Template', originX: 0, originY: 0 }
    const late = { id: 'late', folderId: 'root', name: 'Late arrival', originX: 0, originY: 0 }
    state.getState.mockReturnValue({
      localFolders: [{ id: 'root', parentId: null, name: 'Root', visible: true }],
    })
    store.localTemplates.mockReturnValueOnce([source]).mockReturnValueOnce([late])
    store.templateAsPng.mockResolvedValue(new Blob(['png']))
    state.createNode.mockResolvedValue({ ok: true, node: { id: 'remote-root' } })
    state.uploadTemplate.mockResolvedValue({ ok: true, id: 'remote-template' })
    store.removeLocalTemplate.mockResolvedValue(true)
    const { transplant } = await import('./transplant.js')

    await expect(
      transplant(
        { kind: 'local', folderId: 'root' },
        { kind: 'server', server, nodeId: null },
        () => [],
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        message: expect.stringContaining('source branch'),
      }),
    )
    expect(state.removeLocalFolders).not.toHaveBeenCalled()
  })

  it('refuses a second transplant while the same source is active', async () => {
    const server = {
      url: 'https://destination.test',
      info: null,
      token: null,
      status: 'connected' as const,
      isAdmin: true,
      season: 0,
    }
    const source = { id: 'source', folderId: 'root', name: 'Template', originX: 0, originY: 0 }
    state.getState.mockReturnValue({
      localFolders: [{ id: 'root', parentId: null, name: 'Root', visible: true }],
    })
    store.localTemplates.mockReturnValueOnce([source]).mockReturnValueOnce([])
    state.createNode.mockResolvedValue({ ok: true, node: { id: 'remote-root' } })
    let finishEncoding = (_value: Blob): void => undefined
    store.templateAsPng.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          finishEncoding = resolve
        }),
    )
    state.uploadTemplate.mockResolvedValue({ ok: true, id: 'remote-template' })
    store.removeLocalTemplate.mockResolvedValue(true)
    const { transplant } = await import('./transplant.js')
    const input = { kind: 'local' as const, folderId: 'root' }
    const target = { kind: 'server' as const, server, nodeId: null }

    const first = transplant(input, target, () => [])
    await vi.waitFor(() => expect(store.templateAsPng).toHaveBeenCalledOnce())
    await expect(transplant(input, target, () => [])).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        message: expect.stringContaining('already being moved'),
      }),
    )
    finishEncoding(new Blob(['png']))
    await expect(first).resolves.toEqual(expect.objectContaining({ ok: true }))
  })
})
