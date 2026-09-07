// @vitest-environment happy-dom
import { WORLD_TEMPLATE_SURFACE, type WorkItem } from '@caelestis/shared'
import { flushSync, mount, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ getServer: vi.fn(), requestWork: vi.fn() }))
vi.mock('$lib/api/client', async (original) => ({
  ...(await original<typeof import('$lib/api/client')>()),
  ...api,
}))
vi.mock('$lib/state/app.svelte', async (original) => ({
  ...(await original<typeof import('$lib/state/app.svelte')>()),
  useApp: () => app,
}))

import { AppState } from '$lib/state/app.svelte'
import WorkSection from './WorkSection.svelte'

const server = {
  id: '01900000-0000-7000-8000-000000000001',
  name: 'Old server',
  auth: 'none' as const,
}
const manifest = { version: 'a'.repeat(64), season: 0, server, nodes: [], templates: [], tiles: [] }
const item: WorkItem = {
  id: '01900000-0000-7000-8000-000000000002',
  season: 0,
  surface: WORLD_TEMPLATE_SURFACE,
  title: 'Old server work',
  description: '',
  status: 'open',
  priority: 'normal',
  tags: [],
  blockerIds: [],
  nodeId: null,
  templateIds: [],
  claimant: null,
  revision: 1,
  createdAt: 0,
  updatedAt: 0,
}
let app: AppState
let mounted: ReturnType<typeof mount> | null = null

beforeEach(() => {
  app = new AppState({
    server,
    manifest,
    statuses: [],
    statusRevision: null,
    alarms: [],
    alarmsVersion: null,
    canvas: [],
    needsRecovery: false,
    error: null,
  })
  api.getServer.mockReset()
  api.requestWork.mockReset().mockImplementation(async () =>
    Response.json({
      items: [item],
      nextCursor: null,
      canClaim: true,
      canPlan: false,
    }),
  )
})
afterEach(async () => {
  if (mounted !== null) await unmount(mounted)
  mounted = null
  document.body.replaceChildren()
})
const open = async () => {
  mounted = mount(WorkSection, { target: document.body })
  flushSync()
  await vi.waitFor(() => expect(document.body.textContent).toContain(item.title))
}

describe('work connection admission', () => {
  it('removes previous work and capabilities when a connection attempt starts or fails', async () => {
    await open()
    let reject: (error: Error) => void = () => undefined
    api.getServer.mockImplementation(
      () =>
        new Promise((_, fail) => {
          reject = fail
        }),
    )
    api.requestWork.mockRejectedValue(new Error('New connection unavailable'))
    const loading = app.load()
    flushSync()
    expect(document.body.textContent).not.toContain(item.title)
    expect(document.querySelector('[aria-label="Work items"]')).toBeNull()
    reject(new Error('New connection unavailable'))
    await loading
    flushSync()
    expect(app.server).toEqual(server)
    expect(app.manifest).toBeNull()
    expect(document.querySelector('[aria-label="Work items"]')).toBeNull()
  })

  it('retains useful work after a transient refresh failure on the admitted connection', async () => {
    await open()
    api.requestWork.mockRejectedValue(new Error('Temporary work error'))
    app.manifest = { ...manifest, version: 'b'.repeat(64) }
    flushSync()
    await vi.waitFor(() =>
      expect(document.querySelector('[role=alert]')?.textContent).toContain('Temporary work error'),
    )
    expect(document.body.textContent).toContain(item.title)
  })
})
