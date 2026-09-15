import {
  decodeMismatchMask,
  encodeIndexedPng,
  millis,
  mismatchClassAt,
  seconds,
  sha256Hex,
  TRANSPARENT_INDEX,
} from '@caelestis/shared'
import { expect, it } from 'vitest'
import { createBackendRuntime, makeBackendContext } from '../src/runtime/backend-runtime.js'
import { evaluateAlarmSnapshot } from '../src/telemetry/alarm-policy.js'
import { readMismatchMask, uploadTile } from '../src/telemetry/ingest.js'
import { authorized, createTestBackend } from './support/backend.js'

it('classifies uploaded canvas bytes against persisted artwork and exposes the same mismatch mask', async () => {
  const { app, sql, blobs, counters } = await createTestBackend()
  const artwork = await encodeIndexedPng(4, 1, new Uint8Array([1, 1, 1, TRANSPARENT_INDEX]))
  const form = new FormData()
  form.set('png', new File([artwork], 'art.png', { type: 'image/png' }))
  form.set('name', 'Classification')
  form.set('season', '3')
  form.set('originX', '10')
  form.set('originY', '20')
  const response = await app.fetch(authorized('/admin/templates', { method: 'POST', body: form }))
  expect(response.status).toBe(201)
  const created = (await response.json()) as { templateId: string; versionId: string }
  const indices = new Uint8Array(1000000).fill(TRANSPARENT_INDEX)
  indices.set([1, 2, TRANSPARENT_INDEX, 3], 20010)
  const canvas = await encodeIndexedPng(1000, 1000, indices)
  const runtime = createBackendRuntime(makeBackendContext(blobs, sql, counters))
  const metadata = {
    season: 3,
    tile: { x: 0, y: 0 },
    hash: await sha256Hex(canvas),
    observedAt: seconds(Math.floor(Date.now() / 1000)),
    includeUnpublished: true,
    tokenHash: 'a'.repeat(64),
    wplaceUserId: 42,
    displayName: 'Painter',
  }
  await runtime.run(uploadTile(metadata, canvas))
  expect(await sql.readTemplateStatuses(3, true)).toMatchObject([
    { templateId: created.templateId, total: 3, correct: 1, wrong: 1, blank: 1 },
  ])
  const result = await runtime.run(
    readMismatchMask({
      season: 3,
      templateId: created.templateId,
      versionId: created.versionId,
      tile: metadata.tile,
      includeUnpublished: true,
    }),
  )
  expect(result.kind).toBe('found')
  if (result.kind !== 'found') throw new Error('Expected classification mask')
  const mask = decodeMismatchMask(result.bytes)
  if (mask === null) throw new Error('Expected valid mismatch mask')
  expect([10, 11, 12].map((x) => mismatchClassAt(mask, x, 20))).toEqual([0, 1, 2])
  await expect(
    runtime.run(uploadTile({ ...metadata, hash: '0'.repeat(64) }, canvas)),
  ).rejects.toThrow()
  expect(await sql.readTemplateStatuses(3, true)).toMatchObject([
    { total: 3, correct: 1, wrong: 1, blank: 1 },
  ])
})

it('keeps a regression open through partial recovery and ignores follow-ups from an old episode', () => {
  const snapshot = {
    templateId: 'template',
    versionId: 'version',
    total: 10,
    correct: 7,
    observedAt: millis(1000),
  }
  const opened = evaluateAlarmSnapshot(
    null,
    snapshot,
    { kind: 'observation', previousCorrect: 10 },
    () => 'episode',
  )
  expect(opened).toMatchObject({
    scheduleFollowUp: true,
    state: { peakCorrect: 10, alarm: { id: 'episode', pixelsLost: 3, kind: 'regression' } },
  })
  const partial = evaluateAlarmSnapshot(
    opened.state,
    { ...snapshot, correct: 9 },
    { kind: 'scan' },
    () => 'unused',
  )
  expect(partial.state.alarm).toMatchObject({ id: 'episode', pixelsLost: 1 })
  const stale = evaluateAlarmSnapshot(
    partial.state,
    { ...snapshot, correct: 0 },
    { kind: 'follow-up', alarmId: 'old', pixelsLost: 1, dueAt: millis(1000) },
    () => 'unused',
  )
  expect(stale.state).toEqual(partial.state)
  const recovered = evaluateAlarmSnapshot(
    partial.state,
    { ...snapshot, correct: 10 },
    { kind: 'scan' },
    () => 'unused',
  )
  expect(recovered.state.alarm).toBeNull()
})
