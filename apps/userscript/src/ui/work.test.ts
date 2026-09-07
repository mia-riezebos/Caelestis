// @vitest-environment happy-dom
import {
  type PainterIdentity,
  uuidV7,
  WORLD_TEMPLATE_SURFACE,
  type WorkItem,
} from '@caelestis/shared'
import type { TemplateTreeModel, TreeRowModel } from '@caelestis/ui/elements'
import { afterEach, expect, it, vi } from 'vitest'
import type { ConnectedServer, ServerContents, State } from '../state.js'

const state = vi.hoisted(() => ({
  servers: [] as ConnectedServer[],
  contents: null as ServerContents | null,
  localClaims: [] as State['localClaims'],
  locals: [] as { id: string }[],
  save: true,
  templates: [] as { id: string; published: boolean }[],
  controller: new AbortController(),
  request: vi.fn(),
  identity: { wplaceUserId: 42, displayName: 'Mia' } as PainterIdentity | null,
  loadAccount: vi.fn(async () => {}),
  toast: vi.fn(),
}))
vi.mock('../state.js', () => ({
  getState: () => state,
  commitState: (patch: Partial<State>) => {
    if (!state.save) return false
    Object.assign(state, patch)
    return true
  },
  admittedServerContentsFor: () => state.contents,
  serverConnectionSignal: () => state.controller.signal,
  activeServerToken: () => 'report',
  isCurrentServerConnection: () => !state.controller.signal.aborted,
  serverEndpoint: (url: string, path: string) => `${url}/v1${path}`,
}))
vi.mock('../alliance-server-sync.js', () => ({ allianceManifestFor: () => null }))
vi.mock('../application/tree-server-state.js', () => ({
  rowsForSurface: () => ({ templates: state.templates }),
  serverTemplateTreeKey: (server: ConnectedServer, id: string) => `${server.url}:${id}`,
}))
vi.mock('../templates/local-store.js', () => ({
  localTemplates: () => state.locals,
  isServerTemplate: () => false,
}))
vi.mock('../server-transport.js', () => ({ requestServerTree: state.request }))
vi.mock('../wplace-account.js', () => ({
  accountIdentity: () => state.identity,
  loadAccount: state.loadAccount,
}))
vi.mock('./toast.js', () => ({ toast: state.toast }))

import {
  canClaimTemplate,
  claimTemplate,
  retryTemplateClaims,
  withTemplateClaims,
  workSectionModel,
} from './work.js'

const setup = () => {
  state.identity = { wplaceUserId: 42, displayName: 'Mia' }
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
  state.localClaims = []
  state.locals = []
  state.save = true
  const id = uuidV7()
  const item: WorkItem = {
    id,
    title: 'Box art',
    description: '',
    status: 'open',
    priority: 'normal',
    tags: [],
    nodeId: null,
    templateIds: [id],
    blockerIds: [],
    season: 0,
    surface: WORLD_TEMPLATE_SURFACE,
    claimant: state.identity,
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  }
  state.templates = [{ id, published: true }]
  return { server, item, key: `${server.url}:${id}` }
}
afterEach(() => {
  state.controller.abort()
  vi.clearAllMocks()
})

it('refreshes on work revisions, ignores painting updates, and discards disconnected responses', async () => {
  const { item, key } = setup()
  const changed = vi.fn()
  state.request.mockResolvedValue({
    response: { status: 200 },
    body: { items: [item], canClaim: true, canPlan: false },
  })
  workSectionModel(WORLD_TEMPLATE_SURFACE, changed)
  await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1))
  expect(workSectionModel(WORLD_TEMPLATE_SURFACE, changed).templates.get(key)?.people).toEqual([
    state.identity,
  ])
  state.contents = {
    ...state.contents,
    nodes: [],
    templates: [],
    revision: 'paint-update',
    workRevision: 1,
  }
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
  expect(workSectionModel(WORLD_TEMPLATE_SURFACE, changed).templates.size).toBe(0)
})

it('retries a simultaneous claim using the new revision and the same Wplace identity', async () => {
  const { server, item } = setup()
  const changed = vi.fn()
  state.request
    .mockResolvedValueOnce({
      response: { status: 200 },
      body: { items: [], canClaim: true, canPlan: false },
    })
    .mockResolvedValueOnce({ response: { status: 409 }, body: { error: 'Work changed' } })
    .mockResolvedValueOnce({
      response: { status: 200 },
      body: { items: [item], canClaim: true, canPlan: false },
    })
    .mockResolvedValueOnce({ response: { status: 200 }, body: item })
  await claimTemplate(
    { server, key: item.id, name: item.title, nodeId: null, templateId: item.id },
    changed,
  )
  expect(JSON.parse(state.request.mock.calls[3]?.[1].body)).toEqual({
    action: 'claim-template',
    actor: state.identity,
    expectedRevision: 1,
  })
  expect(changed).toHaveBeenCalledOnce()
  expect(state.toast).not.toHaveBeenCalled()
})

