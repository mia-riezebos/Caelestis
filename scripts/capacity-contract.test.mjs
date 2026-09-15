import assert from 'node:assert/strict'
import { test } from 'node:test'
import { projectSyncCapacity } from './sync-capacity.mjs'

test('capacity counts telemetry as required traffic independently of avoidable HTTP reads', () => {
  const result = projectSyncCapacity({
    clients: 2,
    projectedPaintReports: 10,
    projectedTileOfferBatches: 5,
    projectedTileUploads: 3,
  })
  assert.equal(result.projected.avoidableWorkerRequests, 2)
  assert.equal(result.durableObject.incomingTelemetryMessages, 18)
  assert.equal(result.storage.mutationQueries, 18)
  assert.equal(result.durableObject.incomingHeartbeatMessages, 192)
  assert.equal(result.durableObject.billableIncomingMessageUnits, 11)
  assert.equal(result.durableObject.projectedBillableRequestUnits, 17)
  assert.equal(result.storage.initialProjectionSnapshots, 6)
  assert.equal(projectSyncCapacity({ clients: 0 }).projected.avoidableWorkerRequests, 0)
})
