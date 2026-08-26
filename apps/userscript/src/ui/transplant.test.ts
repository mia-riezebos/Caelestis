import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlacedTemplate } from '../templates/local-store.js'

const state = vi.hoisted(() => ({
  addLocalFolders: vi.fn(() => true),
  admittedServerContentsFor: vi.fn(() => ({
    nodes: [{ id: 'remote-root' }],
    templates: [
      {
        id: 'remote-template',
        nodeId: 'remote-root',
        name: 'Template',
        version: '',
        published: false,
      },
    ],
  })),
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
  listServerContents: vi.fn(async () => ({ nodes: [], templates: [] })),
  listServerNodes: vi.fn(),
  nextLocalFolderId: vi.fn(() => 'local-folder'),
  patchTemplate: vi.fn(),
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
  state.admittedServerContentsFor.mockReturnValue({
    nodes: [{ id: 'remote-root' }],
    templates: [
      {
        id: 'remote-template',
        nodeId: 'remote-root',
        name: 'Template',
        version: '',
        published: false,
      },
    ],
  })
  state.listServerContents.mockResolvedValue({ nodes: [], templates: [] })
  state.isCurrentServerConnection.mockReturnValue(true)
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
    state.uploadTemplate.mockResolvedValue({ ok: true, id: 'remote-template', version: '' })
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
    state.uploadTemplate.mockResolvedValue({ ok: true, id: 'remote-template', version: '' })
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
    state.uploadTemplate.mockResolvedValue({ ok: true, id: 'remote-template', version: '' })
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

describe('template transfer transactions', () => {
  const server = (url: string) => ({
    url,
    info: { id: url, name: url, auth: 'none' as const },
    token: null,
    status: 'connected' as const,
    isAdmin: true,
    season: 0,
  })
  const published = {
    id: 'source-template',
    nodeId: 'source-folder',
    name: 'Template',
    version: 'version-1',
    published: true,
    updatedAt: 1,
  }
  const drawn = {
    id: 'drawn-template',
    name: 'Template',
    originX: 10,
    originY: 20,
    serverVersion: 'version-1',
  } as unknown as PlacedTemplate

  it('owns Local encoding, currentness, upload, and reconciliation', async () => {
    const local = { ...drawn, id: 'local-template' }
    store.templateAsPng.mockResolvedValue(new Blob(['png']))
    state.uploadTemplate.mockResolvedValue({
      ok: true,
      id: 'remote-template',
      version: 'version-2',
    })
    const reconcile = vi.fn(async () => undefined)
    const { copyLocalTemplateToServer } = await import('./transplant.js')

    await expect(
      copyLocalTemplateToServer(local, server('https://destination.test'), null, reconcile, {}),
    ).resolves.toEqual({ ok: true, id: 'remote-template', version: 'version-2' })
    expect(state.uploadTemplate).toHaveBeenCalledOnce()
    expect(reconcile).toHaveBeenCalledOnce()
  })

  it('reports a completed Local copy without waiting for reconciliation', async () => {
    const local = { ...drawn, id: 'local-template' }
    store.templateAsPng.mockResolvedValue(new Blob(['png']))
    state.uploadTemplate.mockResolvedValue({
      ok: true,
      id: 'remote-template',
      version: 'version-2',
    })
    const reconcile = vi.fn(() => new Promise<void>(() => undefined))
    const { copyLocalTemplateToServer } = await import('./transplant.js')

    await expect(
      copyLocalTemplateToServer(local, server('https://destination.test'), null, reconcile, {}),
    ).resolves.toEqual({ ok: true, id: 'remote-template', version: 'version-2' })
    expect(reconcile).toHaveBeenCalledOnce()
  })

  it('marks a pre-upload currentness failure as retryable', async () => {
    const local = { ...drawn, id: 'local-template' }
    store.templateAsPng.mockResolvedValue(new Blob(['png']))
    store.isCurrentTemplate.mockReturnValue(false)
    const { copyLocalTemplateToServer } = await import('./transplant.js')

    await expect(
      copyLocalTemplateToServer(
        local,
        server('https://destination.test'),
        null,
        vi.fn(async () => undefined),
        {},
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        retryable: true,
        message: expect.stringContaining('changed'),
      }),
    )
    expect(state.uploadTemplate).not.toHaveBeenCalled()
  })

  it('keeps a changed server source after creating and leasing its Local copy', async () => {
    const release = vi.fn()
    const copied = { id: 'local-copy', name: 'Template' }
    store.copyAsLocalTemplate.mockResolvedValue(copied)
    store.setTemplateFolder.mockResolvedValue(true)
    store.leaseLocalTemplate.mockReturnValue(release)
    const current = vi
      .fn()
      .mockReturnValueOnce(published)
      .mockReturnValueOnce({ ...published, updatedAt: 2 })
    const { moveServerTemplateToLocal } = await import('./transplant.js')

    await expect(
      moveServerTemplateToLocal(
        server('https://source.test'),
        published,
        drawn,
        null,
        current,
        vi.fn(async () => undefined),
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        destinationId: 'local-copy',
        message: expect.stringContaining('source changed and was kept'),
      }),
    )
    expect(state.deleteTemplate).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
  })

  it('verifies the destination admission before deleting a cross-server source', async () => {
    const source = server('https://source.test')
    const destination = server('https://destination.test')
    store.templateAsPng.mockResolvedValue(new Blob(['png']))
    state.uploadTemplate.mockResolvedValue({
      ok: true,
      id: 'remote-template',
      version: 'version-2',
    })
    state.patchTemplate.mockResolvedValue({ ok: true })
    state.deleteTemplate.mockResolvedValue({ ok: true })
    state.admittedServerContentsFor.mockReturnValue({
      nodes: [],
      templates: [
        {
          id: 'remote-template',
          nodeId: 'destination-folder',
          name: 'Template',
          version: 'version-2',
          published: true,
        },
      ],
    })
    const reconcile = vi.fn(async () => undefined)
    const { moveServerTemplateToServer } = await import('./transplant.js')

    await expect(
      moveServerTemplateToServer(
        source,
        destination,
        'destination-folder',
        published,
        drawn,
        () => published,
        reconcile,
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        destinationId: 'remote-template',
        message: expect.stringContaining('Moved'),
      }),
    )
    expect(state.admittedServerContentsFor.mock.invocationCallOrder[0]).toBeLessThan(
      state.deleteTemplate.mock.invocationCallOrder[0] as number,
    )
    expect(reconcile).toHaveBeenCalledWith(source)
    expect(reconcile).toHaveBeenCalledWith(destination)
  })
})