const row = (key: string): TreeRowModel => ({
  type: 'row',
  key,
  name: key,
  icon: 'image',
  depth: 2,
  branches: [true, false],
  parentKey: 'folder',
  container: false,
  expanded: false,
  visible: true,
  positionInSet: 1,
  setSize: 1,
  leadingActions: [{ id: 'go', label: 'Go to', icon: 'search' }],
  progress: { completed: 10, total: 20, known: 20, mismatched: 0, unpainted: 10 },
})
it.each([false, true])(
  'aggregates local and server rows, preserves row controls, and gates other claims (admin=%s)',
  async (canPlan) => {
    const { item, key, server } = setup()
    const otherId = uuidV7()
    state.templates.push({ id: otherId, published: true })
    state.servers.push({ ...server, url: 'https://second.example' })
    state.locals = [{ id: 'local-art' }]
    state.localClaims = [
      { templateId: 'local-art', claimant: { wplaceUserId: 42, displayName: 'Mia' } },
    ]
    const other = { wplaceUserId: 84, displayName: 'Other painter' }
    state.request.mockResolvedValue({
      response: { status: 200 },
      body: {
        items: [
          { ...item, claimants: [state.identity, other] },
          { ...item, id: otherId, templateIds: [otherId], claimant: other },
        ],
        canClaim: true,
        canPlan,
      },
    })
    const changed = vi.fn()
    workSectionModel(WORLD_TEMPLATE_SURFACE, changed)
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2))
    const claims = workSectionModel(WORLD_TEMPLATE_SURFACE, changed)
    const original = row(key)
    const tree: TemplateTreeModel = {
      query: '',
      sort: { field: 'custom', direction: 'asc' },
      entries: [
        original,
        row(`${server.url}:${otherId}`),
        row(`https://second.example:${item.id}`),
        row(`https://second.example:${otherId}`),
        row('local:local-art'),
      ],
    }
    const personal = withTemplateClaims(tree, claims, false)
    expect(personal.entries.map((entry) => entry.key)).toEqual([
      key,
      `https://second.example:${item.id}`,
      'local:local-art',
    ])
    expect(personal.entries[0]).toMatchObject({
      progress: original.progress,
      leadingActions: original.leadingActions,
      depth: 0,
      parentKey: null,
      claims: { people: [state.identity, other] },
    })
    expect(withTemplateClaims(tree, claims, true).entries).toHaveLength(canPlan ? 5 : 3)
    expect(claims.canShowOthers).toBe(canPlan)
  },
)

it('persists personal local claims and preserves other painters when releasing', async () => {
  setup()
  state.locals = [{ id: 'local-art' }]
  const other = { wplaceUserId: 84, displayName: 'Other painter' }
  state.localClaims = [{ templateId: 'local-art', claimant: other }]
  const target = { server: null, key: 'local:local-art', name: 'Local art', nodeId: null }
  const changed = vi.fn()
  await claimTemplate(target, changed)
  await claimTemplate(target, changed)
  expect(state.localClaims).toHaveLength(2)
  await claimTemplate(target, changed, true)
  expect(state.localClaims).toEqual([{ templateId: 'local-art', claimant: other }])
  state.save = false
  await claimTemplate(target, changed)
  expect(state.localClaims).toHaveLength(1)
  expect(state.toast).toHaveBeenCalledWith('Could not save the local claim.', 'error')
})

it('does not send a claim mutation when the server reports read-only capability', async () => {
  const { server, item } = setup()
  state.request.mockResolvedValue({
    response: { status: 200 },
    body: { items: [], canClaim: false, canPlan: false },
  })
  const target = { server, key: item.id, name: item.title, nodeId: null, templateId: item.id }
  await claimTemplate(target, vi.fn())
  expect(state.request).toHaveBeenCalledOnce()
  expect(state.toast).toHaveBeenCalledWith(
    expect.stringContaining('report or admin token'),
    'warning',
  )
  const changed = vi.fn()
  workSectionModel(WORLD_TEMPLATE_SURFACE, changed)
  await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce())
  expect(canClaimTemplate(target)).toBe(false)
})

it('retries a failed list at the same revision only after an explicit retry', async () => {
  const { item, key } = setup()
  state.request.mockRejectedValueOnce(new Error('Temporarily offline'))
  const changed = vi.fn()
  workSectionModel(WORLD_TEMPLATE_SURFACE, changed)
  await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce())
  expect(workSectionModel(WORLD_TEMPLATE_SURFACE, changed).error).toContain('Temporarily offline')
  expect(state.request).toHaveBeenCalledOnce()
  state.request.mockResolvedValue({
    response: { status: 200 },
    body: { items: [item], canClaim: true, canPlan: false },
  })
  retryTemplateClaims(WORLD_TEMPLATE_SURFACE, changed)
  workSectionModel(WORLD_TEMPLATE_SURFACE, changed)
  await vi.waitFor(() =>
    expect(workSectionModel(WORLD_TEMPLATE_SURFACE, changed).templates.get(key)?.mine).toBe(true),
  )
  expect(state.request).toHaveBeenCalledTimes(2)
})

it('recovers a missing account independently of the work revision', async () => {
  const { item, key } = setup()
  const identity = state.identity
  state.identity = null
  state.request.mockResolvedValue({
    response: { status: 200 },
    body: { items: [item], canClaim: true, canPlan: false },
  })
  const changed = vi.fn()
  workSectionModel(WORLD_TEMPLATE_SURFACE, changed)
  await vi.waitFor(() => expect(changed).toHaveBeenCalled())
  expect(workSectionModel(WORLD_TEMPLATE_SURFACE, changed).templates.get(key)?.mine).toBe(false)
  state.loadAccount.mockImplementationOnce(async () => {
    state.identity = identity
  })
  workSectionModel(WORLD_TEMPLATE_SURFACE, changed)
  await vi.waitFor(() =>
    expect(workSectionModel(WORLD_TEMPLATE_SURFACE, changed).templates.get(key)?.mine).toBe(true),
  )
  expect(state.request).toHaveBeenCalledOnce()
})
