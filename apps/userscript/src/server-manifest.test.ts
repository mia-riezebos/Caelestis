import { describe, expect, it } from 'vitest'
import { parseServerManifest, type ServerInfo } from './server-manifest.js'

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
