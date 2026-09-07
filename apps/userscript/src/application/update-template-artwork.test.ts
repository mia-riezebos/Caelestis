import { beforeEach, expect, it, vi } from 'vitest'
import type { PlacedTemplate } from '../templates/local-store.js'

const harness = vi.hoisted(() => ({
  template: undefined as PlacedTemplate | undefined,
  server: { url: 'https://test.example', isAdmin: true },
  manifest: { templates: [{ id: 'remote', version: 'v1' }] as [{ id: string; version: string }] },
  capture: vi.fn(),
  save: vi.fn(),
  upload: vi.fn(),
  refresh: vi.fn(),
  toast: vi.fn(),
  moving: vi.fn(),
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
vi.mock('../state.js', () => ({
  getState: () => ({ servers: [harness.server] }),
  isCurrentServerConnection: () => true,
  admittedServerContentsFor: () => harness.manifest,
  listServerContents: harness.refresh,
  uploadTemplateVersion: harness.upload,
}))
vi.mock('../alliance-server-sync.js', () => ({
  allianceManifestFor: () => harness.manifest,
  refreshAllianceManifest: harness.refresh,
}))
vi.mock('../ui/toast.js', () => ({ toast: harness.toast }))

import { isUpdatingTemplateArtwork, updateTemplateArtwork } from './update-template-artwork.js'

beforeEach(() => {
  vi.resetAllMocks()
  harness.server.isAdmin = true
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
