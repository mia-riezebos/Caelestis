// @vitest-environment happy-dom
import { uuidV7, WORLD_TEMPLATE_SURFACE, type WorkItem } from '@caelestis/shared'
import { afterEach, expect, it, vi } from 'vitest'
import type { ConnectedServer, ServerContents } from '../state.js'

const state = vi.hoisted(() => ({
  servers: [] as ConnectedServer[],
  contents: null as ServerContents | null,
  controller: new AbortController(),
  request: vi.fn(),
  identity: { wplaceUserId: 42, displayName: 'Mia' },
  toast: vi.fn(),
}))
vi.mock('../state.js', () => ({
  getState: () => ({ servers: state.servers }),
  admittedServerContentsFor: () => state.contents,
  serverConnectionSignal: () => state.controller.signal,
  activeServerToken: () => 'report',
  isCurrentServerConnection: () => !state.controller.signal.aborted,
  serverEndpoint: (url: string, path: string) => `${url}/v1${path}`,
}))
vi.mock('../alliance-server-sync.js', () => ({ allianceManifestFor: () => null }))
vi.mock('../application/tree-server-state.js', () => ({}))
vi.mock('../server-transport.js', () => ({ requestServerTree: state.request }))
vi.mock('../wplace-account.js', () => ({
  accountIdentity: () => state.identity,
  loadAccount: async () => {},
}))
vi.mock('./toast.js', () => ({ toast: state.toast }))

import { claimTemplate, workSectionModel } from './work.js'

const setup = () => {
  const server: ConnectedServer = {
    url: 'https://work.example',
    info: { id: uuidV7(), name: 'Work server', auth: 'access_token' },
    token: 'report',
    status: 'connected',
    isAdmin: false,
    season: 0,
  }
  state.servers = [server]
  state.controller = new AbortController()
  state.contents = { nodes: [], templates: [], revision: 'manifest-1', workRevision: 1 }
  const item: WorkItem = {
    id: uuidV7(),
    title: 'Box art',
    description: '',
    status: 'open',
    priority: 'normal',
    tags: [],
    nodeId: null,
    templateIds: [],
    blockerIds: [],
    season: 0,
    surface: WORLD_TEMPLATE_SURFACE,
    claimant: state.identity,
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  }
  return { server, item }
}
afterEach(() => {
  state.controller.abort()
  vi.clearAllMocks()
})

it('refreshes work on work revisions, ignores painting revisions, and discards disconnected responses', async () => {
  const { item } = setup()
  const changed = vi.fn()
  state.request.mockResolvedValue({
    response: { status: 200 },
    body: { items: [item], canClaim: true, canPlan: false },
  })
  workSectionModel(WORLD_TEMPLATE_SURFACE, changed)
  await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1))
  expect(workSectionModel(WORLD_TEMPLATE_SURFACE, changed)?.[0]?.items[0]?.claimant).toBe('Mia #42')
  state.contents = { nodes: [], templates: [], revision: 'paint-update', workRevision: 1 }
  workSectionModel(WORLD_TEMPLATE_SURFACE, changed)
  expect(state.request).toHaveBeenCalledTimes(1)
  let finish: (value: unknown) => void = () => {}
  state.request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  state.contents = { ...state.contents, workRevision: 2 }
  workSectionModel(WORLD_TEMPLATE_SURFACE, changed)
  state.controller.abort()
  state.servers = []
  finish({ response: { status: 200 }, body: { items: [item], canClaim: true, canPlan: false } })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(changed).toHaveBeenCalledTimes(1)
  expect(workSectionModel(WORLD_TEMPLATE_SURFACE, changed)).toEqual([])
})

it('claims directly with the Wplace identity and current revision, without a planning form', async () => {
  const { server, item } = setup()
  const changed = vi.fn()
  state.request
    .mockResolvedValueOnce({
      response: { status: 200 },
      body: { items: [], canClaim: true, canPlan: false },
    })
    .mockResolvedValueOnce({ response: { status: 200 }, body: item })
  await claimTemplate(
    { server, key: item.id, name: item.title, nodeId: null, templateId: item.id },
    changed,
  )
  const call = state.request.mock.calls[1]
  expect(call).toBeDefined()
  if (call === undefined) throw new Error('Claim request missing')
  const [url, init] = call
  expect(url).toContain(`/work/${item.id}?`)
  expect(JSON.parse(init.body)).toEqual({
    action: 'claim-template',
    actor: state.identity,
    expectedRevision: 0,
  })
  expect(changed).toHaveBeenCalledOnce()
  expect(state.toast).toHaveBeenCalledWith('Claimed “Box art”.')
})

it.each([false, true])(
  'keeps the drawer available and limits other claims to admins (admin=%s)',
  async (canPlan) => {
    const { item } = setup()
    const otherId = uuidV7()
    state.contents = { nodes: [], templates: [], revision: 'legacy-manifest' }
    state.request.mockResolvedValue({
      response: { status: 200 },
      body: {
        items: [
          item,
          { ...item, id: otherId, claimant: { wplaceUserId: 84, displayName: 'Other painter' } },
          { ...item, id: uuidV7(), claimant: null },
          { ...item, id: uuidV7(), status: 'completed' },
        ],
        canClaim: true,
        canPlan,
      },
    })
    const changed = vi.fn()
    expect(workSectionModel(WORLD_TEMPLATE_SURFACE, changed)).toHaveLength(1)
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce())
    const groups = workSectionModel(WORLD_TEMPLATE_SURFACE, changed)
    expect(groups[0]?.items.map((row) => row.id)).toEqual([item.id])
    expect(groups[0]?.canShowOthers).toBe(canPlan)
    expect(
      workSectionModel(WORLD_TEMPLATE_SURFACE, changed, true)[0]?.items.map((row) => row.id),
    ).toEqual(canPlan ? [item.id, otherId] : [item.id])
    expect(state.request).toHaveBeenCalledOnce()
  },
)
