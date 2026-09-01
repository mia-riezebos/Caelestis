import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { projectSyncCapacity } from './sync-capacity.mjs'

test('five healthy clients retain a ninety-percent steady-state invocation reduction', () => {
  const report = projectSyncCapacity()

  assert.equal(report.scenario.clients, 5)
  assert.equal(report.baseline.avoidableWorkerRequests, 12_570)
  assert.equal(report.baseline.requiredTileOfferBatches, 2_075)
  assert.equal(report.projected.avoidableWorkerRequests, 400)
  assert.ok(report.projected.reductionPercent >= 90)
  assert.equal(report.projected.reductionPercent, 96.8178)
  assert.deepEqual(report.cache.outcomes, { miss: 2, stale: 48, hit: 200 })
  assert.equal(report.cache.projectionReads, 250)
  assert.equal(report.cache.authoritativeRebuilds, 50)
  assert.equal(report.durableObject.incomingHeartbeatMessages, 480)
  assert.equal(report.durableObject.projectedBillableRequestUnits, 283)
  assert.equal(report.durableObject.heartbeatWakeups, 0)
})

test('required tile offers do not consume the avoidable synchronization budget', () => {
  const report = projectSyncCapacity({ projectedTileOfferBatches: 100_000 })

  assert.equal(report.projected.requiredTileOfferBatches, 100_000)
  assert.equal(report.projected.avoidableWorkerRequests, 400)
  assert.equal(report.projected.reductionPercent, 96.8178)
})

test('data-dependent alarm reads remain avoidable synchronization work', () => {
  const report = projectSyncCapacity({ projectedExtraAlarmReads: 100 })
  assert.equal(report.projected.avoidableWorkerRequests, 500)
  assert.equal(report.projected.reductionPercent, 96.0223)
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
