// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import { coalesceServerRead } from '../server-read-coalescer.js'
import type { PlacedTemplate } from '../templates/local-store.js'

const harness = vi.hoisted(() => ({
  template: undefined as PlacedTemplate | undefined,
  server: {
    url: 'https://test.example',
    isAdmin: true,
    token: 'admin' as string | null,
    tokenUsable: true,
    status: 'connected',
  },
  manifest: { templates: [{ id: 'remote', version: 'v1' }] as [{ id: string; version: string }] },
  capture: vi.fn(),
  save: vi.fn(),
  upload: vi.fn(),
  refresh: vi.fn(),
  toast: vi.fn(),
  moving: vi.fn(),
  confirm: vi.fn(),
}))
vi.mock('../templates/current-artwork.js', () => ({ captureCurrentArtwork: harness.capture }))
vi.mock('../templates/local-store.js', () => ({
  templateById: () => harness.template,
  isCurrentTemplate: (template: PlacedTemplate) => harness.template === template,
  isDeletingLocal: () => false,
  isServerTemplate: (template: PlacedTemplate) => template.serverUrl !== undefined,
  replaceLocalArtwork: harness.save,
}))
vi.mock('../templates/move.js', () => ({ movingId: harness.moving }))
vi.mock('../state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../state.js')>()),
  getState: () => ({ servers: [harness.server] }),
  isCurrentServerConnection: () => true,
  serverConnectionIdentity: (server: object) => server,
  admittedServerContentsFor: () => harness.manifest,
  listServerContents: harness.refresh,
  uploadTemplateVersion: harness.upload,
}))
vi.mock('../alliance-server-sync.js', () => ({
  allianceManifestFor: () => harness.manifest,
  refreshAllianceManifest: harness.refresh,
}))
vi.mock('../ui/toast.js', () => ({ toast: harness.toast }))
vi.mock('../ui/confirm.js', () => ({ confirmDestructive: harness.confirm }))

import {
  isUpdatingTemplateArtwork,
  requestTemplateArtworkUpdate,
  updateTemplateArtwork,
} from './update-template-artwork.js'

beforeEach(() => {
  vi.resetAllMocks()
  harness.server.isAdmin = true
  harness.server.token = 'admin'
  harness.server.tokenUsable = true
  harness.server.status = 'connected'
  harness.manifest.templates[0].version = 'v1'
  harness.template = {
    id: 'test',
    name: 'Test',
    source: 'wplace',
    originX: 9,
    originY: 10,
    width: 1,
    height: 1,
    indices: new Uint8Array([1]),
    moved: 0,
    opaque: 1,
    visible: true,
    everPlaced: true,
    revision: 1,
    appearance: null,
    owns: [],
    folderId: 'folder',
    tiles: new Set(),
  }
  harness.capture.mockResolvedValue(new Uint8Array([5]))
  harness.upload.mockResolvedValue({ ok: true, versionId: 'v2' })
  harness.confirm.mockResolvedValue(true)
})
const serverTemplate = (): void => {
  if (harness.template === undefined) throw new Error('Missing test template')
  harness.template = {
    ...harness.template,
    serverUrl: harness.server.url,
    serverTemplateId: 'remote',
    serverVersion: 'v1',
  }
}

