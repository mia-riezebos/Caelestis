// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import type { ActiveAllianceSurface } from '../alliance-surface.js'
import type { PlacedTemplate } from './local-store.js'
import { NativeTemplates } from './native-store.js'

const state = vi.hoisted(() => ({
  active: null as ActiveAllianceSurface | null,
  changed: () => {},
  rows: [] as PlacedTemplate[],
  put: vi.fn<typeof import('./local-store.js').putServerTemplate>(),
  clear: vi.fn(),
  copy: vi.fn<typeof import('./local-store.js').addLocalTemplate>(),
  placed: vi.fn(async () => true),
}))
vi.mock('../alliance-surface.js', () => ({
  activeAllianceSurface: () => state.active,
  onActiveAllianceSurfaceChange: (listener: () => void) => {
    state.changed = listener
    return () => {}
  },
}))
vi.mock('./local-store.js', () => ({
  localTemplates: () => state.rows,
  hasRoomForServerTemplate: () => true,
  putServerTemplate: state.put,
  forgetServerTemplate: vi.fn(),
  forgetServerTemplates: state.clear,
  addLocalTemplate: state.copy,
  markPlaced: state.placed,
}))

import {
  copyNativeAllianceTemplate,
  installNativeAllianceTemplates,
  NATIVE_ALLIANCE_OWNER,
} from './native-alliance.js'

afterEach(() => {
  state.active = null
  state.rows = []
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

it('mirrors native reads, discards a response from a closed canvas, and copies without native writes', async () => {
  const surface = { kind: 'alliance-headquarters', allianceId: 7 } as const
  state.active = {
    surface,
    stage: document.createElement('div'),
    frame: document.createElement('div'),
    draftId: null,
    bounds: null,
  }
  const response = {
    templates: [
      {
        id: 42,
        name: 'Native art',
        width: 1,
        height: 1,
        updatedAt: 1,
        locations: [{ target: 'headquarters', x: -1, y: 0, width: 1, height: 1 }],
      },
    ],
  }
  const getAllianceTemplates = vi.fn(async () => response)
  const api = new NativeTemplates(
    {
      templates: [],
      placementSession: false,
      getById: () => undefined,
      add: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      persist: vi.fn(),
      commitPendingChanges: vi.fn(),
      subscribeChange: () => () => {},
    },
    {
      read: async () => undefined,
      save: vi.fn(),
      remove: vi.fn(),
      subscribe: () => () => {},
      render: async () => new ImageData(new Uint8ClampedArray([0, 0, 0, 255]), 1, 1),
    },
    { getAllianceTemplates },
  )
  const fetchImage = vi.fn<typeof fetch>(async () => new Response(new Blob(['image'])))
  vi.stubGlobal('fetch', fetchImage)
  const dispose = installNativeAllianceTemplates(api)
  await vi.waitFor(() => expect(state.put).toHaveBeenCalledTimes(1))
  const mirrored = state.put.mock.calls[0]?.[0]
  if (mirrored === undefined) throw new Error('No native template was mirrored')
  expect(mirrored).toMatchObject({
    originX: -1,
    surface,
    serverUrl: NATIVE_ALLIANCE_OWNER,
    serverTemplateId: '42',
  })
  expect(fetchImage.mock.calls[0]?.[0]).toContain(
    '/alliance/templates/42/image?target=headquarters',
  )
  const source: PlacedTemplate = {
    ...mirrored,
    tiles: new Set(),
    appearance: null,
    revision: 0,
    owns: [],
    folderId: null,
    visible: true,
    everPlaced: true,
  }
  state.rows = [source]
  state.copy.mockResolvedValue({ ...source, id: 'copy' })
  await copyNativeAllianceTemplate(mirrored.id)
  expect(state.copy).toHaveBeenCalledWith(
    expect.objectContaining({ name: 'Native art', originX: -1 }),
    surface,
  )
  expect(state.copy.mock.calls[0]?.[0]).not.toHaveProperty('serverUrl')
  expect(api.metadata.add).not.toHaveBeenCalled()
  expect(api.metadata.update).not.toHaveBeenCalled()
  expect(api.metadata.remove).not.toHaveBeenCalled()
  expect(state.rows).toHaveLength(1)

  let resolve: (value: typeof response) => void = () => {}
  getAllianceTemplates.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  const pending = api.alliance?.getAllianceTemplates({ target: 'headquarters' })
  state.active = null
  state.changed()
  resolve(response)
  await pending
  await new Promise((done) => setTimeout(done, 0))
  expect(state.put).toHaveBeenCalledTimes(1)
  dispose()
  expect(api.alliance?.getAllianceTemplates).toBe(getAllianceTemplates)
})
