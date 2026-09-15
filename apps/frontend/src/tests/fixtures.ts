import { type Manifest, millis, type ServerInfo, type Template } from '@caelestis/shared'

export const server: ServerInfo = {
  id: '01980000-0000-7000-8000-000000000001',
  name: 'Test world',
  auth: 'none',
}

export const template = (changes: Partial<Template> = {}): Template => ({
  id: '01980000-0000-7000-8000-000000000002',
  nodeId: null,
  name: 'Artwork',
  version: '01980000-0000-7000-8000-000000000003',
  bbox: { minX: 0, minY: 0, maxX: 2, maxY: 2 },
  totalPixels: 4,
  chunks: [{ tile: '0/0', hash: 'a'.repeat(64) }],
  published: true,
  finished: false,
  finishedAt: null,
  timelapseFrozen: false,
  createdAt: millis(1000),
  updatedAt: millis(1000),
  ...changes,
})

export const manifest = (changes: Partial<Manifest> = {}): Manifest => ({
  version: 'catalog-1',
  season: 1,
  server,
  nodes: [],
  templates: [template()],
  tiles: ['0/0'],
  ...changes,
})