it('saves local artwork through version persistence', async () => {
  await updateTemplateArtwork('test')
  expect(harness.save).toHaveBeenCalledWith(harness.template, new Uint8Array([5]))
  expect(harness.upload).not.toHaveBeenCalled()
})
it.each(['missing', 'rejected', 'read', 'report', 'disconnected'])(
  'rejects server updates with %s credentials before capture',
  async (scope) => {
    serverTemplate()
    if (scope === 'missing') harness.server.token = null
    if (scope === 'rejected') harness.server.tokenUsable = false
    if (scope === 'read' || scope === 'report') harness.server.isAdmin = false
    if (scope === 'disconnected') harness.server.status = 'unreachable'
    await expect(updateTemplateArtwork('test')).rejects.toThrow('Admin access')
    expect(harness.capture).not.toHaveBeenCalled()
    expect(harness.upload).not.toHaveBeenCalled()
  },
)
it.each([false, true])('waits for confirmation before capture (accepted: %s)', async (accepted) => {
  let answer!: (value: boolean) => void
  harness.confirm.mockReturnValue(
    new Promise<boolean>((resolve) => {
      answer = resolve
    }),
  )
  const rerender = vi.fn()
  requestTemplateArtworkUpdate('test', rerender)
  requestTemplateArtworkUpdate('test', rerender)
  expect(harness.confirm).toHaveBeenCalledOnce()
  expect(harness.confirm).toHaveBeenCalledWith(
    expect.objectContaining({
      body: expect.stringContaining('Previous versions cannot currently be restored.'),
    }),
  )
  expect(harness.capture).not.toHaveBeenCalled()
  answer(accepted)
  await vi.waitFor(() => expect(rerender).toHaveBeenCalled())
  if (accepted) {
    expect(harness.save).toHaveBeenCalledOnce()
  } else {
    expect(harness.capture).not.toHaveBeenCalled()
    expect(harness.save).not.toHaveBeenCalled()
    expect(harness.toast).not.toHaveBeenCalled()
  }
})
it('rejects a target replaced while its confirmation is open', async () => {
  let answer!: (value: boolean) => void
  harness.confirm.mockReturnValue(
    new Promise<boolean>((resolve) => {
      answer = resolve
    }),
  )
  requestTemplateArtworkUpdate('test', vi.fn())
  harness.template = undefined
  answer(true)
  await vi.waitFor(() =>
    expect(harness.toast).toHaveBeenCalledWith(expect.stringContaining('changed'), 'error'),
  )
  expect(harness.capture).not.toHaveBeenCalled()
})
it('accepts imported geographic placement before the user has moved it', async () => {
  if (harness.template === undefined) throw new Error('Missing test template')
  harness.template = { ...harness.template, everPlaced: false }
  await updateTemplateArtwork('test')
  expect(harness.save).toHaveBeenCalledOnce()
})
it('uploads a new server version at the existing origin and refreshes consumers', async () => {
  serverTemplate()
  await updateTemplateArtwork('test')
  expect(harness.upload).toHaveBeenCalledWith(
    harness.server,
    'remote',
    expect.objectContaining({ originX: 9, originY: 10, name: 'Test', png: expect.any(Blob) }),
  )
  expect(harness.refresh).toHaveBeenCalledWith(harness.server)
  expect(harness.save).not.toHaveBeenCalled()
})
it.each(['permission', 'version', 'placement'])(
  'refuses capture after losing %s',
  async (reason) => {
    serverTemplate()
    if (reason === 'permission') harness.server.isAdmin = false
    if (reason === 'version') harness.manifest.templates[0].version = 'v2'
    if (reason === 'placement') harness.moving.mockReturnValue('test')
    await expect(updateTemplateArtwork('test')).rejects.toThrow()
    expect(harness.capture).not.toHaveBeenCalled()
    expect(harness.upload).not.toHaveBeenCalled()
  },
)
it('does not save a failed or stale capture', async () => {
  harness.capture.mockRejectedValueOnce(new Error('Missing tile'))
  await expect(updateTemplateArtwork('test')).rejects.toThrow('Missing tile')
  harness.capture.mockImplementationOnce(async () => {
    harness.template = undefined
    return new Uint8Array([5])
  })
  await expect(updateTemplateArtwork('test')).rejects.toThrow('changed')
  expect(harness.save).not.toHaveBeenCalled()
  expect(isUpdatingTemplateArtwork('test')).toBe(false)
})
it('releases the operation after an upload failure without installing new pixels', async () => {
  serverTemplate()
  const previous = harness.template
  harness.upload.mockResolvedValue({ ok: false, message: 'Storage failed' })
  await expect(updateTemplateArtwork('test')).rejects.toThrow('Storage failed')
  expect(harness.template).toBe(previous)
  expect(harness.refresh).not.toHaveBeenCalled()
  expect(isUpdatingTemplateArtwork('test')).toBe(false)
})
it.each(['world', 'alliance-headquarters'] as const)(
  'reconciles an ambiguous %s upload before releasing the operation',
  async (kind) => {
    serverTemplate()
    if (kind !== 'world' && harness.template !== undefined)
      harness.template = { ...harness.template, surface: { kind, allianceId: 1 } }
    harness.upload.mockResolvedValue({ ok: false, ambiguous: true, message: 'Connection lost' })
    await expect(updateTemplateArtwork('test')).rejects.toThrow('Connection lost')
    expect(harness.refresh).toHaveBeenCalledWith(harness.server)
    if (kind !== 'world')
      expect(harness.refresh).toHaveBeenCalledWith(harness.server, { kind, allianceId: 1 })
    expect(isUpdatingTemplateArtwork('test')).toBe(false)
  },
)
it.each(['world', 'alliance-headquarters'] as const)(
  'starts a new %s manifest request after upload while an older read is pending',
  async (kind) => {
    serverTemplate()
    if (kind !== 'world' && harness.template !== undefined)
      harness.template = { ...harness.template, surface: { kind, allianceId: 1 } }
    let release!: (value: string) => void
    const read = vi.fn(async () => 'new')
    const old = coalesceServerRead(
      harness.server,
      kind,
      () =>
        new Promise<string>((resolve) => {
          release = resolve
        }),
    )
    harness.refresh.mockImplementation(() => coalesceServerRead(harness.server, kind, read))
    const updating = updateTemplateArtwork('test')
    await vi.waitFor(() => expect(harness.refresh).toHaveBeenCalled())
    release('old')
    await old
    await updating
    expect(read).toHaveBeenCalledOnce()
  },
)
it('deduplicates clicks from either menu while capture is pending', async () => {
  let release = (_indices: Uint8Array): void => {}
  harness.capture.mockReturnValue(
    new Promise<Uint8Array>((resolve) => {
      release = resolve
    }),
  )
  const first = updateTemplateArtwork('test')
  expect(isUpdatingTemplateArtwork('test')).toBe(true)
  await expect(updateTemplateArtwork('test')).rejects.toThrow('already')
  release(new Uint8Array([5]))
  await first
  expect(harness.save).toHaveBeenCalledOnce()
})
