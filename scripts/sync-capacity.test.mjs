import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { projectSyncCapacity } from './sync-capacity.mjs'

test('five healthy clients retain a ninety-percent steady-state invocation reduction', () => {
  const report = projectSyncCapacity()

  assert.equal(report.scenario.clients, 5)
  assert.equal(report.baseline.avoidableWorkerRequests, 14_660)
  assert.equal(report.projected.avoidableWorkerRequests, 975)
  assert.ok(report.projected.reductionPercent >= 90)
  assert.equal(report.projected.maximumTileOfferBatchesForNinetyPercent, 491)
  assert.deepEqual(report.cache.outcomes, { miss: 2, stale: 192, hit: 776 })
  assert.equal(report.cache.projectionReads, 970)
  assert.equal(report.cache.authoritativeRebuilds, 194)
  assert.equal(report.durableObject.incomingHeartbeatMessages, 480)
  assert.equal(report.durableObject.projectedBillableRequestUnits, 999)
  assert.equal(report.durableObject.heartbeatWakeups, 0)
})

test('the target fails once tile offers consume more than the remaining budget', () => {
  assert.ok(
    projectSyncCapacity({ projectedTileOfferBatches: 491 }).projected.reductionPercent >= 90,
  )
  assert.ok(projectSyncCapacity({ projectedTileOfferBatches: 492 }).projected.reductionPercent < 90)
})

test('the Effect beta is exactly pinned for both runtime importers', async () => {
  const packages = await Promise.all(
    ['../apps/backend/package.json', '../packages/wire-schema/package.json'].map(async (relative) =>
      JSON.parse(await readFile(new URL(relative, import.meta.url), 'utf8')),
    ),
  )
  for (const manifest of packages) assert.equal(manifest.dependencies.effect, '4.0.0-beta.102')

  const lockfile = await readFile(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8')
  assert.match(lockfile, /effect@4\.0\.0-beta\.102:/)
})
