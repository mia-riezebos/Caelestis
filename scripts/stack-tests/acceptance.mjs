import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

// encodeIndexedPng(3, 1, [0, 1, 2]), using the application's palette.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAMAAAABCAMAAAAsPuSGAAAAwFBMVEUAAAA8PDx4eHjS0tL///9gABjtHCT/fyf2qgn53Tv/+rwOuWgT5nuH/14MgW4QrqYT4b4oUJ5Ak+Rg9/JrUPaZsft4DJmqOLngn/nLAHrsH4DzjaloRjSVaCr4sneqqqqlDh76gHLkXBrWtZSchDHFrTHo1F9KazpalEqExXMPeZ+7+vJ9x/9NMbhKQoR6ccS1rvHbpGPRgFH/xaWbUknRgHj6tqR7Y1KchGszOUFtdY2zudFtZD+UjGvNxZ4AAADnmKmoAAAAQHRSTlP///////////////////////////////////////////////////////////////////////////////////8AwnuxRAAAAAxJREFUeJxjYGBkAgAACAAENuCwpgAAAABJRU5ErkJggg==',
  'base64',
)
const uuid = () => randomUUID().replace(/^(.{14})./, '$17')

/** Wait for deployment readiness, never retry failed acceptance assertions. */
export async function waitFor(check, label, timeout = 120_000) {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    try {
      if (await check()) return
    } catch (error) {
      last = error
    }
    await delay(1000)
  }
  throw new Error(`Timed out waiting for ${label}`, { cause: last })
}

