import {
  createWorkClient,
  encodeIndexedPng,
  type PainterIdentity,
  sha256Hex,
  TRANSPARENT_INDEX,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { serverEndpoint } from '../src/server-url.js'
import { adminToken, backendFetch, createTestBackend, readToken, reportToken } from './backend.js'

const origin = 'https://userscript-telemetry-boundary.test'
const painter: PainterIdentity = { wplaceUserId: 42, displayName: 'Mia' }
const configuredServers = new Set<string>()

class IdleWebSocket {
  static readonly CLOSING = 2
  readyState = 0
  protocol = ''

  addEventListener(): void {}
  close(): void {
    this.readyState = 3
  }
}

interface WplaceTransport {
  tile: Uint8Array | null
  loseFirstPaintAcknowledgement: boolean
  readonly paintEventIds: string[]
  readonly paintReplies: unknown[]
}

const installBackend = async (wplace?: WplaceTransport) => {
  const { app } = await createTestBackend()
  const route = backendFetch(app, origin)
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.origin === 'https://backend.wplace.live') {
      if (url.pathname === '/me')
        return Response.json({
          id: painter.wplaceUserId,
          name: painter.displayName,
          extraColorsBitmap: 0,
        })
      if (url.pathname === '/paint') return Response.json({ painted: 1 })
      if (
        wplace !== undefined &&
        wplace.tile !== null &&
        /^\/files\/s3\/tiles\/0\/0\.png$/.test(url.pathname)
      )
        return new Response(new Uint8Array(wplace.tile).buffer, {
          headers: { 'content-type': 'image/png' },
        })
      return new Response(null, { status: 404 })
    }
    if (url.pathname.endsWith('/telemetry/paints')) {
      const body = (await request.clone().json()) as { eventId?: unknown }
      if (typeof body.eventId === 'string') wplace?.paintEventIds.push(body.eventId)
      const response = await route(request)
      wplace?.paintReplies.push(await response.clone().json())
      if (wplace?.loseFirstPaintAcknowledgement) {
        wplace.loseFirstPaintAcknowledgement = false
        throw new TypeError('paint acknowledgement was lost')
      }
      return response
    }
    return await route(request)
  })
  vi.stubGlobal('fetch', fetch)
  window.fetch = fetch
  return fetch
}

/** Keep page-world hooks off the test window, while preserving the browser constructors the tap reads. */
const pageRealm = (fetch: typeof globalThis.fetch): Window & typeof globalThis => {
  class Canvas {
    getContext(): null {
      return null
    }
  }
  const realm = Object.create(window)
  Object.defineProperties(realm, {
    fetch: { configurable: true, value: fetch, writable: true },
    HTMLCanvasElement: { configurable: true, value: Canvas, writable: true },
  })
  return realm as Window & typeof globalThis
}

const endpointRequest = (token: string) => async (path: string, init?: RequestInit) =>
  await fetch(serverEndpoint(origin, path), {
    ...init,
    headers: { ...init?.headers, authorization: `Bearer ${token}` },
  })

const artwork = async (): Promise<Blob> => {
  const bytes = await encodeIndexedPng(1, 1, new Uint8Array([1]))
  return new Blob([new Uint8Array(bytes).buffer], { type: 'image/png' })
}

afterEach(async () => {
  const state = await import('../src/state.js')
  for (const url of configuredServers) state.removeServer(url)
  configuredServers.clear()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.resetModules()
  localStorage.clear()
})

