import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  isCurrentServerConnection: vi.fn(() => true),
  uploadTemplate: vi.fn(),
}))
const store = vi.hoisted(() => ({
  addLocalTemplate: vi.fn(),
  isCurrentTemplate: vi.fn(() => true),
  localTemplates: vi.fn(),
  removeLocalTemplate: vi.fn(async (_id: string) => true),
  templateAsPng: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
}))
const move = vi.hoisted(() => ({ movingId: vi.fn(() => null) }))
const toasts = vi.hoisted(() => ({ toast: vi.fn() }))

vi.mock('../state.js', () => state)
vi.mock('../templates/local-store.js', () => store)
vi.mock('../templates/move.js', () => move)
vi.mock('./toast.js', () => toasts)

const server = {
  url: 'https://example.test',
  info: null,
  token: null,
  status: 'connected' as const,
  isAdmin: true,
  season: 0,
}

const imported = (source: 'image' | 'wplace' = 'wplace') => ({
  id: 'local-template',
  name: 'Artwork',
  source,
  originX: 120,
  originY: 240,
  width: 2,
  height: 2,
  indices: new Uint8Array([1, 2, 3, 4]),
  moved: 0,
  opaque: 4,
})

beforeEach(() => {
  vi.clearAllMocks()
  const records: Array<ReturnType<typeof imported> & { everPlaced: boolean }> = []
  store.localTemplates.mockImplementation(() => records)
  store.addLocalTemplate.mockImplementation(async (template: ReturnType<typeof imported>) => {
    records.push({ ...template, everPlaced: template.source !== 'image' })
  })
  store.removeLocalTemplate.mockImplementation(async (id: string) => {
    const index = records.findIndex((template) => template.id === id)
    if (index === -1) return false
    records.splice(index, 1)
    return true
  })
  state.uploadTemplate.mockResolvedValue({ ok: true, id: 'remote-template', version: 'version' })
})

describe('server file import', () => {
  it('uploads a positioned import directly into the selected server folder', async () => {
    const refresh = vi.fn(async () => undefined)
    const rerender = vi.fn()
    const { importTemplatesToServer } = await import('./import-to-server.js')

    await importTemplatesToServer([imported()], server, 'folder-id', null, rerender, refresh)

    expect(state.uploadTemplate).toHaveBeenCalledWith(
      server,
      expect.objectContaining({ nodeId: 'folder-id', name: 'Artwork', originX: 120, originY: 240 }),
    )
    expect(store.removeLocalTemplate).toHaveBeenCalledWith('local-template')
    expect(refresh).toHaveBeenCalledWith(server, rerender)
  })

  it('waits for a plain image to be placed before uploading it', async () => {
    let finished: (() => void) | undefined
    const reservation = {
      start: vi.fn((_id: string, callback: () => void) => {
        finished = callback
        return true
      }),
      release: vi.fn(),
    }
    const refresh = vi.fn(async () => undefined)
    const { importTemplatesToServer } = await import('./import-to-server.js')

    await importTemplatesToServer([imported('image')], server, null, reservation, vi.fn(), refresh)

    expect(state.uploadTemplate).not.toHaveBeenCalled()
    expect(reservation.start).toHaveBeenCalledWith('local-template', expect.any(Function))
    finished?.()
    await vi.waitFor(() => expect(state.uploadTemplate).toHaveBeenCalledOnce())
  })

  it('keeps the staged Local template when the server rejects the upload', async () => {
    state.uploadTemplate.mockResolvedValue({ ok: false, message: 'Upload refused.' })
    const { importTemplatesToServer } = await import('./import-to-server.js')

    await importTemplatesToServer([imported()], server, null, null, vi.fn(), vi.fn())

    expect(store.removeLocalTemplate).not.toHaveBeenCalled()
    expect(store.localTemplates()).toHaveLength(1)
    expect(toasts.toast).toHaveBeenCalledWith(expect.stringContaining('Kept in Local'), 'error')
  })
})
