import { describe, expect, it } from 'vitest'
import { parseServerInfo, parseServerManifest, type ServerInfo } from './server-manifest.js'

const SERVER_ID = '019fed50-87a1-7523-a88c-bdeafad49681'
const NODE_ID = '019fed50-87a1-7523-a88c-bdeafad49682'
const TEMPLATE_ID = '019fed50-87a1-7523-a88c-bdeafad49683'
const VERSION_ID = '019fed50-87a1-7523-a88c-bdeafad49684'
const NOW = 1_800_000_000_000

const server: ServerInfo = {
  id: SERVER_ID,
  name: 'Caelestis',
  auth: 'access_token',
}

const manifest = {
  version: 'v1',
  season: 0,
  server,
  nodes: [
    {
      id: NODE_ID,
      parentId: null,
      path: '/templates',
      name: 'Templates',
      createdAt: NOW,
    },
  ],
  templates: [
    {
      id: TEMPLATE_ID,
      nodeId: NODE_ID,
      name: 'Archive',
      version: VERSION_ID,
      bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
      totalPixels: 1,
      chunks: [{ tile: '0/0', hash: 'a'.repeat(64) }],
      published: true,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ],
  tiles: ['0/0'],
}

describe('server manifest template lifecycle', () => {
  it('accepts only the explicit live-sync capability versions', () => {
    expect(parseServerInfo({ ...server, liveSync: 1, liveTileOffers: 1 })).toEqual({
      ...server,
      liveSync: 1,
      liveTileOffers: 1,
    })
    expect(parseServerInfo(server)).toEqual(server)
    expect(parseServerInfo({ ...server, liveSync: true })).toBeNull()
    expect(parseServerInfo({ ...server, liveSync: 1, liveSyncMax: 2 })).toEqual({
      ...server,
      liveSync: 1,
      liveSyncMax: 2,
    })
    expect(parseServerInfo({ ...server, liveSyncMax: 2 })).toBeNull()
    expect(parseServerInfo({ ...server, liveSync: 2, liveSyncMax: 1 })).toBeNull()
    expect(parseServerInfo({ ...server, liveSync: 3 })).toBeNull()
    expect(parseServerInfo({ ...server, liveTileOffers: true })).toBeNull()
    expect(parseServerInfo({ ...server, liveTileOffers: 2 })).toBeNull()
  })

  it('retains current lifecycle state from a fresh manifest', () => {
    const parsed = parseServerManifest(
      {
        ...manifest,
        templates: [
          {
            ...manifest.templates[0],
            finished: true,
            finishedAt: NOW,
            timelapseFrozen: true,
          },
        ],
      },
      server,
    )

    expect(parsed?.templates[0]).toMatchObject({
      finished: true,
      finishedAt: NOW,
      timelapseFrozen: true,
    })
  })

  it('defaults lifecycle state for an older server response', () => {
    expect(parseServerManifest(manifest, server)?.templates[0]).toMatchObject({
      finished: false,
      finishedAt: null,
      timelapseFrozen: false,
    })
  })

  it('rejects malformed lifecycle fields', () => {
    expect(
      parseServerManifest(
        {
          ...manifest,
          templates: [{ ...manifest.templates[0], finished: 'yes' }],
        },
        server,
      ),
    ).toBeNull()
  })
})

describe('server manifest drawing surfaces', () => {
  const hqSurface = { kind: 'alliance-headquarters' as const, allianceId: 535_245 }
  const hqManifest = {
    ...manifest,
    surface: hqSurface,
    templates: [
      {
        ...manifest.templates[0],
        bbox: { minX: -1, minY: -1, maxX: 1, maxY: 0 },
        totalPixels: 2,
        chunks: [
          { tile: '-1/-1', hash: 'a'.repeat(64) },
          { tile: '0/-1', hash: 'b'.repeat(64) },
        ],
      },
    ],
    tiles: ['-1/-1', '0/-1'],
  }

  it('accepts signed HQ chunks only for the expected alliance scope', () => {
    const parsed = parseServerManifest(hqManifest, server, hqSurface)

    expect(parsed?.surface).toEqual(hqSurface)
    expect(parsed?.templates[0]).toMatchObject({ surface: hqSurface })
    expect(parseServerManifest(hqManifest, server)).toBeNull()
    expect(
      parseServerManifest(hqManifest, server, {
        kind: 'alliance-headquarters',
        allianceId: 1,
      }),
    ).toBeNull()
  })

  it('keeps the omitted surface backward-compatible as world only', () => {
    expect(parseServerManifest(manifest, server)?.surface).toEqual({
      kind: 'world',
      allianceId: null,
    })
    expect(parseServerManifest(manifest, server, hqSurface)).toBeNull()
  })
})