describe('userscript telemetry HTTP boundary', () => {
  it('persists work through the shared userscript client and preserves conflict and capability responses', async () => {
    await installBackend()
    const id = '018f4f2a-1234-7abc-8def-0123456789ab'
    const fields = {
      title: 'Fill the coast',
      description: 'Blue pixels',
      status: 'open' as const,
      priority: 'normal' as const,
      tags: ['coast'],
      blockerIds: [],
      nodeId: null,
      templateIds: [],
    }
    const client = createWorkClient(endpointRequest(adminToken), 3, WORLD_TEMPLATE_SURFACE)

    expect(await client.list()).toEqual({ items: [], canPlan: true, canClaim: true })
    expect(
      await client.mutate(id, { action: 'create', actor: painter, expectedRevision: 0, fields }),
    ).toMatchObject({ id, revision: 1, ...fields })
    expect(await client.list()).toMatchObject({
      items: [expect.objectContaining({ id, revision: 1, title: 'Fill the coast' })],
      canPlan: true,
      canClaim: true,
    })
    expect(await client.history(id)).toMatchObject([{ action: 'create', actor: painter }])

    await expect(
      client.mutate(id, { action: 'edit', actor: painter, expectedRevision: 0, fields }),
    ).rejects.toMatchObject({ status: 409 })

    const reader = createWorkClient(endpointRequest(readToken), 3, WORLD_TEMPLATE_SURFACE)
    expect(await reader.list()).toMatchObject({ canPlan: false, canClaim: false })
    await expect(
      reader.mutate(id, { action: 'claim', actor: painter, expectedRevision: 1 }),
    ).rejects.toMatchObject({ status: 403 })
  })

  it('writes, reads, refuses an unauthorized release, and removes a region through the presence HTTP client', async () => {
    await installBackend()
    vi.stubGlobal('WebSocket', IdleWebSocket)
    const state = await import('../src/state.js')
    const presence = await import('../src/presence-client.js')
    const probed = await state.probeServer(origin, reportToken)
    if (probed.info === null) throw new Error('test backend did not return server metadata')
    const server = { ...probed, info: { ...probed.info, presence: 1 as const } }
    state.upsertServer(server)
    configuredServers.add(origin)
    presence.installPresence()

    const id = '018f4f2a-1234-7abc-8def-0123456789ac'
    const request = {
      actor: painter,
      label: 'Harbour',
      document: {
        items: [
          {
            id: 'harbour',
            op: 'add' as const,
            shape: { kind: 'rectangle' as const, x: 4, y: 5, w: 3, h: 2 },
          },
        ],
      },
    }
    expect(await presence.claimRegion(server, id, request)).toBeNull()

    const regions = await endpointRequest(reportToken)(
      '/work/regions?season=3&surface=world&painterId=42',
    )
    expect(await regions.json()).toMatchObject({
      canWrite: true,
      ownedRegionIds: [id],
      regions: [
        expect.objectContaining({
          id,
          claimant: painter,
          label: 'Harbour',
          rect: { x: 4, y: 5, w: 3, h: 2 },
        }),
      ],
    })
    expect(
      await presence.releaseRegion(server, id, { wplaceUserId: 7, displayName: 'Other painter' }),
    ).toBe('forbidden')
    expect(await presence.releaseRegion(server, id, painter)).toBeNull()
    expect(
      await (await endpointRequest(reportToken)('/work/regions?season=3&surface=world')).json(),
    ).toEqual({ regions: [] })
  })

  it('accepts tile offers and uploads, makes paint retries idempotent, and refreshes populated status through the userscript', async () => {
    const wplace: WplaceTransport = {
      tile: null,
      loseFirstPaintAcknowledgement: false,
      paintEventIds: [],
      paintReplies: [],
    }
    const fetch = await installBackend(wplace)
    const state = await import('../src/state.js')
    const probed = await state.probeServer(origin, adminToken)
    if (probed.status !== 'connected') throw new Error('admin probe did not connect')
    state.upsertServer(probed)
    configuredServers.add(origin)
    state.setState({ shareTiles: true, reportPaints: true })
    vi.useFakeTimers()
    const server = state.getState().servers[0]
    if (server === undefined) throw new Error('probed server was not retained')

    const uploaded = await state.uploadTemplate(server, {
      nodeId: null,
      name: 'Telemetry pixel',
      originX: 0,
      originY: 0,
      png: await artwork(),
    })
    if (!uploaded.ok) throw new Error(uploaded.message)
    expect(await state.patchTemplate(server, uploaded.id, { published: true })).toEqual({
      ok: true,
    })

    const indices = new Uint8Array(1_000_000).fill(TRANSPARENT_INDEX)
    indices[0] = 1
    const canvas = await encodeIndexedPng(1_000, 1_000, indices)
    const hash = await sha256Hex(canvas)
    const sync = await import('../src/server-sync-coordinator.js')
    const telemetry = await import('../src/telemetry.js')
    const tileTransform = await import('../src/tile-transform.js')
    telemetry.installTelemetry()
    sync.installServerSyncCoordinator()
    const contents = await state.listServerContents(server)
    if (contents === null) throw new Error('published template did not appear in the manifest')
    state.admitServerContents(server, contents)
    wplace.tile = canvas
    const page = pageRealm(fetch)
    tileTransform.install(page)
    await (await page.fetch('https://backend.wplace.live/files/s3/tiles/0/0.png')).arrayBuffer()
    await vi.advanceTimersByTimeAsync(300)
    await vi.waitFor(() => {
      const calls = fetch.mock.calls.map(([input]) =>
        input instanceof Request ? input.url : String(input),
      )
      expect(calls).toEqual(
        expect.arrayContaining([
          expect.stringContaining('/backend/v1/telemetry/tiles/offers'),
          expect.stringContaining(`/backend/v1/telemetry/tiles/0/0/${hash}`),
        ]),
      )
    })

    wplace.loseFirstPaintAcknowledgement = true
    await page.fetch('https://backend.wplace.live/paint', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        season: 3,
        tiles: [{ x: 0, y: 0, pixels: { x: [0], y: [0], colors: [2] } }],
      }),
    })
    await vi.waitFor(() => {
      expect(wplace.paintEventIds).toHaveLength(2)
      expect(wplace.paintEventIds[1]).toBe(wplace.paintEventIds[0])
      expect(wplace.paintReplies).toEqual([
        expect.objectContaining({ accepted: true, partial: false }),
        { accepted: false, duplicate: true },
      ])
    })

    sync.requestServerSync('connect', 'telemetry-status', server)
    await vi.waitFor(() =>
      expect(telemetry.serverProgressFor(server, { id: uploaded.id, totalPixels: 1 })).toEqual({
        completed: 1,
        mismatched: 0,
        unpainted: 0,
        known: 1,
        total: 1,
      }),
    )
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/backend/v1/telemetry/status?season=3'),
      expect.any(Object),
    )
  })
})
