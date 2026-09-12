import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { D1SqlStore } from '../apps/backend/dist/adapters/cloudflare/d1-sql-store.js'
import {
  encodeIndexedPng,
  encodeLivePaintParts,
  millis,
  seconds,
  sha256Hex,
  uuidV7,
  WORLD_TEMPLATE_SURFACE,
} from '../packages/shared/dist/index.js'

// Exercise the runtime shipped with our installed Wrangler, using only ephemeral local bindings.
const backendRequire = createRequire(new URL('../apps/backend/package.json', import.meta.url))
const wranglerRequire = createRequire(backendRequire.resolve('wrangler/package.json'))
const { Miniflare } = wranglerRequire('miniflare')
const { build } = createRequire(new URL('../apps/userscript/package.json', import.meta.url))(
  'esbuild',
)

test('100k paint pixels survive live framing and acknowledgement replay in workerd', {
  timeout: 120_000,
}, async (t) => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../apps/backend/src/worker.ts', import.meta.url))],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    external: ['cloudflare:*', 'node:*'],
  })
  const token = 'local-paint-diagnostic-only'
  const mf = new Miniflare({
    name: 'paint-runtime-test',
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-08-03',
    compatibilityFlags: ['nodejs_compat'],
    inspectorPort: 0,
    d1Databases: ['DB'],
    r2Buckets: ['BLOBS'],
    d1Persist: false,
    r2Persist: false,
    durableObjectsPersist: false,
    durableObjects: Object.fromEntries(
      [
        ['STATUS_READ_MODEL', 'StatusReadModelObject'],
        ['TELEMETRY', 'TelemetryShard'],
        ['ALARM_WATCHER', 'AlarmWatcher'],
        ['TEMPLATE_BACKFILL', 'TemplateBackfillObject'],
      ].map(([binding, className]) => [binding, { className, useSQLite: true }]),
    ),
    bindings: {
      ADMIN_TOKEN: token,
      SERVER_ID: uuidV7(),
      SERVER_NAME: 'Paint runtime test',
      SEASON: '0',
      SHARD_STRATEGY: 'single',
      OPEN_ACCESS: 'false',
    },
    outboundService: () => {
      throw new Error('Runtime test must not access external services')
    },
  })
  t.after(() => mf.dispose())
  await mf.ready
  const database = await mf.getD1Database('DB')
  const migrationRoot = new URL('../apps/backend/migrations/', import.meta.url)
  for (const file of (await readdir(migrationRoot))
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    const source = (await readFile(new URL(file, migrationRoot), 'utf8')).replaceAll(
      '--> statement-breakpoint',
      '',
    )
    for (const statement of source
      .split(';')
      .map((sql) => sql.trim())
      .filter(Boolean))
      await database.prepare(statement).run()
  }
  const sql = new D1SqlStore(database)
  const blobs = await mf.getR2Bucket('BLOBS')
  const chunk = await encodeIndexedPng(500, 100, new Uint8Array(50000).fill(30))
  const hash = await sha256Hex(chunk)
  await blobs.put(`chunks/${hash}`, chunk)
  const at = Date.now()
  for (const x of [0, 1]) {
    const templateId = uuidV7()
    await sql.insertTemplateVersion({
      templateId,
      versionId: uuidV7(),
      surface: WORLD_TEMPLATE_SURFACE,
      season: 0,
      nodeId: null,
      name: `Paint ${x}`,
      createdWithToken: 'a'.repeat(64),
      createdByUserId: null,
      createdAt: millis(at),
      bbox: { minX: x * 1000 + 100, minY: 100, maxX: x * 1000 + 600, maxY: 200 },
      totalPixels: 50000,
      chunks: [{ tileX: x, tileY: 0, hash }],
    })
    await sql.setTemplatePublishedAt(templateId, millis(at), millis(at))
  }
  const infoResponse = await mf.dispatchFetch('https://local.test/v1/server')
  const infoText = await infoResponse.text()
  assert.equal(infoResponse.status, 200, infoText)
  const info = JSON.parse(infoText)
  assert.equal(info.livePaintParts, 1)
  const response = await mf.dispatchFetch(
    'https://local.test/v1/telemetry/live?season=0&scope=admin&stateVector=1',
    {
      headers: {
        upgrade: 'websocket',
        'sec-websocket-protocol': `caelestis.live.v2, caelestis.auth.b64.${Buffer.from(token).toString('base64url')}`,
      },
    },
  )
  assert.equal(response.status, 101)
  const socket = response.webSocket
  assert.ok(socket)
  socket.accept()
  t.after(() => socket.close())
  const pending = new Map()
  socket.addEventListener('message', ({ data }) => {
    const reply = JSON.parse(data)
    pending.get(reply.requestId)?.(reply)
  })
  const command = (message) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(message.requestId)
        reject(new Error(`No reply to ${message.type}`))
      }, 10000)
      pending.set(message.requestId, (reply) => {
        clearTimeout(timer)
        pending.delete(message.requestId)
        resolve(reply)
      })
      socket.send(JSON.stringify(message))
    })
  await command({ type: 'state-vector', requestId: uuidV7(), revision: null, projections: [] })
  const inspectorURL = await mf.getInspectorURL()
  inspectorURL.protocol = 'http:'
  const targets = await (await fetch(new URL('/json', inspectorURL))).json()
  const inspector = new WebSocket(targets[0].webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    inspector.addEventListener('open', resolve, { once: true })
    inspector.addEventListener('error', reject, { once: true })
  })
  t.after(() => inspector.close())
  const probes = new Map()
  let probeId = 0
  inspector.addEventListener('message', ({ data }) => {
    const reply = JSON.parse(data)
    probes.get(reply.id)?.(reply)
  })
  const heapUsage = () =>
    new Promise((resolve, reject) => {
      const id = ++probeId
      probes.set(id, (reply) => {
        probes.delete(id)
        if (reply.error) reject(new Error(JSON.stringify(reply.error)))
        else resolve(reply.result.usedSize)
      })
      inspector.send(JSON.stringify({ id, method: 'Runtime.getHeapUsage' }))
    })
  const heapBefore = await heapUsage()
  let maxSampledHeap = heapBefore
  const event = {
    eventId: uuidV7(),
    wplaceUserId: 2714778,
    displayName: '4dragonwings',
    season: 0,
    ts: seconds(Math.floor(at / 1000)),
    painted: 100000,
    tiles: [0, 1].map((x) => ({
      x,
      y: 0,
      pixels: {
        x: Array.from({ length: 50000 }, (_, i) => 100 + (i % 500)),
        y: Array.from({ length: 50000 }, (_, i) => 100 + Math.floor(i / 500)),
        colors: Array.from({ length: 50000 }, () => 31),
      },
    })),
  }
  const started = performance.now()
  let frameCount = 0
  for (const expected of ['recorded', 'duplicate']) {
    for (const part of encodeLivePaintParts(event, uuidV7())) {
      const reply = await command({ type: 'paint-part', requestId: uuidV7(), ...part })
      frameCount++
      maxSampledHeap = Math.max(maxSampledHeap, await heapUsage())
      if (part.index === part.total - 1) {
        assert.equal(reply.type, 'paint-result')
        assert.equal(reply.result, expected)
        assert.equal(reply.error, undefined)
      } else assert.equal(reply.type, 'paint-part-result')
    }
  }
  const elapsedMs = performance.now() - started
  const contributions = await sql.readContributions({ season: 0, includeUnpublished: false })
  assert.deepEqual(
    contributions.map(({ placed }) => placed),
    [50000, 50000],
  )
  const pendingCounters = await (await mf.getBindings()).TELEMETRY.getByName(
    'telemetry',
  ).readPending(contributions.map(({ templateId }) => templateId))
  assert.equal(
    pendingCounters.reduce((sum, row) => sum + row.placed, 0),
    100000,
  )
  t.diagnostic(
    JSON.stringify({
      pixels: event.painted,
      transfers: 2,
      frameCount,
      elapsedMs: Math.round(elapsedMs),
      heapBefore,
      maxSampledHeap,
    }),
  )
})
