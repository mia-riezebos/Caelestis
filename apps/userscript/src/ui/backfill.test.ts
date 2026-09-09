// @vitest-environment happy-dom
import type { BackfillJob, BackfillPreview } from '@caelestis/shared'
import type { BackfillModel } from '@caelestis/ui/elements'
import { afterEach, expect, it, vi } from 'vitest'
import type { ConnectedServer } from '../state.js'

vi.mock('@caelestis/ui/elements', () => ({ BACKFILL_TAG: 'caelestis-backfill' }))
vi.mock('../state.js', () => ({
  activeServerToken: () => 'admin',
  hasServerAdminToken: () => true,
  isCurrentServerConnection: () => true,
  serverConnectionSignal: () => new AbortController().signal,
  serverEndpoint: (base: string, path: string) => `${base}/v1${path}`,
}))
vi.mock('../templates/local-store.js', () => ({
  templateById: () => undefined,
  templateAsPng: vi.fn(),
}))
vi.mock('../templates/server-sync.js', () => ({ serverTemplateKey: () => 'local-key' }))
vi.mock('./theme.js', () => ({ applyWplaceTheme: vi.fn() }))

import { openTemplateBackfill } from './backfill.js'

afterEach(() => {
  document
    .querySelector('caelestis-backfill')
    ?.dispatchEvent(new CustomEvent('caelestis-backfill-intent', { detail: { type: 'close' } }))
  vi.unstubAllGlobals()
})

it('sends the selected template version and snapshot, then cancels the durable job', async () => {
  const basis = {
    templateId: 'template',
    versionId: 'version',
    name: 'Art',
    season: 0,
    bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
    total: 1,
    chunks: [],
  }
  const preview: BackfillPreview = {
    basis,
    snapshots: [
      { id: 1, at: 100 },
      { id: 2, at: 200 },
    ],
    end: 200,
    tileCount: 1,
    job: null,
  }
  let job: BackfillJob | null = null
  const requests: { url: string; body: unknown }[] = []
  vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
    const body: unknown = init.body === undefined ? null : JSON.parse(String(init.body))
    requests.push({ url: input, body })
    if (input.endsWith('/preview')) return Response.json(preview)
    if (input.endsWith('/start'))
      job = {
        id: 'job',
        basis,
        from: 200,
        to: 200,
        status: 'running',
        completed: 0,
        total: 1,
        imported: 0,
        skipped: 0,
        failed: 0,
        error: null,
      }
    if (input.endsWith('/cancel') && job !== null) job = { ...job, status: 'cancelled' }
    return Response.json(job)
  })
  const server: ConnectedServer = {
    url: 'https://server.example',
    info: null,
    token: 'admin',
    isAdmin: true,
    status: 'connected',
    season: 0,
  }
  openTemplateBackfill({
    server,
    templateId: 'template',
    nodeId: null,
    key: 'server:template',
    name: 'Art',
  })
  const element = document.querySelector('caelestis-backfill') as HTMLElement & {
    model: BackfillModel
  }
  const send = (detail: object) =>
    element.dispatchEvent(new CustomEvent('caelestis-backfill-intent', { detail }))
  await vi.waitFor(() => expect(element.model.loading).toBe(false))
  send({ type: 'select', snapshotId: 2 })
  send({ type: 'start' })
  await vi.waitFor(() => expect(element.model.job?.status).toBe('running'))
  expect(requests.find((request) => request.url.endsWith('/start'))).toEqual({
    url: 'https://server.example/v1/admin/backfill/template/start',
    body: { versionId: 'version', snapshotId: 2 },
  })
  send({ type: 'cancel' })
  await vi.waitFor(() => expect(element.model.job?.status).toBe('cancelled'))
})