/** Exercise public HTTP and WebSockets; deployment drivers only manage lifecycle. */
export function acceptance({ site, api = `${site}/backend/v1`, adminToken, readToken }) {
  const request = async (path, { token = adminToken, ...init } = {}) =>
    fetch(`${api}${path}`, {
      ...init,
      signal: AbortSignal.timeout(30_000),
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers },
    })
  const json = async (path, init, status = 200) => {
    const response = await request(path, init)
    const body = await response.text()
    assert.equal(response.status, status, `${path}: ${body}`)
    return JSON.parse(body)
  }
  const patch = (id, body) =>
    json(`/admin/templates/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  const connect = async (token) => {
    const url = new URL(token ? `${api}/telemetry/live` : `${site}/api/v1/telemetry/live`)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.search = '?season=0&scope=public&stateVector=1'
    const protocols = ['caelestis.live.v2']
    if (token) protocols.push(`caelestis.auth.b64.${Buffer.from(token).toString('base64url')}`)
    const socket = new WebSocket(url, protocols)
    const messages = []
    let failed
    socket.addEventListener('message', ({ data }) => {
      if (data !== 'pong') messages.push(JSON.parse(data))
    })
    socket.addEventListener('error', () => {
      failed = new Error(`WebSocket failed: ${url}`)
    })
    try {
      await waitFor(
        () => {
          if (failed) throw failed
          return socket.readyState === WebSocket.OPEN
        },
        'WebSocket open',
        15_000,
      )
    } catch (error) {
      socket.close()
      throw error
    }
    return {
      send: (message) => socket.send(JSON.stringify(message)),
      async next(type, requestId) {
        let index
        await waitFor(
          () => {
            if (failed || socket.readyState === WebSocket.CLOSED)
              throw failed ?? new Error('WebSocket closed')
            index = messages.findIndex(
              (m) => m.type === type && (!requestId || m.requestId === requestId),
            )
            return index >= 0
          },
          `WebSocket ${type}`,
          20_000,
        )
        return messages.splice(index, 1)[0]
      },
      close: () => socket.close(),
    }
  }
  const report = async (state, expected) => {
    const socket = await connect(state.reportToken)
    try {
      const requestId = uuid()
      socket.send({ type: 'paint-report', requestId, event: state.event })
      const result = await socket.next('paint-result', requestId)
      assert.equal(result.error, undefined)
      assert.equal(result.result, expected)
    } finally {
      socket.close()
    }
  }
  return {
    async seed() {
      assert.equal((await request('/manifest', { token: null })).status, 401)
      assert.equal((await request('/admin/tokens', { token: readToken })).status, 403)
      const tokenResponse = await json(
        '/admin/tokens',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ label: 'stack acceptance', scope: 'report' }),
        },
        201,
      )
      const form = new FormData()
      form.set('png', new File([png], 'stack.png', { type: 'image/png' }))
      for (const [key, value] of Object.entries({
        season: '0',
        name: 'Stack acceptance',
        originX: '0',
        originY: '0',
      }))
        form.set(key, value)
      const template = await json('/admin/templates', { method: 'POST', body: form }, 201)
      await patch(template.templateId, { name: 'Stack acceptance updated', published: true })
      assert.equal(template.chunks.length, 1)
      const chunk = await request(`/chunks/${template.chunks[0].hash}`)
      assert.equal(chunk.status, 200)
      assert.equal(chunk.headers.get('content-type'), 'image/png')
      const bytes = Buffer.from(await chunk.arrayBuffer())
      assert.equal(createHash('sha256').update(bytes).digest('hex'), template.chunks[0].hash)
      const manifest = await json('/manifest')
      const state = {
        serverId: manifest.server.id,
        templateId: template.templateId,
        chunkHash: template.chunks[0].hash,
        chunkBytes: bytes.toString('base64'),
        reportToken: tokenResponse.token,
        tokenHash: tokenResponse.tokenHash,
        event: {
          eventId: uuid(),
          wplaceUserId: 42,
          displayName: 'Stack test',
          season: 0,
          ts: Math.floor(Date.now() / 1000),
          painted: 1,
          tiles: [{ x: 0, y: 0, pixels: { x: [0], y: [0], colors: [1] } }],
        },
      }
      // A real tile observation gives the live projection progress to reconcile.
      const canvas = readFileSync(new URL('./canvas.png', import.meta.url))
      const hash = createHash('sha256').update(canvas).digest('hex')
      await json(`/telemetry/tiles/0/0/${hash}`, {
        method: 'PUT',
        token: state.reportToken,
        body: canvas,
        headers: {
          'x-caelestis-season': '0',
          'x-caelestis-observed-at': String(state.event.ts),
          'x-caelestis-wplace-user-id': '42',
          'x-caelestis-display-name': 'Stack test',
        },
      })
      await report(state, 'recorded')
      await report(state, 'duplicate')
      return state
    },
    async verify(state) {
      const response = await fetch(`${site}/api/v1/manifest`, {
        signal: AbortSignal.timeout(30_000),
      })
      assert.equal(response.status, 200)
      const manifest = await response.json()
      assert.equal(manifest.server.id, state.serverId)
      assert.equal(
        manifest.templates.find((t) => t.id === state.templateId)?.name,
        'Stack acceptance updated',
      )
      const page = await fetch(site, { signal: AbortSignal.timeout(30_000) })
      assert.equal(page.status, 200)
      const html = await page.text()
      assert.ok(html.includes(state.serverId), 'SSR must contain the stored server identity')
      for (const token of [adminToken, readToken, state.reportToken])
        assert.ok(!html.includes(token))
      const chunk = await request(`/chunks/${state.chunkHash}`, { token: readToken })
      assert.equal(chunk.status, 200)
      assert.equal(Buffer.from(await chunk.arrayBuffer()).toString('base64'), state.chunkBytes)
      await report(state, 'duplicate')
      const totals = await json(
        `/telemetry/painters?templateIds=${state.templateId}&from=${state.event.ts - 120}&to=${state.event.ts + 120}`,
      )
      assert.equal(totals.painters.find((p) => p.wplaceUserId === 42)?.placed, 1)
      const socket = await connect()
      try {
        socket.send({ type: 'state-vector', requestId: uuid(), revision: null, projections: [] })
        const snapshot = await socket.next('status-snapshot')
        assert.ok(
          snapshot.status.templates.some((t) => t.templateId === state.templateId),
          JSON.stringify(snapshot),
        )
        const requestId = uuid()
        socket.send({ type: 'paint-report', requestId, event: { ...state.event, eventId: uuid() } })
        assert.equal((await socket.next('paint-result', requestId)).error, 'forbidden')
      } finally {
        socket.close()
      }
    },
    async remove(state) {
      const before = await json('/manifest')
      const template = before.templates.find((t) => t.id === state.templateId)
      const query = new URLSearchParams({
        expectedVersion: template.version,
        expectedUpdatedAt: String(template.updatedAt),
      })
      assert.equal(
        (await request(`/admin/templates/${state.templateId}?${query}`, { method: 'DELETE' }))
          .status,
        204,
      )
      const manifest = await json('/manifest')
      assert.ok(!manifest.templates.some((t) => t.id === state.templateId))
      // Template chunks are shared content-addressed objects; deletion intentionally retains them.
      assert.equal((await request(`/chunks/${state.chunkHash}`)).status, 200)
      assert.equal(
        (await request(`/admin/tokens/${state.tokenHash}`, { method: 'DELETE' })).status,
        204,
      )
      assert.equal((await request('/manifest', { token: state.reportToken })).status, 401)
    },
  }
}
